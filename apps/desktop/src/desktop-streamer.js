"use strict";

/**
 * Desktop render backend — the Electron-native equivalent of the
 * Docker streamer's stream.js.
 *
 *   Offscreen BrowserWindow (GPU-accelerated, fixed frame rate)
 *        │  webContents 'paint' → NativeImage.toJPEG()
 *        ▼  write MJPEG into ffmpeg.stdin
 *   FFmpeg (image2pipe → libx264/HW → AAC → FLV → RTMP) → Twitch
 *
 * It exposes the SAME public surface as the Docker `Streamer`
 * (status/start/stop/restart/setScene/setOverlays/playVod/stopVod/
 * setIngest) so the shared HTTP control API (vendored api.js) and
 * the web panel's streamer-client.ts drive it unchanged.
 *
 * Two differences from the Docker pipeline:
 *   - Capture is Electron offscreen rendering instead of Chromium
 *     CDP screencast. Electron renders on the GPU and `setFrameRate`
 *     gives a guaranteed cadence — this is what fixes the Pi's
 *     "~3 fps" problem natively, no flags required.
 *   - Audio is a single loopback-TCP input fed by the AudioRelay
 *     (which provides the always-on silent carrier), so there's no
 *     amix / dual-FIFO graph.
 */

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { BrowserWindow } = require("electron");
const { buildVideoCodecArgs, buildVideoFilters } = require("./streamer/ffmpeg");
const { BandwidthMonitor } = require("./bandwidth");

const OVERLAY_CONTAINER_ID = "__cachestream_overlays__";

// Injected into the scene page to render overlays as real DOM —
// identical behaviour to the Docker streamer's _reapplyOverlays.
function overlayInjector(containerId, overlays) {
  const existing = document.getElementById(containerId);
  if (existing) existing.remove();
  if (!overlays.length) return;
  const container = document.createElement("div");
  container.id = containerId;
  Object.assign(container.style, {
    position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483647",
  });
  for (const o of overlays) {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      top: (o.top ?? "auto"), left: (o.left ?? "auto"),
      right: (o.right ?? "auto"), bottom: (o.bottom ?? "auto"),
      padding: "0.5rem 1rem",
      font: o.font || "600 24px Segoe UI, system-ui, sans-serif",
      color: o.color || "#e6f7ff",
      textShadow: o.glow !== false
        ? "0 0 6px rgba(0,240,255,.7), 0 0 18px rgba(138,43,255,.4)" : "none",
      background: o.background || "rgba(10,13,24,.55)",
      border: o.border || "1px solid rgba(0,240,255,.25)",
      borderRadius: o.radius || "4px",
      backdropFilter: "blur(2px)",
      opacity: String(o.opacity ?? 1),
    });
    if (o.type === "image" && o.src) {
      const img = document.createElement("img");
      img.src = o.src; img.style.display = "block";
      img.style.maxWidth = o.width || "auto";
      img.style.maxHeight = o.height || "auto";
      el.appendChild(img);
    } else if ((o.type === "chat" || o.type === "alert" || o.type === "nowplaying") && o.src) {
      const iframe = document.createElement("iframe");
      iframe.src = o.src; iframe.style.border = "0";
      iframe.style.width = o.width || "420px";
      iframe.style.height = o.height || "320px";
      iframe.style.background = "transparent";
      iframe.allow = "autoplay";
      el.appendChild(iframe);
      el.style.background = "transparent"; el.style.border = "0"; el.style.padding = "0";
    } else if (o.type === "html" && o.html) {
      el.innerHTML = o.html;
    } else {
      el.textContent = o.text || "";
    }
    container.appendChild(el);
  }
  document.body.appendChild(container);
}

