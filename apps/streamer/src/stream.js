"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

/**
 * Puppeteer → FFmpeg → Twitch RTMP pipeline.
 *
 *   Headless Chromium (CDP Page.startScreencast, JPEG frames)
 *        │
 *        ▼ binary write into ffmpeg.stdin
 *   FFmpeg (image2pipe → libx264 yuv420p, AAC silent audio, FLV/RTMP)
 *        ▼
 *   Twitch ingest
 *
 * Why screencast (not screenshot loops)?
 * `page.screenshot()` round-trips through the browser's paint
 * pipeline and caps around ~10 FPS. Page.startScreencast pushes
 * frames as they're painted and easily sustains 30 FPS at 1080p.
 *
 * Frame pacing
 * Chromium emits frames at the page's natural paint rate, which
 * is usually >= STREAM_FPS but not perfectly uniform. We feed
 * FFmpeg with -use_wallclock_as_timestamps so timestamps come
 * from real time, then constrain output to a constant -r so
 * Twitch gets a steady CFR even if a frame is skipped.
 *
 * Overlays
 * Overlays (text, image, HTML) are injected into the loaded
 * page itself by running JavaScript via Puppeteer — they
 * become part of the rendered DOM, so FFmpeg never has to
 * composite anything. This keeps CPU low and avoids the
 * "second video input" complexity FFmpeg overlays normally
 * require.
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const puppeteer = require("puppeteer-core");

const OVERLAY_CONTAINER_ID = "__cachestream_overlays__";

/**
 * Build the codec-specific portion of the FFmpeg argv.
 *
 * The auto-profile may pick a hardware encoder (h264_v4l2m2m on a
 * Raspberry Pi, h264_nvenc on NVIDIA, etc.). Those encoders ignore
 * libx264's `-preset` / `-tune` / `-x264-params` flags and need
 * their own. This helper centralises the differences so the main
 * argv stays readable.
 */
function buildVideoCodecArgs(video) {
  const codec = video.codec || "libx264";
  const common = [
    "-c:v", codec,
    "-pix_fmt", "yuv420p",
    "-r", String(video.fps),
    "-g", String(video.fps * 2),
    "-keyint_min", String(video.fps * 2),
    "-sc_threshold", "0",
    "-b:v", `${video.bitrateKbps}k`,
    "-maxrate", `${video.maxrateKbps}k`,
    "-bufsize", `${video.bufsizeKbps}k`,
  ];

  if (codec === "libx264") {
    return [
      ...common,
      "-preset", video.preset,
      ...(video.tune ? ["-tune", video.tune] : []),
      "-profile:v", "high",
      "-x264-params", `threads=${video.x264Threads || 0}:lookahead-threads=1`,
    ];
  }

  if (codec === "h264_nvenc") {
    return [
      ...common,
      // NVENC's analogue of `veryfast`. p1=fastest, p7=slowest.
      "-preset", "p4",
      "-tune",   "ll",         // low-latency for live streaming
      "-rc",     "cbr",
      "-profile:v", "high",
    ];
  }

  if (codec === "h264_qsv") {
    return [
      ...common,
      "-preset", "veryfast",
      "-profile:v", "high",
      "-look_ahead", "0",
    ];
  }

  if (codec === "h264_v4l2m2m") {
    // Raspberry Pi hardware encoder. Doesn't support `-preset` —
    // its quality control is bitrate alone (already set in common).
    // num_capture_buffers=32 prevents the Pi's frame-grabber from
    // running dry under jitter.
    return [
      ...common,
      "-num_capture_buffers", "32",
    ];
  }

  if (codec === "h264_videotoolbox") {
    return [
      ...common,
      "-profile:v", "high",
      "-allow_sw", "1",
    ];
  }

  // Unknown codec — fall back to libx264 flags rather than break.
  return [
    ...common,
    "-preset", video.preset,
    "-profile:v", "high",
  ];
}