class DesktopStreamer extends EventEmitter {
  constructor({ config, logger, ffmpegPath, relayOutPort, rtmpPort }) {
    super();
    this.config = config;
    this.logger = logger;
    this.ffmpegPath = ffmpegPath || "ffmpeg";
    this.relayOutPort = relayOutPort;
    this.rtmpPort = rtmpPort;
    // Multistream per-target relay processes (id -> { proc, label, state }).
    this.relays = new Map();

    // Upload bandwidth monitor + multistream auto-protect. Watches the
    // real house uplink and caps how many outputs fan out so we never
    // oversubscribe the link (which would drop frames for every viewer).
    this.bandwidth = new BandwidthMonitor({
      logger: logger?.child ? logger.child({ module: "bandwidth" }) : logger,
      perStreamMbps: () => {
        const v = Number(this.config.video?.bitrateKbps) || 0;
        const a = Number(this.config.audio?.bitrateKbps) || 0;
        return (v + a) / 1000;
      },
      enabledCount: () => this._enabledTargets().length,
    });
    // A bandwidth change can raise/lower the cap → re-sync relays so
    // throttled outputs come back (or get held) without a restart.
    this.bandwidth.on("change", () => {
      if (this.state === "running" && this._relayMode()) this._syncRelays();
      this.emit("status", this.status());
    });
    this.bandwidth.start();

    this.state = "idle";
    this.error = null;
    this.startedAt = null;
    this.frameCount = 0;
    this.framesDropped = 0;
    this.lastFrameAt = null;
    this.ingestAccepted = false;

    this.sceneUrl = config.scene.defaultUrl;
    this.overlays = [];

    this.win = null;
    this.ffmpeg = null;

    this.shouldRun = false;
    this.reconnectBackoffMs = 1000;
    this.reconnecting = false;
    this.restartTimer = null;
    this.watchdogTimer = null;
    this.recycleTimer = null;
    this.keepaliveTimer = null;

    this.vod = null;
    this.vodFfmpeg = null;
    this.vodStartedAt = null;
  }

  // ---- Public API (mirrors Docker Streamer) ---------------------

  status() {
    const mem = process.memoryUsage();
    return {
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      sceneUrl: this.sceneUrl,
      overlays: this.overlays,
      frameCount: this.frameCount,
      framesDropped: this.framesDropped,
      lastFrameAt: this.lastFrameAt,
      memory: {
        rssMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
        externalMB: Math.round(mem.external / 1048576),
      },
      stdinBufferedKB: this.ffmpeg?.stdin?.writableLength
        ? Math.round(this.ffmpeg.stdin.writableLength / 1024) : 0,
      vod: this.vod
        ? { id: this.vod.id, name: this.vod.name, kind: this.vod.kind,
            startedAt: this.vodStartedAt, loop: !!this.vod.loop }
        : null,
      twitch: {
        ingestUrl: this.config.twitch.ingestUrl,
        keyConfigured: Boolean(this.config.twitch.streamKey),
      },
      multistream: this._relayStatus(),
      bandwidth: this.bandwidth.status(),
      video: this.config.video,
      autoProfile: this.config.runtime?.autoProfile || null,
      thermal: this.thermal ? this.thermal.status() : null,
      ingestAccepted: this.ingestAccepted,
    };
  }

  async start() {
    if (!this.config.twitch.streamKey) {
      this.error = "TWITCH_STREAM_KEY is not set";
      this._setState("idle");
      throw new Error(this.error);
    }
    if (this.state === "running" || this.state === "starting") return;
    this.shouldRun = true;
    this.error = null;
    this._setState("starting");
    try {
      await this._runOnce();
      this.reconnectBackoffMs = 1000;
      this.startedAt = Date.now();
      this._setState("running");
    } catch (err) {
      this.logger.error({ err }, "start failed");
      this.error = err.message;
      this._setState("idle");
      this._scheduleReconnect();
      throw err;
    }
  }

  async stop() {
    this.shouldRun = false;
    this._setState("stopping");
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    await this._teardown();
    this.startedAt = null;
    this._setState("idle");
  }

  async restart() { await this.stop(); await this.start(); }

  async setScene(url) {
    if (!url || typeof url !== "string") throw new Error("scene url required");
    this.sceneUrl = url;
    if (this.win && this.state === "running") {
      this.logger.info({ url }, "switching scene");
      await this.win.webContents.loadURL(url);
      await this._reapplyOverlays();
    }
  }