/**
 * Build the minimum video filter chain for the configured output.
 *
 *   - Skip `fps=` when Chromium is already feeding us the target rate
 *     (i.e. capture-every-nth-frame produces the same effective fps).
 *   - Skip `scale=` when capture resolution matches output exactly.
 *   - `-pix_fmt yuv420p` on the encoder side covers chroma conversion,
 *     so we don't need a `format=yuv420p` filter step.
 *
 * Returns the inner filter string for a [0:v]...[v] complex chain.
 * Always returns at least an `null` filter so the chain is syntactically
 * valid even when nothing needs doing.
 */
function buildVideoFilters(video) {
  const steps = [];
  // Page repaints aren't perfectly periodic; cap to FPS regardless.
  steps.push(`fps=${video.fps}`);
  // Only scale if we actually need to.
  // (When captureEveryNth > 1 Chromium still hands us the same
  //  resolution, so the comparison still holds.)
  // We can't read the actual capture size here, so be conservative:
  // skip the scaler only when both dims are already what we want.
  // In practice the viewport is exactly width×height, so this is
  // the common case.
  // If the operator runs with mismatched STREAM_WIDTH/HEIGHT vs the
  // page viewport, FFmpeg will letterbox-or-stretch via the encoder.
  steps.push(`scale=${video.width}:${video.height}:flags=bilinear`);
  return steps.join(",");
}