  async setOverlays(overlays) {
    if (!Array.isArray(overlays)) throw new Error("overlays must be an array");
    this.overlays = overlays;
    if (this.win && this.state === "running") await this._reapplyOverlays();
  }

  async setIngest(input) {
    const patch = input || {};
    const newKey = patch.streamKey === undefined
      ? this.config.twitch.streamKey : (patch.streamKey ?? "");
    const newUrl = patch.ingestUrl === undefined
      ? this.config.twitch.ingestUrl : (patch.ingestUrl ?? "rtmp://live.twitch.tv/app");
    const changed = newKey !== this.config.twitch.streamKey || newUrl !== this.config.twitch.ingestUrl;
    this.config.twitch.streamKey = newKey;
    this.config.twitch.ingestUrl = newUrl;
    if (changed) this.logger.info({ keyConfigured: Boolean(newKey), ingestUrl: newUrl }, "ingest credentials updated");
    if (changed && (this.state === "running" || this.state === "reconnecting")) {
      this.logger.info("restarting pipeline to apply new ingest credentials");
      await this.restart();
    }
  }

  /**
   * Multistream targets (restream.io-style). `targets` = array of
   * { id, label, protocol, ingestUrl, streamKey, enabled }.
   *
   * When ANY target is configured the pipeline runs in RELAY mode: the
   * primary encoder publishes ONCE to a local RTMP feed and each ENABLED
   * target gets its own `-c copy` relay process — so a target can be
   * toggled on/off LIVE without dropping the others. With zero targets it
   * uses the legacy single direct output (unchanged). Only the mode
   * transition (first target added / last removed) restarts the primary;
   * toggling a target inside relay mode is hot.
   */
  async setTargets(targets) {
    const wasRelay = this._relayMode();
    this.config.targets = Array.isArray(targets) ? targets : [];
    const isRelay = this._relayMode();
    if (this.state !== "running" && this.state !== "reconnecting") return;
    if (wasRelay !== isRelay) {
      this.logger.info({ relay: isRelay }, "multistream mode changed; restarting pipeline");
      await this.restart();
    } else if (isRelay) {
      this._syncRelays();   // hot add/remove per-target relays
    }
  }

  /** Relay mode is active whenever any multistream target is configured. */
  _relayMode() {
    return Array.isArray(this.config.targets) && this.config.targets.length > 0;
  }

  /** Local RTMP feed the primary publishes to + the relays read from. */
  _localFeedUrl() {
    return `rtmp://127.0.0.1:${this.rtmpPort}/cs-multi/main`;
  }

  _targetId(t) { return String(t.id || `${t.protocol || "rtmp"}:${t.ingestUrl}`); }

  /** Enabled targets with a destination (what the operator WANTS live). */
  _enabledTargets() {
    return (Array.isArray(this.config.targets) ? this.config.targets : [])
      .filter((t) => t && t.enabled !== false && t.ingestUrl);
  }

  /**
   * The enabled targets we actually run RIGHT NOW. When auto-protect is on
   * and the measured uplink can't carry every enabled output, the list is
   * trimmed to `maxStreams` (keeping order → Twitch/priority first); the
   * dropped ones are reported as "throttled" rather than failed.
   */
  _effectiveEnabledTargets() {
    const enabled = this._enabledTargets();
    const max = this.bandwidth?.autoProtect ? this.bandwidth.maxStreams() : null;
    if (max == null || enabled.length <= max) return enabled;
    return enabled.slice(0, max);
  }

  /** Set of target ids held back by auto-protect. */
  _throttledIds() {
    const eff = new Set(this._effectiveEnabledTargets().map((t) => this._targetId(t)));
    const out = new Set();
    for (const t of this._enabledTargets()) {
      const id = this._targetId(t);
      if (!eff.has(id)) out.add(id);
    }
    return out;
  }

  /** Spawn/stop per-target relay processes to match the effective set. */
  _syncRelays() {
    if (!this._relayMode() || this.state !== "running") { this._killAllRelays(); return; }
    const want = new Map(this._effectiveEnabledTargets().map((t) => [this._targetId(t), t]));
    for (const [id, rec] of this.relays) {
      if (!want.has(id)) { rec.stop = true; try { rec.proc?.kill("SIGTERM"); } catch {} this.relays.delete(id); }
    }
    for (const [id, t] of want) {
      if (!this.relays.has(id)) this._spawnRelay(id, t);
    }
    this.emit("status", this.status());
  }

  _spawnRelay(id, t) {
    const out = this._relayOutputArgs(t);
    if (!out) {
      this.logger.warn({ protocol: t.protocol, label: t.label }, "multistream: unsupported protocol; skipping");
      this.relays.set(id, { proc: null, label: t.label || "", state: "failed", startedAt: Date.now(), stop: false });
      return;
    }
    const args = [
      "-hide_banner", "-loglevel", "warning", "-nostats",
      "-fflags", "+nobuffer",
      "-i", this._localFeedUrl(),
      "-c", "copy",
      ...out,
    ];
    const rec = { proc: null, label: t.label || "", state: "connecting", startedAt: Date.now(), stop: false };
    this.relays.set(id, rec);
    let proc;
    try { proc = spawn(this.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (err) { rec.state = "failed"; this.logger.warn({ err: err.message, label: rec.label }, "relay spawn failed"); return; }
    rec.proc = proc;

    const keys = this._enabledTargets().map((x) => x.streamKey).filter(Boolean);
    const redact = (s) => keys.reduce((acc, k) => acc.split(k).join("***"), s);
    // Mark connected once it has streamed a few seconds without dying.
    const okTimer = setTimeout(() => {
      if (this.relays.get(id) === rec && !rec.stop) { rec.state = "connected"; this.emit("status", this.status()); }
    }, 4000);
    proc.stderr?.on("data", (chunk) => {
      const line = redact(chunk.toString().trim());
      if (line && /error|failed|cannot|unable|refused|not found/i.test(line)) {
        this.logger.warn({ relay: rec.label, line }, "relay ffmpeg");
      }
    });
    proc.on("exit", () => {
      clearTimeout(okTimer);
      if (this.relays.get(id) !== rec) return;
      if (rec.stop) { this.relays.delete(id); return; }
      rec.state = "connecting";          // feed not ready / dropped — retry
      // A relay dropping mid-stream is a live congestion signal — ask the
      // monitor to re-test early instead of waiting for the 20-min tick.
      this.bandwidth?.noteCongestion?.("relay drop");
      this.emit("status", this.status());
      setTimeout(() => {
        const still = this._enabledTargets().find((x) => this._targetId(x) === id);
        if (still && this._relayMode() && this.state === "running" && this.relays.get(id) === rec) {
          this._spawnRelay(id, still);
        }
      }, 3000);
    });
  }

  /** Per-target output muxer args (after the shared `-c copy`). */
  _relayOutputArgs(t) {
    const p = String(t.protocol || "rtmp").toLowerCase();
    const url = t.ingestUrl;
    const withKey = t.streamKey ? `${url}/${t.streamKey}` : url;
    if (p === "rtmp" || p === "rtmps") return ["-f", "flv", "-rtmp_live", "live", "-flvflags", "no_duration_filesize", withKey];
    if (p === "srt")    return ["-f", "mpegts", url];
    if (p === "rtsp")   return ["-f", "rtsp", "-rtsp_transport", "tcp", url];
    if (p === "mpegts" || p === "udp") return ["-f", "mpegts", url];
    if (p === "custom") return ["-f", (t.format || "flv"), withKey];
    return null;   // whep / ftl — not supported by FFmpeg copy
  }

  _killAllRelays() {
    for (const [, rec] of this.relays) { rec.stop = true; try { rec.proc?.kill("SIGTERM"); } catch {} }
    this.relays.clear();
  }

  /** Per-target status for the panel (red/orange/green dots). */
  _relayStatus() {
    const active = this._relayMode();
    const byId = this.relays;
    const throttled = active ? this._throttledIds() : new Set();
    return {
      active,
      targets: (Array.isArray(this.config.targets) ? this.config.targets : []).map((t) => {
        const id = this._targetId(t);
        const rec = byId.get(id);
        let state = "off";
        if (t.enabled === false || !t.ingestUrl) state = "off";
        else if (this.state !== "running") state = "idle";
        else if (throttled.has(id)) state = "throttled";   // held by auto-protect
        else state = rec ? rec.state : "connecting";
        return { id, label: t.label || "", enabled: t.enabled !== false, state };
      }),
    };
  }

  /** Bandwidth / auto-protect controls from the panel. */
  setBandwidthOptions(opts = {}) {
    if (typeof opts.autoProtect === "boolean") this.bandwidth.setAutoProtect(opts.autoProtect);
    if (opts.retest) this.bandwidth.retest();
    return this.bandwidth.status();
  }

  // ---- VOD ------------------------------------------------------

  async playVod(source) {
    if (!source || !source.pathOrUrl) throw new Error("VOD source required");
    if (!this.config.twitch.streamKey) throw new Error("TWITCH_STREAM_KEY not set");
    this.shouldRun = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    await this._teardown();
    this.vod = source;
    this._spawnVodFfmpeg(source);
    this.vodStartedAt = Date.now();
    this.startedAt = this.vodStartedAt;
    this._setState("running");
  }

  async stopVod() {
    if (!this.vod) return;
    this.vod = null;
    if (this.vodFfmpeg) {
      const proc = this.vodFfmpeg; this.vodFfmpeg = null;
      try { proc.kill("SIGTERM"); } catch {}
    }
    this.vodStartedAt = null;
    this.startedAt = null;
    this._setState("idle");
  }

  // ---- internals ------------------------------------------------

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit("status", this.status());
  }

  async _runOnce() {
    await this._openWindow();
    this._spawnFFmpeg();
    this._startPainting();
    await this._reapplyOverlays();

    this.lastFrameAt = null;
    this._startWatchdog();
    this._startRecycleTimer();

    this.logger.info({
      ingest: this.config.twitch.ingestUrl,
      resolution: `${this.config.video.width}x${this.config.video.height}`,
      fps: this.config.video.fps,
      scene: this.sceneUrl,
      backend: "electron-offscreen",
    }, "streaming to twitch");
  }

  async _openWindow() {
    const { width, height, fps } = this.config.video;
    this.win = new BrowserWindow({
      width, height,
      show: false,
      frame: false,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    // Cap the offscreen paint cadence to our target fps. Electron
    // renders on the GPU and drives BeginFrame at this rate, so we
    // get a real `fps` worth of distinct frames for animated scenes.
    this.win.webContents.setFrameRate(Math.max(1, Math.min(fps, 60)));
    await this.win.webContents.loadURL(this.sceneUrl);
  }

  _startPainting() {
    const wc = this.win.webContents;
    const quality = this.config.video.screencastQuality;
    // Headroom of several encoded frames before we start dropping. A
    // single 1080p MJPEG frame can be ~200-400 KB, so the old 256 KB
    // cap dropped everything after one buffered frame the instant
    // FFmpeg hiccupped. ~12 MB ≈ a few hundred ms of slack at 1080p,
    // enough to ride out transient stalls without choppiness while
    // still bounding latency.
    const BACKPRESSURE_DROP_THRESHOLD = 12 * 1024 * 1024;

    wc.on("paint", (_event, _dirty, image) => {
      const ffmpeg = this.ffmpeg;
      if (!ffmpeg) return;
      const stdin = ffmpeg.stdin;
      if (!stdin || !stdin.writable) return;

      // Drop, don't queue — a live stream values fresh frames over a
      // backlog of stale ones. Same policy as the Docker backend.
      if (stdin.writableLength > BACKPRESSURE_DROP_THRESHOLD) {
        this.framesDropped++;
        return;
      }
      let buf;
      try { buf = image.toJPEG(quality); } catch { return; }
      if (!buf || !buf.length) return;
      this.frameCount++;
      this.lastFrameAt = Date.now();
      stdin.write(buf);
    });

    // Offscreen painting starts automatically, but only fires on
    // damage. A 1 Hz invalidate keeps frames flowing for a fully
    // static custom scene so the watchdog never false-trips; FFmpeg
    // pads to CFR regardless. Animated scenes paint at full fps.
    this.keepaliveTimer = setInterval(() => {
      try { if (this.win && !this.win.isDestroyed()) this.win.webContents.invalidate(); } catch {}
    }, 1000);
  }

  _spawnFFmpeg() {
    const { video, audio, twitch } = this.config;
    // Output: in RELAY mode (multistream targets configured) the primary
    // publishes ONCE to a local RTMP feed that the per-target relays read
    // (so targets toggle on/off live). Otherwise the legacy single direct
    // Twitch output.
    const relay = this._relayMode();
    const primaryUrl = relay ? this._localFeedUrl() : `${twitch.ingestUrl}/${twitch.streamKey}`;
    const safeUrl = relay ? "rtmp://127.0.0.1/cs-multi/main (multistream relay)" : `${twitch.ingestUrl}/***`;
    const redactKeys = relay ? [] : [twitch.streamKey].filter(Boolean);
    const outputArgs = ["-f", "flv", "-rtmp_live", "live", "-flvflags", "no_duration_filesize", primaryUrl];
    const logLevel = process.env.STREAM_FFMPEG_LOGLEVEL || "warning";
    // Offscreen 'paint' events don't fire at perfectly even intervals,
    // so the wallclock-stamped frames have jittery PTS. Twitch's
    // low-latency player can't smooth that — it shows up as "skipped
    // frames" + buffering even when the viewer has bandwidth to spare.
    // Re-time every frame onto a clean constant-frame-rate grid with
    // the fps filter so the output PTS are perfectly evenly spaced.
    // (buildVideoFilters already returns an fps step in capture-every-
    // nth mode; otherwise we add one ourselves.)
    const vFilter = buildVideoFilters(video) || `fps=${video.fps}`;

    const args = [
      "-hide_banner", "-loglevel", logLevel, "-nostats",

      // Input 0: MJPEG frames from the offscreen window over stdin.
      // Large thread_queue_size so a brief encoder/RTMP hiccup doesn't
      // block the reader thread (which would stall video intake and
      // make us drop frames). 32 was far too small for 1080p frames.
      "-thread_queue_size", "1024",
      "-framerate", String(video.fps),
      "-use_wallclock_as_timestamps", "1",
      "-f", "image2pipe", "-vcodec", "mjpeg", "-i", "-",

      // Input 1: PCM audio from the relay (always-on realtime carrier;
      // silence when no track is playing). A single input → no amix.
      "-thread_queue_size", "1024",
      "-f", "s16le", "-ar", "44100", "-ac", "2",
      "-i", `tcp://127.0.0.1:${this.relayOutPort}`,

      ...(vFilter
        ? ["-filter_complex", `[0:v]${vFilter}[v]`, "-map", "[v]", "-map", "1:a"]
        : ["-map", "0:v", "-map", "1:a"]),

      ...buildVideoCodecArgs(video),

      "-c:a", "aac", "-b:a", `${audio.bitrateKbps}k`, "-ar", "44100", "-ac", "2",

      ...outputArgs,
    ];

    this.logger.debug({ url: safeUrl, codec: video.codec, relay }, "spawning ffmpeg");
    this.ffmpeg = spawn(this.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.ingestAccepted = false;

    // In relay mode, bring up the per-target relays once the primary has
    // started publishing to the local feed (give it a moment to connect).
    if (relay) setTimeout(() => { if (this.state === "running") this._syncRelays(); }, 1500);

    let hwEncoderFailed = false;
    const hwFailurePatterns = /v4l2|video11|h264_v4l2m2m|h264_nvenc|h264_qsv|cannot open codec|cannot open device|operation not permitted|no such device/i;

    const INGEST_GRACE_MS = 8000;
    const ingestFailPatterns = /Connection refused|Server returned|Cannot push|Broken pipe|RTMP_Connect.*failed|Unable to find a suitable output format|av_interleaved_write_frame|Input\/output error|End of file/i;
    const graceTimer = setTimeout(() => {
      if (this.ffmpeg && !this.ingestAccepted) {
        this.ingestAccepted = true;
        this.logger.info({ afterMs: INGEST_GRACE_MS }, "twitch ingest accepted the stream");
      }
    }, INGEST_GRACE_MS);
    this.ffmpeg.once("exit", () => clearTimeout(graceTimer));

    const redact = (s) => redactKeys.reduce((acc, k) => acc.split(k).join("***"), s);
    this.ffmpeg.stderr.on("data", (chunk) => {
      const line = redact(chunk.toString().trim());
      if (!line) return;
      const isError = /error|failed|cannot|invalid/i.test(line);
      if (isError) this.logger.warn({ ffmpeg: line }, "ffmpeg");
      else this.logger.debug({ ffmpeg: line }, "ffmpeg");
      if (this.ingestAccepted && ingestFailPatterns.test(line)) {
        this.ingestAccepted = false;
        this.logger.warn({ line }, "twitch ingest dropped the stream");
      }
      if (isError && hwFailurePatterns.test(line) && video.codec !== "libx264") hwEncoderFailed = true;
    });

    this.ffmpeg.on("exit", (code, signal) => {
      this.logger.warn({ code, signal, codec: video.codec }, "ffmpeg exited");
      if (hwEncoderFailed) {
        this.logger.warn({ from: video.codec, to: "libx264" }, "hw encoder failed; falling back to libx264");
        this.config.video.codec = "libx264";
        if (!this.config.video.preset) this.config.video.preset = "ultrafast";
      }
      if (this.shouldRun && this.state !== "stopping") this._scheduleReconnect();
    });

    this.ffmpeg.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") this.logger.warn({ err }, "ffmpeg stdin error");
    });
  }

  async _reapplyOverlays() {
    if (!this.win || this.win.isDestroyed()) return;
    const overlays = this.overlays || [];
    try {
      const js = `(${overlayInjector.toString()})(${JSON.stringify(OVERLAY_CONTAINER_ID)}, ${JSON.stringify(overlays)})`;
      await this.win.webContents.executeJavaScript(js, true);
    } catch (err) {
      this.logger.debug({ err }, "overlay injection skipped");
    }
  }

  _spawnVodFfmpeg(source) {
    const { video, audio, twitch } = this.config;
    const rtmpUrl = `${twitch.ingestUrl}/${twitch.streamKey}`;
    const inputArgs = source.loop
      ? ["-stream_loop", "-1", "-re", "-i", source.pathOrUrl]
      : ["-re", "-i", source.pathOrUrl];
    const args = [
      "-hide_banner", "-loglevel", "warning", "-nostats",
      ...inputArgs,
      "-vf", `fps=${video.fps},format=yuv420p`,
      ...buildVideoCodecArgs(video),
      "-c:a", "aac", "-b:a", `${audio.bitrateKbps}k`, "-ar", "44100", "-ac", "2",
      "-f", "flv", "-rtmp_live", "live", "-flvflags", "no_duration_filesize",
      "-rw_timeout", "15000000", "-timeout", "15000000",
      rtmpUrl,
    ];
    this.logger.info({ name: source.name, kind: source.kind, loop: !!source.loop }, "vod ffmpeg starting");
    this.vodFfmpeg = spawn(this.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    const key = twitch.streamKey || "";
    const redact = (s) => key ? s.split(key).join("***") : s;
    this.vodFfmpeg.stderr.on("data", (chunk) => {
      const line = redact(chunk.toString().trim());
      if (line && /error|failed|cannot|invalid/i.test(line)) this.logger.warn({ ffmpeg: line }, "vod ffmpeg");
    });
    this.vodFfmpeg.on("exit", (code) => {
      const wasActive = !!this.vod;
      this.vodFfmpeg = null;
      if (wasActive && code === 0) {
        this.vod = null; this.startedAt = null; this.vodStartedAt = null;
        this._setState("idle");
      }
    });
  }

  // ---- reconnect / watchdog / teardown --------------------------

  _startWatchdog() {
    this._stopWatchdog();
    const timeoutMs = this.config.runtime.watchdogTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return;
    this.watchdogTimer = setInterval(() => {
      if (this.state !== "running") return;
      if (this.lastFrameAt) {
        const idleMs = Date.now() - this.lastFrameAt;
        if (idleMs > timeoutMs) {
          this.logger.warn({ idleMs }, "watchdog: no frames, forcing reconnect");
          this._stopWatchdog(); this._scheduleReconnect(); return;
        }
      }
      const limitMB = this.config.runtime.memoryRecycleLimitMB;
      if (limitMB && limitMB > 0) {
        const rssMB = Math.round(process.memoryUsage().rss / 1048576);
        if (rssMB > limitMB) {
          this.logger.warn({ rssMB, limitMB }, "watchdog: memory pressure, forcing recycle");
          this._stopWatchdog(); this._scheduleReconnect();
        }
      }
    }, 5000);
  }
  _stopWatchdog() { if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; } }

  _startRecycleTimer() {
    this._stopRecycleTimer();
    const ms = this.config.runtime.browserRecycleMs;
    if (!ms || ms <= 0) return;
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = null;
      if (this.state !== "running" || this.vod) { this._startRecycleTimer(); return; }
      this.logger.info({ afterMs: ms }, "scheduled recycle — restarting pipeline");
      this._scheduleReconnect();
    }, ms);
  }
  _stopRecycleTimer() { if (this.recycleTimer) { clearTimeout(this.recycleTimer); this.recycleTimer = null; } }