class Streamer extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;

    this.state = "idle"; // idle | starting | running | reconnecting | stopping
    this.error = null;
    this.startedAt = null;
    this.frameCount = 0;
    this.lastFrameAt = null;

    // Twitch ingest accept/reject signal. Flips to true when
    // FFmpeg's stderr emits the "Output #0" / "Stream #0" lines
    // that only appear after the RTMP handshake succeeds. Flips
    // to false if we see "Connection refused" / "Server returned
    // 404" / "Cannot push to RTMP". Surfaces in /status so the
    // panel can show RUNNING-but-not-actually-broadcasting.
    this.ingestAccepted = false;

    this.sceneUrl = config.scene.defaultUrl;
    this.overlays = []; // [{ id, type:'text'|'html'|'image', ...payload }]

    this.browser = null;
    this.page = null;
    this.client = null;
    this.ffmpeg = null;

    this.restartTimer = null;
    this.shouldRun = false; // user intent — survives reconnects

    // VOD mode: when active, the screencast pipeline is torn
    // down and a direct file-to-RTMP FFmpeg takes over.
    this.vod = null;          // { id, name, kind, pathOrUrl, loop }
    this.vodFfmpeg = null;
    this.vodStartedAt = null;
  }

  // ---- Public API used by the HTTP layer -----------------------

  status() {
    return {
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      sceneUrl: this.sceneUrl,
      overlays: this.overlays,
      frameCount: this.frameCount,
      lastFrameAt: this.lastFrameAt,
      vod: this.vod
        ? { id: this.vod.id, name: this.vod.name, kind: this.vod.kind,
            startedAt: this.vodStartedAt, loop: !!this.vod.loop }
        : null,
      twitch: {
        ingestUrl: this.config.twitch.ingestUrl,
        keyConfigured: Boolean(this.config.twitch.streamKey),
      },
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
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this._teardown();
    this.startedAt = null;
    this._setState("idle");
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async setScene(url) {
    if (!url || typeof url !== "string") throw new Error("scene url required");
    this.sceneUrl = url;
    if (this.page && this.state === "running") {
      this.logger.info({ url }, "switching scene");
      await this.page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
      await this._reapplyOverlays();
    }
  }

  async setOverlays(overlays) {
    if (!Array.isArray(overlays)) throw new Error("overlays must be an array");
    this.overlays = overlays;
    if (this.page && this.state === "running") {
      await this._reapplyOverlays();
    }
  }

  /**
   * Update the Twitch ingest URL + stream key at runtime.
   *
   * Either field can be:
   *   - undefined  → leave untouched
   *   - null or "" → clear (fall back to whatever .env provided
   *                  on container start)
   *   - a string   → use that value
   *
   * If the broadcast is currently running we hot-restart the
   * pipeline with the new credentials. Twitch sees a quick
   * reconnect (~5 s) instead of a full channel drop.
   *
   * The web container is the source of truth for these values
   * (stored in SQLite via the panel). There's no persistence on
   * this side — on streamer restart the panel pushes the latest
   * values again via this RPC.
   */
  async setIngest(input) {
    const patch = input || {};
    const newKey = patch.streamKey === undefined
      ? this.config.twitch.streamKey
      : (patch.streamKey ?? "");
    const newUrl = patch.ingestUrl === undefined
      ? this.config.twitch.ingestUrl
      : (patch.ingestUrl ?? "rtmp://live.twitch.tv/app");

    const changed =
      newKey !== this.config.twitch.streamKey ||
      newUrl !== this.config.twitch.ingestUrl;

    this.config.twitch.streamKey = newKey;
    this.config.twitch.ingestUrl = newUrl;

    if (changed) {
      this.logger.info(
        { keyConfigured: Boolean(newKey), ingestUrl: newUrl },
        "ingest credentials updated"
      );
    }
    if (changed && (this.state === "running" || this.state === "reconnecting")) {
      this.logger.info("restarting pipeline to apply new ingest credentials");
      await this.restart();
    }
  }

  // ---- VOD (pre-recorded video / remote stream) ----------------

  /**
   * Switch the broadcast away from the Chromium screencast pipeline
   * and into a direct file-to-RTMP FFmpeg streaming the given VOD.
   *
   * source = { id, name, kind: 'file'|'url', pathOrUrl, loop }
   *   - kind 'file': pathOrUrl is a path inside the streamer
   *     container's filesystem (we expect it pre-resolved by the
   *     web container — see /api/vods/play).
   *   - kind 'url':  pathOrUrl is an http(s) URL FFmpeg can ingest.
   */
  async playVod(source) {
    if (!source || !source.pathOrUrl) throw new Error("VOD source required");
    if (!this.config.twitch.streamKey) throw new Error("TWITCH_STREAM_KEY not set");

    // Tear down screencast pipeline (Chromium + main ffmpeg) so the
    // RTMP destination is freed up for the VOD ffmpeg.
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
      const proc = this.vodFfmpeg;
      this.vodFfmpeg = null;
      try { proc.kill("SIGTERM"); } catch {}
    }
    this.vodStartedAt = null;
    this.startedAt = null;
    this._setState("idle");
  }

  // ---- Pipeline internals --------------------------------------

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit("status", this.status());
  }

  async _runOnce() {
    await this._launchBrowser();
    await this._openScene();
    this._spawnFFmpeg();
    await this._startScreencast();
    await this._reapplyOverlays();

    this.logger.info(
      {
        ingest: this.config.twitch.ingestUrl,
        resolution: `${this.config.video.width}x${this.config.video.height}`,
        fps: this.config.video.fps,
        scene: this.sceneUrl,
      },
      "streaming to twitch"
    );
  }

  async _launchBrowser() {
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

    this.browser = await puppeteer.launch({
      executablePath: execPath,
      headless: "new",
      defaultViewport: {
        width: this.config.video.width,
        height: this.config.video.height,
        deviceScaleFactor: 1,
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-software-rasterizer",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--autoplay-policy=no-user-gesture-required",
        "--hide-scrollbars",
        "--mute-audio",
        `--window-size=${this.config.video.width},${this.config.video.height}`,
      ],
    });

    this.browser.on("disconnected", () => {
      if (this.shouldRun && this.state !== "stopping") {
        this.logger.warn("chromium disconnected");
        this._scheduleReconnect();
      }
    });
  }

  async _openScene() {
    this.page = await this.browser.newPage();
    await this.page.setViewport({
      width: this.config.video.width,
      height: this.config.video.height,
      deviceScaleFactor: 1,
    });
    this.logger.info({ url: this.sceneUrl }, "loading scene");
    await this.page.goto(this.sceneUrl, { waitUntil: "networkidle2", timeout: 30_000 });
  }

  _spawnFFmpeg() {
    const { video, audio, twitch } = this.config;
    const rtmpUrl = `${twitch.ingestUrl}/${twitch.streamKey}`;
    const safeUrl = `${twitch.ingestUrl}/***`;

    // ─────────────────────────────────────────────────────────
    // FFmpeg invocation:
    //
    //   Input 0: MJPEG frames from Chromium (stdin)
    //   Input 1: silence PCM (silence.fifo) — always-on carrier,
    //            never has gaps. The web container's music
    //            engine keeps an ffmpeg writing anullsrc here
    //            continuously.
    //   Input 2: music PCM (music.fifo) — real music when a
    //            track is playing, no writer otherwise. amix
    //            dropout_transition=0 falls back to the silence
    //            carrier seamlessly when this input is silent.
    //   Input 3: lavfi anullsrc — secondary safety net in case
    //            the silence-filler container hasn't started yet.
    //
    // Why two FIFOs (split from v1.5's single FIFO)? When the
    // music writer killed itself between tracks, the streamer's
    // ffmpeg briefly saw EOF on the FIFO and decided the audio
    // stream had ended, dropping the Twitch connection. With
    // two parallel always-open FIFOs + amix, the music writer
    // can come and go freely and the audio stream never breaks.
    // ─────────────────────────────────────────────────────────

    this._ensureAudioFifos();
    const silenceFifo = process.env.SILENCE_FIFO_PATH || "/app/audio/silence.fifo";
    const musicFifo   = process.env.MUSIC_FIFO_PATH   || "/app/audio/music.fifo";

    // FFmpeg loglevel — env-overridable for diagnostics. Set
    // STREAM_FFMPEG_LOGLEVEL=verbose (or info) to see the RTMP
    // handshake and Twitch's responses; default warning keeps
    // the steady-state log clean.
    const ffmpegLogLevel = process.env.STREAM_FFMPEG_LOGLEVEL || "warning";

    const args = [
      "-hide_banner",
      "-loglevel", ffmpegLogLevel,
      "-nostats",

      // Input 0: MJPEG frames over stdin
      "-thread_queue_size", "1024",
      "-use_wallclock_as_timestamps", "1",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-i", "-",

      // Input 1: silence carrier FIFO (always written by web)
      "-thread_queue_size", "1024",
      "-f", "s16le", "-ar", "44100", "-ac", "2",
      "-i", silenceFifo,

      // Input 2: music FIFO (written only while a track plays)
      "-thread_queue_size", "1024",
      "-f", "s16le", "-ar", "44100", "-ac", "2",
      "-i", musicFifo,

      // Input 3: lavfi safety net so we always have something to
      // mix even if BOTH FIFOs are missing writers at startup
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",

      // -- Filter graph --
      // [0:v] → fps + scale + yuv420p
      // [1:a][2:a][3:a] → amix(silence + music + lavfi).
      //    duration=first follows the silence input (paced by -re
      //    on its writer side). dropout_transition=0 means dropouts
      //    don't trigger the 5s ramp; we just lose the missing
      //    input cleanly.
      "-filter_complex",
        `[0:v]fps=${video.fps},scale=${video.width}:${video.height}:flags=bilinear,format=yuv420p[v];` +
        `[1:a][2:a][3:a]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[a]`,
      "-map", "[v]",
      "-map", "[a]",

      // Video encode (codec-specific flags built by helper)
      ...buildVideoCodecArgs(video),

      // Audio encode
      "-c:a", "aac",
      "-b:a", `${audio.bitrateKbps}k`,
      "-ar", "44100",
      "-ac", "2",

      // Output
      "-f", "flv",
      "-rtmp_live", "live",
      "-flvflags", "no_duration_filesize",
      rtmpUrl,
    ];

    this.logger.debug({ url: safeUrl, codec: video.codec }, "spawning ffmpeg");
    this.ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.ingestAccepted = false;

    // Track signs that the hardware encoder isn't actually usable.
    // Common failure modes on a Pi:
    //   - "Cannot open device /dev/video11" (device not passed in)
    //   - "Could not open codec" / "h264_v4l2m2m" errors
    //   - "Operation not permitted" (cgroup denies access)
    // When we see any of these AND the current codec is not libx264,
    // we'll silently fall back on the next pipeline restart.
    let hwEncoderFailed = false;
    const hwFailurePatterns = /v4l2|video11|h264_v4l2m2m|h264_nvenc|h264_qsv|cannot open codec|cannot open device|operation not permitted|no such device/i;

    // ── Twitch ingest accept/reject signal ──────────────────────
    //
    // We want the panel badge to flip from "encoding" to "ingest
    // accepted" only after Twitch confirms it took our RTMP
    // connection. The earlier approach was to grep for `Output #0`
    // in FFmpeg stderr — but at our default loglevel=warning,
    // FFmpeg never prints that line. The flag was permanently
    // false even on a healthy broadcast.
    //
    // Replacement: time-based. Twitch closes the TCP socket within
    // ~5s if it's going to reject (wrong key, duplicate session,
    // etc.). If FFmpeg is still running at INGEST_GRACE_MS without
    // having logged a rejection-shaped error, we treat that as
    // acceptance. Simple, robust across ffmpeg log levels.
    const INGEST_GRACE_MS = 8000;
    const ingestFailPatterns = /Connection refused|Server returned|Cannot push|Broken pipe|RTMP_Connect.*failed|Unable to find a suitable output format|av_interleaved_write_frame|Input\/output error|End of file/i;

    const ingestGraceTimer = setTimeout(() => {
      // Still here after the grace window → Twitch accepted.
      // Only fire if ffmpeg hasn't already been declared dropped.
      if (this.ffmpeg && !this.ingestAccepted) {
        this.ingestAccepted = true;
        this.logger.info({ afterMs: INGEST_GRACE_MS }, "twitch ingest accepted the stream");
      }
    }, INGEST_GRACE_MS);
    // Cancel the grace timer if ffmpeg dies inside the window.
    this.ffmpeg.once("exit", () => clearTimeout(ingestGraceTimer));

    // Redact the stream key from anywhere it might appear in FFmpeg's
    // stderr — e.g. URL echoes on error like
    // "rtmp://live.twitch.tv/app/live_…: Input/output error".
    const streamKey = this.config.twitch.streamKey || "";
    const redact = (s) => streamKey ? s.split(streamKey).join("***") : s;

    this.ffmpeg.stderr.on("data", (chunk) => {
      const line = redact(chunk.toString().trim());
      if (!line) return;
      const isError = /error|failed|cannot|invalid/i.test(line);
      // When STREAM_FFMPEG_LOGLEVEL is non-default, surface every
      // line at info — otherwise diagnostics get swallowed by pino's
      // default debug-suppression.
      const verbose = ffmpegLogLevel !== "warning" && ffmpegLogLevel !== "error" && ffmpegLogLevel !== "fatal";
      if (isError)      this.logger.warn({ ffmpeg: line }, "ffmpeg");
      else if (verbose) this.logger.info({ ffmpeg: line }, "ffmpeg");
      else              this.logger.debug({ ffmpeg: line }, "ffmpeg");

      if (this.ingestAccepted && ingestFailPatterns.test(line)) {
        this.ingestAccepted = false;
        this.logger.warn({ line }, "twitch ingest dropped the stream");
      }

      if (isError && hwFailurePatterns.test(line) && video.codec !== "libx264") {
        hwEncoderFailed = true;
      }
    });

    this.ffmpeg.on("exit", (code, signal) => {
      this.logger.warn({ code, signal, codec: video.codec }, "ffmpeg exited");

      // Hardware-encoder runtime fallback. If the HW encoder couldn't
      // open its device, libx264 is always available — switch to it
      // permanently for this process so we stop hammering the broken
      // device every reconnect cycle.
      if (hwEncoderFailed) {
        this.logger.warn(
          { from: video.codec, to: "libx264" },
          "hw encoder failed at runtime; permanently falling back to libx264"
        );
        this.config.video.codec = "libx264";
        // Re-tighten preset if we were on a HW-only profile that
        // assumed essentially-free encoding.
        if (!this.config.video.preset) this.config.video.preset = "ultrafast";
        if (!this.config.video.x264Threads) this.config.video.x264Threads = 0;
      }

      if (this.shouldRun && this.state !== "stopping") this._scheduleReconnect();
    });

    this.ffmpeg.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") this.logger.warn({ err }, "ffmpeg stdin error");
    });
  }

  async _startScreencast() {
    this.client = await this.page.target().createCDPSession();

    this.client.on("Page.screencastFrame", async ({ data, sessionId }) => {
      try {
        await this.client.send("Page.screencastFrameAck", { sessionId });
      } catch {
        return;
      }

      if (!this.ffmpeg || !this.ffmpeg.stdin.writable) return;

      const buf = Buffer.from(data, "base64");
      this.frameCount++;
      this.lastFrameAt = Date.now();

      // Backpressure: drop, don't queue. A live stream prefers
      // the newest frame over a stale buffered one.
      //
      // We intentionally don't attach a `drain` listener here —
      // (a) we don't need to wait for it (we'd rather drop),
      // (b) the no-op listener we used to attach accumulated under
      //     sustained backpressure and tripped Node's
      //     MaxListenersExceededWarning on the underlying Socket.
      this.ffmpeg.stdin.write(buf);
    });

    await this.client.send("Page.startScreencast", {
      format: "jpeg",
      // Lower quality → less Chromium encode + less FFmpeg decode.
      // Visually negligible after H.264 re-encode at typical bitrates.
      quality: this.config.video.screencastQuality,
      everyNthFrame: this.config.video.captureEveryNthFrame,
      maxWidth: this.config.video.width,
      maxHeight: this.config.video.height,
    });
  }

  /**
   * Render overlays by injecting a DOM container into the page.
   * Overlays are part of the painted page, so they ride the
   * normal screencast pipeline — no FFmpeg filter graph needed.
   */
  async _reapplyOverlays() {
    if (!this.page) return;
    const overlays = this.overlays || [];
    try {
      await this.page.evaluate(
        ({ containerId, overlays }) => {
          const existing = document.getElementById(containerId);
          if (existing) existing.remove();
          if (!overlays.length) return;

          const container = document.createElement("div");
          container.id = containerId;
          Object.assign(container.style, {
            position: "fixed",
            inset: "0",
            pointerEvents: "none",
            zIndex: "2147483647",
          });

          for (const o of overlays) {
            const el = document.createElement("div");
            Object.assign(el.style, {
              position: "absolute",
              top:    (o.top    ?? "auto"),
              left:   (o.left   ?? "auto"),
              right:  (o.right  ?? "auto"),
              bottom: (o.bottom ?? "auto"),
              padding: "0.5rem 1rem",
              font: o.font || "600 24px Segoe UI, system-ui, sans-serif",
              color: o.color || "#e6f7ff",
              textShadow: o.glow !== false
                ? "0 0 6px rgba(0,240,255,.7), 0 0 18px rgba(138,43,255,.4)"
                : "none",
              background: o.background || "rgba(10,13,24,.55)",
              border: o.border || "1px solid rgba(0,240,255,.25)",
              borderRadius: o.radius || "4px",
              backdropFilter: "blur(2px)",
              opacity: String(o.opacity ?? 1),
            });

            if (o.type === "image" && o.src) {
              const img = document.createElement("img");
              img.src = o.src;
              img.style.display = "block";
              img.style.maxWidth = o.width || "auto";
              img.style.maxHeight = o.height || "auto";
              el.appendChild(img);
            } else if ((o.type === "chat" || o.type === "alert") && o.src) {
              // Live widgets are isolated in an iframe so their
              // EventSource subscriptions don't interfere with the
              // host page, and so innerHTML injection rules don't
              // apply (iframes can run their own JS).
              const iframe = document.createElement("iframe");
              iframe.src = o.src;
              iframe.style.border = "0";
              iframe.style.width  = o.width  || "420px";
              iframe.style.height = o.height || "320px";
              iframe.style.background = "transparent";
              iframe.allow = "autoplay";
              el.appendChild(iframe);
              // Drop our default panel chrome on iframe overlays —
              // the widget brings its own background/border.
              el.style.background = "transparent";
              el.style.border = "0";
              el.style.padding = "0";
            } else if (o.type === "html" && o.html) {
              el.innerHTML = o.html;
            } else {
              el.textContent = o.text || "";
            }

            container.appendChild(el);
          }

          document.body.appendChild(container);
        },
        { containerId: OVERLAY_CONTAINER_ID, overlays }
      );
    } catch (err) {
      // Page navigation can race overlay injection; that's fine.
      this.logger.debug({ err }, "overlay injection skipped");
    }
  }

  _scheduleReconnect() {
    if (!this.shouldRun || this.restartTimer) return;
    const delay = this.config.runtime.reconnectDelayMs;
    this.logger.warn({ delayMs: delay }, "scheduling reconnect");
    this._setState("reconnecting");

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      await this._teardown();
      if (!this.shouldRun) return;
      try {
        await this._runOnce();
        this.startedAt = Date.now();
        this._setState("running");
      } catch (err) {
        this.logger.error({ err }, "reconnect failed");
        this.error = err.message;
        this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Create the shared audio FIFO if it doesn't already exist.
   * Both this container and the web container have the same
   * `cachestream-audio` volume mounted, so writing to one side
   * and reading from the other works without networking.
   */
  /**
   * Spawn an FFmpeg that pushes a VOD source straight to RTMP.
   *
   * For local files we transmux+re-encode to Twitch's expected H.264
   * @ yuv420p / AAC settings. We don't pass-through copy even when
   * the source codec matches, because Twitch is picky about GOP
   * structure / keyframe cadence and a stale source can drop the
   * stream after a few seconds. The CPU cost is dominated by the
   * x264 encode, same as the screencast pipeline.
   */
  _spawnVodFfmpeg(source) {
    const { video, audio, twitch } = this.config;
    const rtmpUrl = `${twitch.ingestUrl}/${twitch.streamKey}`;
    const inputArgs = source.loop
      ? ["-stream_loop", "-1", "-re", "-i", source.pathOrUrl]
      : ["-re", "-i", source.pathOrUrl];

    const args = [
      "-hide_banner", "-loglevel", "warning", "-nostats",
      ...inputArgs,
      // Video: normalise to the configured output spec
      "-vf", `fps=${video.fps},scale=${video.width}:${video.height}:flags=bilinear,format=yuv420p`,
      // Codec-specific flags (libx264 / h264_nvenc / h264_v4l2m2m / …)
      ...buildVideoCodecArgs(video),
      // Audio: re-encode to AAC at the configured bitrate. If the
      // source has no audio FFmpeg emits a warning but the stream
      // works; Twitch is fine with `-c:a aac -b:a 128k` always set.
      "-c:a", "aac",
      "-b:a", `${audio.bitrateKbps}k`,
      "-ar", "44100",
      "-ac", "2",
      // Output
      "-f", "flv",
      "-rtmp_live", "live",
      "-flvflags", "no_duration_filesize",
      // Some hosts (notably ones where IPv6 is advertised first
      // but Twitch's IPv6 RTMP edge has flaky routing — common
      // on residential ISPs) hang silently on the handshake.
      // A short rw_timeout makes FFmpeg give up and the streamer
      // schedule a reconnect that may land on IPv4 next.
      "-rw_timeout", "15000000",   // µs — 15 s
      "-timeout",   "15000000",
      rtmpUrl,
    ];

    this.logger.info({ name: source.name, kind: source.kind, loop: !!source.loop },
                     "vod ffmpeg starting");
    this.vodFfmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    const vodStreamKey = this.config.twitch.streamKey || "";
    const vodRedact = (s) => vodStreamKey ? s.split(vodStreamKey).join("***") : s;
    this.vodFfmpeg.stderr.on("data", (chunk) => {
      const line = vodRedact(chunk.toString().trim());
      if (!line) return;
      if (/error|failed|cannot|invalid/i.test(line)) {
        this.logger.warn({ ffmpeg: line }, "vod ffmpeg");
      } else {
        this.logger.debug({ ffmpeg: line }, "vod ffmpeg");
      }
    });

    this.vodFfmpeg.on("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "vod ffmpeg exited");
      const wasActive = !!this.vod;
      this.vodFfmpeg = null;
      // Natural EOF on a non-loop source → return to idle.
      if (wasActive && code === 0) {
        this.vod = null;
        this.startedAt = null;
        this.vodStartedAt = null;
        this._setState("idle");
      }
    });
  }

  /**
   * Ensure both audio FIFOs exist as actual FIFOs (not regular
   * files). Called once before spawning the main FFmpeg.
   *
   *   silence.fifo — always-on carrier (web container writes silent PCM)
   *   music.fifo   — real music (web container writes only while playing)
   *
   * Idempotent. Survives container restarts because the FIFO dir
   * is on a docker volume shared with the web container.
   */
  _ensureAudioFifos() {
    const path = require("node:path");
    const fifos = [
      process.env.SILENCE_FIFO_PATH || "/app/audio/silence.fifo",
      process.env.MUSIC_FIFO_PATH   || "/app/audio/music.fifo",
    ];
    for (const fifo of fifos) {
      // If the FIFO exists, leave it alone — but make sure it's
      // world-writable so the web container's user (different UID
      // than ours) can also open it for writing. v1.6 shipped with
      // mkfifo's default 0644 which silently broke music: the
      // streamer (creator) could read+write but the web container
      // (writer) got EACCES on open. Always re-chmod here so a
      // stale FIFO from an older deploy gets fixed.
      try {
        const stat = fs.statSync(fifo);
        if (stat.isFIFO()) {
          try { fs.chmodSync(fifo, 0o666); } catch {}
          continue;
        }
        // Path exists but isn't a FIFO — replace it.
        fs.unlinkSync(fifo);
      } catch (err) {
        if (err.code !== "ENOENT") {
          this.logger.warn({ err, fifo }, "audio fifo stat failed");
        }
      }
      try {
        fs.mkdirSync(path.dirname(fifo), { recursive: true });
      } catch {}
      // mkfifo -m 666 → world rw, no execute (FIFOs don't need it).
      // Honours umask, so we follow up with an explicit chmod.
      const r = spawnSync("mkfifo", ["-m", "666", fifo]);
      if (r.status !== 0) {
        this.logger.warn({ fifo, stderr: r.stderr?.toString() }, "mkfifo failed");
        continue;
      }
      try { fs.chmodSync(fifo, 0o666); } catch {}
    }
  }

  async _teardown() {
    if (this.client) {
      try { await this.client.send("Page.stopScreencast"); } catch {}
      try { await this.client.detach(); } catch {}
      this.client = null;
    }
    if (this.ffmpeg) {
      const proc = this.ffmpeg;
      this.ffmpeg = null;
      try { proc.stdin.end(); } catch {}
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3_000);
        proc.once("exit", () => { clearTimeout(killTimer); resolve(); });
        try { proc.kill("SIGTERM"); } catch { resolve(); }
      });
    }
    if (this.page) {
      try { await this.page.close({ runBeforeUnload: false }); } catch {}
      this.page = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
    }
  }
}

module.exports = { Streamer };