  _scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.restartTimer || this.reconnecting) return;
    const delay = this.reconnectBackoffMs;
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, this.config.runtime.reconnectDelayMs);
    this.logger.warn({ delayMs: delay }, "scheduling reconnect");
    this._setState("reconnecting");
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      this.reconnecting = true;
      try {
        await this._teardown();
        if (!this.shouldRun) return;
        await this._runOnce();
        this.reconnectBackoffMs = 1000;
        this.startedAt = Date.now();
        this._setState("running");
      } catch (err) {
        this.logger.error({ err }, "reconnect failed");
        this.error = err.message;
        this.reconnecting = false;
        this._scheduleReconnect();
        return;
      }
      this.reconnecting = false;
    }, delay);
  }

  async _teardown() {
    this._stopWatchdog();
    this._stopRecycleTimer();
    this._killAllRelays();
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }

    const deadline = this.config.runtime.teardownTimeoutMs || 10_000;
    const work = (async () => {
      if (this.ffmpeg) {
        const proc = this.ffmpeg; this.ffmpeg = null;
        try { proc.stdin.end(); } catch {}
        await new Promise((resolve) => {
          const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
          proc.once("exit", () => { clearTimeout(killTimer); resolve(); });
          try { proc.kill("SIGTERM"); } catch { resolve(); }
        });
      }
      if (this.win && !this.win.isDestroyed()) {
        try { this.win.webContents.stopPainting?.(); } catch {}
        try { this.win.destroy(); } catch {}
      }
      this.win = null;
    })();

    let timedOut = false;
    await Promise.race([
      work,
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, deadline)),
    ]);
    if (timedOut) {
      this.logger.warn({ deadline }, "_teardown exceeded deadline; forcing cleanup");
      try { this.ffmpeg?.kill?.("SIGKILL"); } catch {}
      this.ffmpeg = null;
      try { this.win?.destroy?.(); } catch {}
      this.win = null;
    }
  }
}

module.exports = { DesktopStreamer };
