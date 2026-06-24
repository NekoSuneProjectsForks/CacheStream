"use client";

import { useEffect, useRef, useState } from "react";
import ClientSceneOverlays from "../_shared/ClientSceneOverlays";
import {
  VISUALIZER_DEFAULTS,
  type VisualizerConfig,
} from "@/lib/visualizer-config";

/**
 * Music scene — radio-station style display for the broadcast.
 *
 * Pulls the currently-playing track from /api/music/now every
 * second. When the trackId changes, it fetches the same file
 * via /api/music/file/:id, pipes it into a Web Audio
 * AnalyserNode, and draws the spectrum to a <canvas>.
 *
 * The spectrum LAYOUT is operator-configurable from the Music tab
 * (bars / mirror / circular / waveform) and polled live from
 * /api/music/visualizer, so changing it applies to the running
 * scene without a reload.
 *
 * The actual broadcast audio comes from the music engine's
 * FFmpeg → FIFO pipeline; this scene is purely visual. The
 * Web Audio analysis tracks within ~200ms of the streamed
 * audio because both start playback at the same wall clock.
 *
 * For radio mode (no trackId, just a URL) we fall back to a
 * procedural pseudo-visualizer because CORS will usually block
 * us from analysing the Shoutcast/Icecast stream directly.
 *
 * ── Performance (v1.18) ─────────────────────────────────────
 * The visualiser used to drop the host GPU's framerate (visible
 * in games running alongside the desktop app). Three per-frame
 * costs were to blame and are now removed:
 *   1. `canvas.width = …` was reassigned EVERY frame — that
 *      reallocates the GPU backing store + clears it. We now only
 *      resize when the element's box actually changes.
 *   2. A CSS `filter: drop-shadow()` on the canvas re-ran a
 *      gaussian blur on the GPU every time the canvas repainted.
 *      Replaced with a static box-shadow on the wrapper (composited
 *      once, independent of canvas content).
 *   3. The bar gradient + analysis buffers were rebuilt/allocated
 *      every frame. Both are now cached and only rebuilt on resize.
 * Combined with a configurable fps cap (default 30, can drop to
 * 15 from the panel) this keeps the host GPU free for games.
 */

interface NowPlaying {
  trackId?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationS?: number | null;
  url?: string;
  startedAt?: number;
}

const POLL_MS = 1000;
const CONFIG_POLL_MS = 5000;
// Cap the backing-store DPR. On a 2x display the captured scene
// gains nothing visible from a 4K canvas but pays 4x the fill cost.
const MAX_DPR = 1.5;

type Mode = "idle" | "library" | "radio";

export default function MusicScene() {
  const [mode, setMode] = useState<Mode>("idle");
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [cfg, setCfg] = useState<VisualizerConfig>(VISUALIZER_DEFAULTS);

  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const canvasRef   = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const ctxRef      = useRef<AudioContext | null>(null);
  const sourceRef   = useRef<MediaElementAudioSourceNode | null>(null);
  const lastTrackId = useRef<string | null>(null);

  // Reused analysis buffers (allocated once when the analyser is
  // created) so the render loop never allocates.
  const freqBuf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const timeBuf = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // Beat-reactive FX (flash + shake). Driven imperatively from the
  // render loop via these element refs so we never re-render React at
  // frame rate. `beat` holds the decaying flash/shake envelopes.
  const stageElRef = useRef<HTMLElement | null>(null);
  const flashElRef = useRef<HTMLDivElement | null>(null);
  const shockElRef = useRef<HTMLDivElement | null>(null);
  const beat = useRef({ env: 0, flash: 0, shake: 0, prevFlash: 0 });

  // Latest broadcast start time (for keeping the analysis audio in sync).
  const liveRef = useRef<{ startedAt?: number }>({});

  // ---- Poll now-playing ------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/music/now", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        setMode(data.mode);
        setNow(data.nowPlaying);
        liveRef.current = { startedAt: data.nowPlaying?.startedAt };
      } catch {}
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ---- Keep the analysis audio in sync with the broadcast ----------
  // Both play at 1× from the same wall-clock start, but clock drift (or a
  // mid-track scene reload) can pull them apart. Re-seek to the live
  // position whenever drift exceeds ~1.5s.
  useEffect(() => {
    const id = setInterval(() => {
      const a = audioRef.current;
      if (a && a.src && !a.paused) syncAudioToLive(a, liveRef.current.startedAt);
    }, 8000);
    return () => clearInterval(id);
  }, []);

  // ---- Poll visualizer config (live, applies without reload) -----
  useEffect(() => {
    let cancelled = false;
    let lastJson = "";
    const tick = async () => {
      try {
        const r = await fetch("/api/music/visualizer", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || !data.visualizer) return;
        const json = JSON.stringify(data.visualizer);
        if (json === lastJson) return;   // unchanged — don't churn the render loop
        lastJson = json;
        setCfg(data.visualizer);
      } catch {}
    };
    tick();
    const id = setInterval(tick, CONFIG_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ---- Hook AnalyserNode to the <audio> element ------------------
  //
  // Chromium's --autoplay-policy=no-user-gesture-required (set by
  // the streamer's puppeteer launch) lets us start the AudioContext
  // and play() immediately without a synthetic click.
  //
  // Two non-obvious things had to be fixed in this routine to make
  // the visualiser actually receive samples:
  //
  // 1. The `<audio>` element MUST NOT have `muted` set. Chromium
  //    short-circuits muted audio elements: it skips decode +
  //    skips delivering samples to the Web Audio graph. We instead
  //    route through a GainNode(0) so the audio is silent at the
  //    output but the analyser still gets samples.
  //
  // 2. A MediaElementAudioSource that's only connected to an
  //    analyser (no path to `destination`) is treated by Chromium
  //    as having no consumer and is silenced internally. Connecting
  //    `gain(0)` -> destination keeps the graph "live" without
  //    actually producing sound out of the scene tab.
  useEffect(() => {
    if (!now?.trackId) return;
    if (lastTrackId.current === now.trackId && audioRef.current?.src) return;
    lastTrackId.current = now.trackId;

    const audio = audioRef.current;
    if (!audio) return;

    audio.crossOrigin = "anonymous";
    audio.src = `/api/music/file/${now.trackId}`;
    audio.muted = false;     // see comment above — must NOT be muted
    audio.volume = 1;        // graph-side; the GainNode(0) silences the output
    audio.play().catch((err) => {
      console.warn("[music scene] audio.play() denied:", err?.message || err);
    });

    // Sync the analysis audio to the BROADCAST position. The music engine
    // streams the track in real time from a known wall-clock start
    // (now.startedAt), but this <audio> always loads from 0:00 — so if the
    // scene (re)loads mid-track, the spectrum could be minutes out of sync
    // with what viewers hear. Seek to the live position once metadata is in;
    // the periodic resync effect corrects any further drift.
    const startedAt = now.startedAt;
    const seekLive = () => syncAudioToLive(audio, startedAt);
    audio.addEventListener("loadedmetadata", seekLive, { once: true });
    audio.addEventListener("canplay", seekLive, { once: true });

    if (!ctxRef.current) {
      const AC = (window.AudioContext || (window as any).webkitAudioContext);
      const ac = new AC();
      const an = ac.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.78;

      const src = ac.createMediaElementSource(audio);
      const sink = ac.createGain();
      // Output is SILENT by default — the broadcast audio comes from the
      // music engine's FFmpeg, and the streamer captures video only, so
      // the scene must never emit sound (no doubling). EXCEPTION: when the
      // scene is opened with ?preview=1 (the Visualizer-tab preview / a
      // dev tab), play the audio audibly so the operator can confirm music
      // is playing. The real streamer URL has no such param → stays silent.
      let previewAudio = false;
      try {
        const p = new URLSearchParams(window.location.search);
        previewAudio = p.get("preview") === "1" || p.get("audio") === "1";
      } catch {}
      sink.gain.value = previewAudio ? 1 : 0;

      src.connect(an);
      src.connect(sink);
      sink.connect(ac.destination);

      if (ac.state === "suspended") ac.resume().catch(() => {});

      ctxRef.current = ac;
      analyserRef.current = an;
      sourceRef.current = src;
      freqBuf.current = new Uint8Array(an.frequencyBinCount);
      timeBuf.current = new Uint8Array(an.fftSize);
    }
  }, [now?.trackId]);

  // ---- Render loop -----------------------------------------------
  //
  // Driven by setInterval at cfg.fps, NOT requestAnimationFrame.
  // rAF is tied to the compositor's vsync; in the desktop app the
  // scene renders in an offscreen BrowserWindow that Chromium treats
  // as hidden — it throttles rAF to a few fps there. A timer fires
  // at a steady rate regardless, giving a real fps spectrum in the
  // captured stream.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    let cssW = 0, cssH = 0;          // last seen CSS box
    let w = 0, h = 0;                // backing-store px
    let barGrad: CanvasGradient | null = null;

    // Resize the backing store ONLY when the box actually changed.
    // Reassigning canvas.width/height also clears it + drops any
    // cached gradient, so we rebuild the gradient here too.
    const resizeIfNeeded = () => {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw === cssW && ch === cssH && barGrad) return;
      cssW = cw; cssH = ch;
      w = canvas.width  = Math.round(cw * dpr);
      h = canvas.height = Math.round(ch * dpr);
      barGrad = ctx.createLinearGradient(0, h, 0, 0);
      barGrad.addColorStop(0, hexA(cfg.accent, 0.95));
      barGrad.addColorStop(0.6, hexA(mix(cfg.accent, cfg.accent2, 0.5), 0.85));
      barGrad.addColorStop(1, hexA(cfg.accent2, 0.85));
    };

    // Seed particles for the circular layout (cheap, persistent).
    const particles = cfg.particles ? seedParticles(48) : [];

    // Scratch canvases for the RGB-split / chromatic-aberration post-pass
    // (only allocated/used when rgbSplit > 0). A true per-channel offset:
    // isolate R/G/B from a snapshot, then recombine additively at offsets.
    const splitBuf = document.createElement("canvas");
    const splitCtx = splitBuf.getContext("2d");
    const chanBuf = document.createElement("canvas");
    const chanCtx = chanBuf.getContext("2d");

    const applyRgbSplit = () => {
      if (!splitCtx || !chanCtx) return;
      if (splitBuf.width !== w || splitBuf.height !== h) {
        splitBuf.width = w; splitBuf.height = h;
        chanBuf.width = w; chanBuf.height = h;
      }
      // Snapshot the rendered spectrum, then clear the visible canvas.
      splitCtx.clearRect(0, 0, w, h);
      splitCtx.drawImage(canvas, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Offset grows with the slider and pulses on the beat.
      const off = cfg.rgbSplit * 14 * dpr * (0.45 + 0.9 * beat.current.flash);
      const channels: Array<[string, number]> = [
        ["#ff0000",  off],   // red shifted right
        ["#00ff00",  0],     // green centred
        ["#0000ff", -off],   // blue shifted left
      ];
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "lighter";   // additive recombine
      for (const [tint, dx] of channels) {
        chanCtx.globalCompositeOperation = "source-over";
        chanCtx.clearRect(0, 0, w, h);
        chanCtx.drawImage(splitBuf, 0, 0);
        chanCtx.globalCompositeOperation = "multiply";  // keep only this channel's colour
        chanCtx.fillStyle = tint;
        chanCtx.fillRect(0, 0, w, h);
        chanCtx.globalCompositeOperation = "destination-in";  // re-mask to original alpha
        chanCtx.drawImage(splitBuf, 0, 0);
        ctx.drawImage(chanBuf, dx, 0);
      }
      ctx.globalCompositeOperation = prev;
    };

    const draw = () => {
      resizeIfNeeded();
      ctx.clearRect(0, 0, w, h);

      const an = analyserRef.current;
      const live = an && mode === "library";

      // Read frequency data at most once per frame; shared by the beat
      // FX and the bar/circular layouts.
      const beatFx = cfg.flash || cfg.shake || cfg.zoomPulse || cfg.shockwave;
      const needFreq = cfg.layout !== "waveform" || beatFx;
      let freqReady = false;
      if (live && freqBuf.current && needFreq) {
        an!.getByteFrequencyData(freqBuf.current);
        freqReady = true;
      }

      // ---- Beat-reactive flash + shake + zoom + shockwave (BASS-driven) ----
      if (beatFx) {
        let bass: number;
        if (freqReady && freqBuf.current) {
          // At fftSize 256 each bin ≈ 172 Hz; bins 0–5 cover the
          // sub-bass/kick band (~0–1 kHz). Peak (not mean) of that band
          // tracks kick/bass hits tightly so the beat fires on the drum.
          let peak = 0;
          const k = Math.min(6, freqBuf.current.length);
          for (let i = 0; i < k; i++) peak = Math.max(peak, freqBuf.current[i]);
          bass = peak / 255;
        } else {
          bass = 0.4 + 0.3 * Math.abs(Math.sin(performance.now() / 340)); // procedural pulse
        }
        stepBeat(beat.current, bass, cfg.beatAccurate);
        // Shockwave: re-trigger the CSS ring on a beat onset (a sharp rise).
        if (cfg.shockwave && shockElRef.current &&
            beat.current.flash > beat.current.prevFlash + 0.25 && beat.current.flash > 0.45) {
          const el = shockElRef.current;
          el.style.animation = "none";
          void el.offsetWidth;        // force reflow → restart keyframes
          el.style.animation = "cs-shock 600ms ease-out";
        }
        beat.current.prevFlash = beat.current.flash;
      } else {
        // Let any residual envelope decay to rest.
        beat.current.flash = 0;
        beat.current.shake = 0;
        beat.current.prevFlash = 0;
      }
      // Always apply: keeps the scrim at its base darkening for text
      // readability even with the beat FX off.
      applyBeatFx(beat.current, cfg, stageElRef.current, flashElRef.current);

      if (cfg.layout === "waveform") {
        let wave: number[];
        if (live && timeBuf.current) {
          an!.getByteTimeDomainData(timeBuf.current);
          wave = Array.from(timeBuf.current, (v) => (v - 128) / 128);
        } else {
          wave = proceduralWave(128);
        }
        drawWaveform(ctx, wave, w, h, cfg);
      } else {
        // Frequency-domain layouts (bars / mirror / trapnation / ncs / monstercat).
        let bars: number[];
        if (freqReady && freqBuf.current) {
          bars = sampleBars(freqBuf.current, cfg.barCount, cfg.sensitivity);
        } else {
          bars = procedural(cfg.barCount);
        }

        switch (cfg.layout) {
          case "trapnation": drawTrapNation(ctx, bars, w, h, dpr, cfg, particles); break;
          case "ncs":        drawNcs(ctx, bars, w, h, dpr, cfg, particles); break;
          case "monstercat": drawMonstercat(ctx, bars, w, h, dpr, cfg, barGrad!); break;
          case "nightcore":  drawNightcore(ctx, bars, w, h, dpr, cfg, barGrad!); break;
          default:           drawBars(ctx, bars, w, h, dpr, cfg, barGrad!);
        }
      }

      // Post: true RGB-split / chromatic aberration on the rendered spectrum.
      if (cfg.rgbSplit > 0) applyRgbSplit();
    };

    const fps = Math.max(10, Math.min(30, cfg.fps || 30));
    const id = setInterval(draw, 1000 / fps);
    draw();
    return () => clearInterval(id);
  }, [mode, cfg]);

  const hasTrack = !!now?.trackId;
  // Cover-art cascade: track cover → broadcaster logo → ♫ placeholder.
  const coverUrl = hasTrack ? `/api/music/cover/${now!.trackId}` : "/api/branding/logo";
  const isCircular = cfg.layout === "trapnation" || cfg.layout === "ncs";

  const badge =
    mode === "radio" ? "ON AIR · RADIO" :
    mode === "library" ? "ON AIR · NOW PLAYING" :
    "ON AIR · SILENCE";
  const title  = now?.title || (mode === "radio" ? "Radio Stream" : "Cache Radio");
  const artist = now?.artist || (mode === "radio"
    ? safeHost(now?.url) : "—");

  const onCoverError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const logoUrl = "/api/branding/logo";
    if (!img.src.endsWith(logoUrl)) { img.src = logoUrl; return; }
    img.style.display = "none";
    (img.nextElementSibling as HTMLElement | null)?.style.removeProperty("display");
  };

  // Custom background (over the default gradient) + a dark scrim that
  // keeps the now-playing text readable over busy images. The scrim
  // doubles as the beat layer: on a bass hit its opacity DIPS so the
  // background flashes into view (instead of an accent-coloured wash).
  // Both sit behind the spectrum/content and shake with the stage.
  const bgCss = (cfg.background || "").trim();
  const stageFx = (
    <>
      {bgCss && (
        <div
          className="custom-bg"
          style={{
            backgroundImage: `url("${bgCss.replace(/["\\]/g, "")}")`,
            backgroundSize: cfg.bgFit === "tile" ? "auto" : cfg.bgFit,
            backgroundRepeat: cfg.bgFit === "tile" ? "repeat" : "no-repeat",
            filter: cfg.bgBlur ? `blur(${cfg.bgBlur}px)` : undefined,
            // slight upscale so blur never bleeds the page edges
            transform: cfg.bgBlur ? "scale(1.08)" : undefined,
          }}
        />
      )}
      <div className="bg-scrim" ref={flashElRef} />
    </>
  );

  return (
    <>
      {/* dangerouslySetInnerHTML (not a text child) so React doesn't
          HTML-escape the quotes inside the CSS — escaping happens only
          on the server render and produced a hydration text mismatch. */}
      <style dangerouslySetInnerHTML={{ __html: baseCss }} />
      <style dangerouslySetInnerHTML={{ __html:
        `.stage{--accent:${cfg.accent};--accent2:${cfg.accent2};}` +
        (cfg.bloom > 0
          ? `.stage canvas{filter:drop-shadow(0 0 ${Math.round(cfg.bloom * 22)}px ${cfg.accent});}`
          : "")
      }} />

      {/* ONE stable <main> + <audio>. Only the inner content swaps when
          the layout changes — the audio element and its Web Audio graph
          (MediaElementSource → analyser) MUST NOT be unmounted on a layout
          switch, or the analyser detaches (spectrum freezes) and playback
          is disrupted. So the audio + bg/flash live outside the branch. */}
      <main
        className={`stage${isCircular ? " stage-circular" : ""}${cfg.layout === "ncs" ? " stage-ncs" : ""}${cfg.hueCycle ? " hue" : ""}`}
        ref={stageElRef}
      >
        {stageFx}

        {isCircular ? (
          /* ---------- Circular / radial (Trap Nation / NCS) ---------- */
          <>
            {/* Cover ring is pinned to the viewport centre so it stays
                concentric with the radial spectrum (canvas w/2, h/2). */}
            <canvas ref={canvasRef} className="vis-full" />
            {/* Trap Nation keeps the cover in the ring centre; NCS is the
                bare wireframe sphere (no centre cover). */}
            {cfg.layout === "trapnation" && (
              <div className="circ-cover-ring">
                <img className="circ-cover" src={coverUrl} alt="" onError={onCoverError} />
                <div className="circ-cover-ph" style={{ display: "none" }}>♫</div>
              </div>
            )}
            <div className="circ-meta">
              <span className="badge"><span className="pulse" />{badge}</span>
              <div className="circ-title">{title}</div>
              <div className="circ-artist">{artist}</div>
              {now?.album && <div className="circ-album">{now.album}</div>}
            </div>
            <span className="station">CacheStream · 91.7 FM</span>
            <Clock />
          </>
        ) : (
          /* ---------- Bars / mirror / waveform / monstercat ---------- */
          <>
            <div className="top">
              <div className="cover-wrap">
                {cfg.showVinyl && <div className="vinyl" />}
                <img className="cover" src={coverUrl} alt="" onError={onCoverError} />
                <div className="cover-placeholder" style={{ display: "none", position: "absolute", inset: 0 }}>♫</div>
              </div>

              <div className="meta">
                <span className="badge"><span className="pulse" />{badge}</span>
                <div className="title">{title}</div>
                <div className="artist">{artist}</div>
                {now?.album && <div className="album">{now.album}</div>}
              </div>
            </div>

            <div className="vis-wrap">
              <span className="station">CacheStream  ·  91.7 FM</span>
              <canvas ref={canvasRef} />
              <Clock />
            </div>
          </>
        )}

        {cfg.shockwave && <div className="shockwave" ref={shockElRef} />}
        {cfg.grain && <div className="grain" />}
        {cfg.scanlines && <div className="scanlines" />}
        {cfg.vignette && <div className="vignette" />}
        <audio ref={audioRef} muted playsInline preload="auto" crossOrigin="anonymous" />
      </main>

      {/* hideNowPlaying — the music scene IS the now-playing display. */}
      <ClientSceneOverlays hideNowPlaying />
    </>
  );
}

function Clock() {
  const [t, setT] = useState("");
  useEffect(() => {
    const tick = () => setT(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="clock">{t}</span>;
}

/** Seek the analysis <audio> to the broadcast's live position (derived from
 *  the engine's wall-clock track start), if it has drifted by >1.5s. */
function syncAudioToLive(audio: HTMLAudioElement, startedAt?: number) {
  if (!startedAt || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const live = (Date.now() - startedAt) / 1000;
  if (live < 1) return;
  const target = Math.min(live, audio.duration - 0.3);
  if (target > 0 && Math.abs(audio.currentTime - target) > 1.5) {
    try { audio.currentTime = target; } catch {}
  }
}

function safeHost(url?: string): string {
  if (!url) return "—";
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "—"; }
}

// ===== Color helpers =============================================

/** "#rrggbb" + alpha → "rgba(r,g,b,a)". */
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

/** Linear blend of two hex colours → "#rrggbb". */
function mix(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const ar = (na >> 16) & 255, ag = (na >> 8) & 255, ab = na & 255;
  const br = (nb >> 16) & 255, bg = (nb >> 8) & 255, bb = nb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

// ===== Data helpers ==============================================

function sampleBars(data: Uint8Array, n: number, sensitivity: number): number[] {
  const step = Math.max(1, Math.floor(data.length / n));
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += data[i * step + j] || 0;
    bars.push(Math.min(1, (sum / step / 255) * sensitivity));
  }
  return bars;
}

/** Moving-average smooth (window = 2*radius+1) for the soft NCS/Trap look. */
function smoothArray(arr: number[], radius: number): number[] {
  if (radius <= 0) return arr;
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = -radius; j <= radius; j++) {
      const k = i + j;
      if (k >= 0 && k < n) { sum += arr[k]; cnt++; }
    }
    out[i] = sum / cnt;
  }
  return out;
}

function procedural(n: number): number[] {
  const t = performance.now() / 600;
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = 0.32 + 0.14 * Math.sin(t + i * 0.18);
    const wob  = 0.18 * Math.sin(t * 1.7 + i * 0.43);
    bars.push(Math.max(0.05, base + wob));
  }
  return bars;
}

function proceduralWave(n: number): number[] {
  const t = performance.now() / 400;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / n;
    out.push(0.35 * Math.sin(t + x * Math.PI * 6) * (0.6 + 0.4 * Math.sin(t * 0.7 + x * 3)));
  }
  return out;
}

interface BeatState { env: number; flash: number; shake: number; }

// How far the scrim lifts on a beat + max shake. Kept LIGHT on purpose:
// the background brightens a little on every bass hit rather than a deep,
// strobe-like flash (gentler / less photosensitive). The resting scrim
// darkness is cfg.bgDim and both are scaled by cfg.beatIntensity.
const SCRIM_DIP = 0.20;    // how much it lifts at a full beat
const SHAKE_PX = 5;        // max shake offset (px) — subtle

/**
 * Advance the beat envelope from the current bass level. Fires on every
 * bass hit (low threshold) but each pulse is modest and decays quickly,
 * so the FX happen often without being intense.
 */
function stepBeat(b: BeatState, bass: number, accurate: boolean) {
  b.env = b.env * 0.92 + bass * 0.08;
  if (accurate) {
    // Proportional: track the bass depth with a fast attack + slow release
    // so a DEEP drop drives a big flash/shake and quiet parts barely move.
    // `drop` also emphasises sudden rises above the moving average (onsets).
    const floor = 0.18;
    const lvl = Math.max(0, (bass - floor) / (1 - floor));        // 0..1
    const drop = Math.min(1, Math.max(lvl, Math.max(0, bass - b.env) * 2));
    if (drop > b.flash) { b.flash = drop; b.shake = drop; }       // fast attack
    else { b.flash *= 0.86; b.shake *= 0.84; }                    // slow release
  } else {
    const isBeat = bass > b.env * 1.15 && bass > 0.22;
    if (isBeat) { b.flash = 1; b.shake = 1; }
    b.flash *= 0.82;
    b.shake *= 0.80;
  }
}

/** Apply the decaying beat envelope: light shake + a scrim that lifts to
 *  flash the background into view. The scrim always holds its base
 *  darkening so text stays readable when the FX are off. */
function applyBeatFx(
  b: BeatState,
  cfg: VisualizerConfig,
  stageEl: HTMLElement | null,
  scrimEl: HTMLDivElement | null,
) {
  if ((cfg.shake || cfg.zoomPulse) && stageEl) {
    // Combine shake (jitter) + zoom-pulse (beat "breathing") into one
    // transform. Both use the decaying beat envelope; a small base scale
    // keeps the shake from revealing the page edges.
    const zoom = cfg.zoomPulse ? b.flash * 0.06 * cfg.beatIntensity : 0;
    const scale = (cfg.shake ? 1.02 : 1) + zoom;
    let tr = "";
    if (cfg.shake) {
      const m = b.shake * SHAKE_PX * cfg.beatIntensity;
      tr = ` translate(${((Math.random() * 2 - 1) * m).toFixed(1)}px, ${((Math.random() * 2 - 1) * m).toFixed(1)}px)`;
    }
    stageEl.style.transform = `scale(${scale.toFixed(3)})${tr}`;
  } else if (stageEl && stageEl.style.transform) {
    stageEl.style.transform = "";
  }
  if (scrimEl) {
    const base = cfg.bgDim;
    const op = cfg.flash
      ? Math.max(0.04, base - b.flash * SCRIM_DIP * cfg.beatIntensity)
      : base;
    scrimEl.style.opacity = op.toFixed(3);
  }
}

interface Particle { x: number; y: number; vy: number; r: number; a: number; }
function seedParticles(n: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: Math.random(), y: Math.random(),
      vy: 0.0006 + Math.random() * 0.0016,
      r: 0.5 + Math.random() * 1.8,
      a: 0.15 + Math.random() * 0.4,
    });
  }
  return out;
}

// ===== Renderers =================================================

function drawBars(
  ctx: CanvasRenderingContext2D,
  bars: number[],
  w: number, h: number, dpr: number,
  cfg: VisualizerConfig,
  grad: CanvasGradient,
) {
  const gap = 4 * dpr;
  const barW = (w - gap * (bars.length - 1)) / bars.length;
  ctx.fillStyle = grad;

  if (cfg.layout === "mirror") {
    // Bars grow up AND down from the vertical centre.
    const mid = h / 2;
    for (let i = 0; i < bars.length; i++) {
      const barH = Math.max(2, bars[i] * h * 0.5);
      const x = i * (barW + gap);
      ctx.fillRect(x, mid - barH, barW, barH);
      ctx.globalAlpha = 0.4;
      ctx.fillRect(x, mid, barW, barH);
      ctx.globalAlpha = 1;
    }
    return;
  }

  // Standard bottom-anchored bars.
  for (let i = 0; i < bars.length; i++) {
    const barH = Math.max(2, bars[i] * h);
    const x = i * (barW + gap);
    ctx.fillRect(x, h - barH, barW, barH);
  }

  if (cfg.mirror) {
    ctx.globalAlpha = 0.18;
    ctx.scale(1, -1);
    for (let i = 0; i < bars.length; i++) {
      const barH = Math.max(2, bars[i] * h);
      const x = i * (barW + gap);
      ctx.fillRect(x, -h - barH * 0.7, barW, barH * 0.7);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  wave: number[],
  w: number, h: number,
  cfg: VisualizerConfig,
) {
  const mid = h / 2;
  const amp = h * 0.42;
  ctx.lineWidth = Math.max(2, h * 0.012);
  ctx.lineJoin = "round";
  ctx.strokeStyle = hexA(cfg.accent, 0.95);
  ctx.beginPath();
  for (let i = 0; i < wave.length; i++) {
    const x = (i / (wave.length - 1)) * w;
    const y = mid - wave[i] * amp;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Soft secondary echo line.
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = hexA(cfg.accent2, 0.9);
  ctx.beginPath();
  for (let i = 0; i < wave.length; i++) {
    const x = (i / (wave.length - 1)) * w;
    const y = mid + wave[i] * amp * 0.7;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Shared: drifting particles + a level-reactive centre glow. */
function drawCircBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number, h: number, dpr: number,
  cx: number, cy: number, baseR: number, level: number,
  cfg: VisualizerConfig, particles: Particle[],
) {
  if (particles.length) {
    ctx.fillStyle = hexA(cfg.accent, 1);
    for (const p of particles) {
      p.y -= p.vy;
      if (p.y < 0) { p.y = 1; p.x = Math.random(); }
      ctx.globalAlpha = p.a * (0.5 + level);
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, p.r * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  const glowR = baseR * (1.2 + level * 0.6);
  const glow = ctx.createRadialGradient(cx, cy, baseR * 0.4, cx, cy, glowR);
  glow.addColorStop(0, hexA(cfg.accent, 0.0));
  glow.addColorStop(0.7, hexA(cfg.accent, 0.10 + level * 0.20));
  glow.addColorStop(1, hexA(cfg.accent2, 0.0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Trap Nation style — a smooth, mirror-symmetric radial waveform that
 * forms a continuous luminous "blob" around the cover, filled with a
 * translucent gradient and a bright glowing edge. The base radius
 * pulses gently with the overall level (bass response).
 */
function drawTrapNation(
  ctx: CanvasRenderingContext2D,
  bars: number[],
  w: number, h: number, dpr: number,
  cfg: VisualizerConfig,
  particles: Particle[],
) {
  const cx = w / 2, cy = h / 2;
  const level = bars.reduce((s, v) => s + v, 0) / bars.length;
  const baseR = Math.min(w, h) * 0.22 * (1 + level * 0.12);  // stronger bass pulse
  const maxLen = Math.min(w, h) * 0.22;
  // cloudnation's signature is a SMOOTH blob, so average neighbouring
  // bins before mapping them to radii (kills per-bar spikes).
  const sm = smoothArray(bars, 1);
  const n = sm.length;
  const rot = (performance.now() / 1000) * 0.04;   // slow spin

  drawCircBackdrop(ctx, w, h, dpr, cx, cy, baseR, level, cfg, particles);

  // Symmetric value lookup: angle position 0..1 maps to a mirrored
  // sweep over the bins (top = bin 0, fanning both ways), so the curve
  // is left/right symmetric like the Trap Nation visualiser.
  const valAt = (t: number): number => {
    const x = t < 0.5 ? t * 2 : (1 - t) * 2;   // 0→1→0
    const fi = x * (n - 1);
    const i0 = Math.floor(fi);
    const i1 = Math.min(n - 1, i0 + 1);
    const f = fi - i0;
    return sm[i0] * (1 - f) + sm[i1] * f;
  };

  const STEPS = 220;   // smooth closed curve
  ctx.beginPath();
  for (let s = 0; s <= STEPS; s++) {
    const t = s / STEPS;
    const ang = -Math.PI / 2 + (t + rot) * Math.PI * 2;
    const r = baseR + valAt(t) * maxLen;
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();

  const fill = ctx.createRadialGradient(cx, cy, baseR, cx, cy, baseR + maxLen);
  fill.addColorStop(0, hexA(cfg.accent, 0.32));
  fill.addColorStop(1, hexA(cfg.accent2, 0.06));
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.lineJoin = "round";
  // Bloom: wide translucent passes under the crisp edge for the
  // signature Trap Nation glow.
  ctx.lineWidth = 14 * dpr;
  ctx.strokeStyle = hexA(cfg.accent, 0.10);
  ctx.stroke();
  ctx.lineWidth = 7 * dpr;
  ctx.strokeStyle = hexA(cfg.accent, 0.18);
  ctx.stroke();
  // Crisp bright edge.
  ctx.lineWidth = Math.max(2, dpr * 2.5);
  ctx.strokeStyle = hexA(cfg.accent, 0.98);
  ctx.stroke();

  // Inner ring outline hugging the cover.
  ctx.lineWidth = dpr * 1.5;
  ctx.strokeStyle = hexA(cfg.accent, 0.4);
  ctx.beginPath();
  ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * NCS style — the "NCS Spectrum" glowing ORB: several smooth, mirror-
 * symmetric circular waveforms layered at slightly different radii and
 * rotation phases, additively blended (globalCompositeOperation
 * "lighter") so overlaps build a luminous translucent sphere with depth.
 * Heavy bloom, no centre cover — the orb is the centrepiece. Matches the
 * Roonil/NCS_Spectrum_GLava look (and the NCS sphere video).
 */
function drawNcs(
  ctx: CanvasRenderingContext2D,
  bars: number[],
  w: number, h: number, dpr: number,
  cfg: VisualizerConfig,
  particles: Particle[],
) {
  const cx = w / 2, cy = h / 2;
  const level = bars.reduce((s, v) => s + v, 0) / bars.length;
  const R = Math.min(w, h) * 0.26;
  const sm = smoothArray(bars, 2);   // soft NCS waveform
  const n = sm.length;
  const t = performance.now() / 1000;

  drawCircBackdrop(ctx, w, h, dpr, cx, cy, R, level, cfg, particles);

  // Mirror-symmetric value lookup with a rotation phase (so each layer
  // spins independently → shimmering orb).
  const valAt = (k: number, phase: number): number => {
    let p = k + phase;
    p -= Math.floor(p);                       // wrap 0..1
    const x = p < 0.5 ? p * 2 : (1 - p) * 2;  // 0→1→0 (symmetric)
    const fi = x * (n - 1);
    const i0 = Math.floor(fi);
    const i1 = Math.min(n - 1, i0 + 1);
    const f = fi - i0;
    return sm[i0] * (1 - f) + sm[i1] * f;
  };
  const STEPS = 200;
  const trace = (rBase: number, amp: number, phase: number) => {
    ctx.beginPath();
    for (let s = 0; s <= STEPS; s++) {
      const k = s / STEPS;
      const ang = -Math.PI / 2 + k * Math.PI * 2;
      const r = rBase + valAt(k, phase) * amp;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };

  // Soft orb body.
  const body = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.1);
  body.addColorStop(0, hexA(cfg.accent, 0.04 + level * 0.05));
  body.addColorStop(1, hexA(cfg.accent, 0));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.1, 0, Math.PI * 2);
  ctx.fill();

  // Additive layered flowing waveforms = glowing translucent sphere.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";
  const layers = 5;
  const amp = Math.min(w, h) * 0.075;
  for (let l = 0; l < layers; l++) {
    const phase = t * (0.06 + 0.03 * l) + l * 0.37;
    const rBase = R * (0.80 + 0.05 * l);
    const col = hexA(mix(cfg.accent, cfg.accent2, l / (layers - 1)), 0.16 + level * 0.10);
    trace(rBase, amp * (1 - l * 0.08), phase);
    ctx.lineWidth = (1.5 + l * 0.6) * dpr;
    ctx.strokeStyle = col;
    ctx.stroke();
  }
  // Bright crisp reactive rim on top.
  trace(R, amp * 1.15, t * 0.05);
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = hexA(cfg.accent, 0.85);
  ctx.stroke();
  ctx.restore();
}

/**
 * Monstercat style — full-width bottom bars with rounded tops, even
 * spacing, a smooth vertical gradient and a glowing baseline. No
 * reflection (kept clean).
 */
function drawMonstercat(
  ctx: CanvasRenderingContext2D,
  bars: number[],
  w: number, h: number, dpr: number,
  cfg: VisualizerConfig,
  grad: CanvasGradient,
) {
  const gap = 3 * dpr;
  const barW = (w - gap * (bars.length - 1)) / bars.length;
  const radius = Math.min(barW / 2, 6 * dpr);
  ctx.fillStyle = grad;
  for (let i = 0; i < bars.length; i++) {
    const barH = Math.max(2, bars[i] * h * 0.92);
    const x = i * (barW + gap);
    const y = h - barH;
    roundedTopRect(ctx, x, y, barW, barH, radius);
  }
  // Glowing baseline.
  ctx.fillStyle = hexA(cfg.accent, 0.55);
  ctx.fillRect(0, h - 2 * dpr, w, 2 * dpr);
}

/**
 * Nightcore style — a smooth, bottom-anchored FILLED area spectrum (a
 * flowing "mountain range" silhouette) with a bright glowing top edge and
 * a soft reflection. Generic best-effort; refine against a vizzy export.
 */
function drawNightcore(
  ctx: CanvasRenderingContext2D,
  bars: number[],
  w: number, h: number, dpr: number,
  cfg: VisualizerConfig,
  grad: CanvasGradient,
) {
  const sm = smoothArray(bars, 1);
  const n = sm.length;
  const pt = (i: number) => ({
    x: (i / (n - 1)) * w,
    y: h - Math.max(2, sm[i] * h * 0.95),
  });

  // Smooth top curve via quadratic segments through the midpoints.
  const traceTop = () => {
    const p0 = pt(0);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < n; i++) {
      const a = pt(i - 1), b = pt(i);
      ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const last = pt(n - 1);
    ctx.lineTo(last.x, last.y);
  };

  // Filled body.
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(pt(0).x, pt(0).y);
  for (let i = 1; i < n; i++) {
    const a = pt(i - 1), b = pt(i);
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.8;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Bright glowing top edge.
  ctx.beginPath();
  traceTop();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, dpr * 2.2);
  ctx.strokeStyle = hexA(cfg.accent, 0.95);
  ctx.stroke();
}

/** Rect with rounded top corners only (uses roundRect when available). */
function roundedTopRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  const rr = Math.min(r, w / 2, h);
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === "function") {
    (ctx as any).roundRect(x, y, w, h, [rr, rr, 0, 0]);
  } else {
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }
  ctx.fill();
}

// ===== Static CSS ================================================
// No per-frame `filter:` anywhere — glow is static box-shadow only.

const baseCss = `
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: #04050a; color: #e6f7ff;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  }
  .stage {
    position: relative;
    width: 100vw; height: 100vh;
    display: grid;
    grid-template-rows: 1fr auto;
    background:
      radial-gradient(circle at 20% 30%, rgba(0,240,255,0.10), transparent 50%),
      radial-gradient(circle at 80% 70%, rgba(255,43,214,0.10), transparent 55%),
      radial-gradient(circle at 50% 100%, rgba(138,43,255,0.12), transparent 60%),
      #04050a;
  }
  .stage::before {
    content: "";
    position: absolute; inset: 0;
    background-image:
      repeating-linear-gradient(0deg, rgba(0,240,255,0.025) 0 1px, transparent 1px 4px);
    mix-blend-mode: overlay;
    pointer-events: none;
  }
  .top {
    display: grid;
    grid-template-columns: 480px 1fr;
    gap: 64px;
    align-items: center;
    padding: 64px 80px;
    min-height: 0;
  }
  @media (max-width: 1100px) {
    .top { grid-template-columns: 1fr; padding: 48px; gap: 28px; }
  }

  /* ----- Cover art ----- */
  .cover-wrap { position: relative; width: 480px; height: 480px; max-width: 100%; }
  .cover {
    width: 100%; height: 100%;
    border-radius: 8px;
    background: linear-gradient(135deg, rgba(0,240,255,0.18), rgba(138,43,255,0.18));
    border: 1px solid rgba(0,240,255,0.30);
    object-fit: cover;
    box-shadow:
      0 0 0 1px rgba(0,240,255,0.05) inset,
      0 0 80px rgba(0,240,255,0.20),
      0 0 160px rgba(138,43,255,0.18);
  }
  .cover-placeholder {
    width: 100%; height: 100%;
    border-radius: 8px;
    background:
      radial-gradient(circle at 50% 50%, rgba(0,240,255,0.18), rgba(5,6,10,0.95)),
      repeating-linear-gradient(45deg, rgba(0,240,255,0.04) 0 12px, transparent 12px 24px);
    border: 1px dashed rgba(0,240,255,0.35);
    display: flex; align-items: center; justify-content: center;
    font-size: 96px; color: rgba(0,240,255,0.55);
    text-shadow: 0 0 18px rgba(0,240,255,0.4);
  }
  .vinyl {
    position: absolute; top: 50%; right: -120px;
    width: 360px; height: 360px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 50% 50%, #131722 0 50px, #06080f 51px 56px,
        #131722 57px 80px, #06080f 81px 84px,
        #131722 85px 130px, #06080f 131px 134px,
        #131722 135px 175px, #06080f 176px 180px);
    border: 1px solid rgba(0,240,255,0.25);
    transform: translateY(-50%);
    animation: spin 18s linear infinite;
    opacity: 0.7;
    box-shadow: 0 0 60px rgba(0,0,0,0.6);
    z-index: -1;
  }
  @keyframes spin { from { transform: translateY(-50%) rotate(0); } to { transform: translateY(-50%) rotate(360deg); } }

  /* ----- Track metadata ----- */
  .meta { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .badge {
    font-size: 12px; letter-spacing: 0.32em; text-transform: uppercase;
    color: var(--accent, #00f0ff);
    padding: 6px 14px;
    border: 1px solid rgba(0,240,255,0.4);
    border-radius: 999px;
    display: inline-flex; align-items: center; gap: 8px;
    width: fit-content;
    background: rgba(5,6,10,0.55);
  }
  .badge .pulse {
    width: 8px; height: 8px; border-radius: 50%;
    background: #4ade80; box-shadow: 0 0 10px #4ade80;
    animation: blink 1.6s ease-in-out infinite;
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .title {
    font-size: clamp(2.4rem, 4.6vw, 4.4rem);
    font-weight: 800; line-height: 1.1; letter-spacing: -0.01em;
    text-shadow: 0 0 18px rgba(0,240,255,0.45);
    overflow: hidden; text-overflow: ellipsis;
  }
  .artist { font-size: clamp(1.2rem, 2vw, 1.6rem); color: rgba(230,247,255,0.8); letter-spacing: 0.04em; }
  .album { font-size: 0.95rem; color: rgba(230,247,255,0.45); letter-spacing: 0.06em; }

  /* ----- Bars/waveform visualizer ----- */
  .vis-wrap { position: relative; height: 200px; padding: 0 64px 56px; }
  .vis-wrap canvas {
    width: 100%; height: 100%; display: block;
    /* Static box-shadow glow (composited once). NOT a per-frame
       drop-shadow filter — see the perf note at the top of file. */
    filter: none;
  }
  .station {
    position: absolute; bottom: 56px; left: 80px;
    font-size: 10px; letter-spacing: 0.5em; text-transform: uppercase;
    color: rgba(230,247,255,0.35);
  }
  .clock {
    position: absolute; bottom: 56px; right: 80px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; letter-spacing: 0.18em;
    color: rgba(230,247,255,0.45);
  }

  /* ----- Circular (vizzy-style) layout ----- */
  .stage-circular { display: block; }
  .vis-full {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    display: block;
    z-index: 0;
  }
  /* Cover diameter = 2 × the canvas inner-ring radius region. The ring
     is pinned to the viewport centre to stay concentric with the
     radial spectrum (drawn at canvas w/2, h/2). */
  .circ-cover-ring {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: min(26vw, 320px); height: min(26vw, 320px);
    border-radius: 50%;
    padding: 10px;
    z-index: 1; pointer-events: none;
    background: radial-gradient(circle at 50% 50%, rgba(5,6,10,0.2), rgba(5,6,10,0.85));
    box-shadow:
      0 0 0 2px rgba(0,240,255,0.35) inset,
      0 0 60px rgba(0,240,255,0.30),
      0 0 140px rgba(255,43,214,0.18);
  }
  .circ-cover {
    width: 100%; height: 100%;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid rgba(0,240,255,0.3);
  }
  .circ-cover-ph {
    position: absolute; inset: 10px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 80px; color: rgba(0,240,255,0.55);
    background: radial-gradient(circle at 50% 50%, rgba(0,240,255,0.15), rgba(5,6,10,0.95));
  }
  /* Metadata sits below the cover ring (just past its radius) and is
     centred horizontally. Anchored to viewport centre + cover radius so
     it tracks the cover regardless of viewport size. */
  .circ-meta {
    position: absolute;
    left: 50%;
    top: calc(50% + min(13vw, 160px) + 26px);
    transform: translateX(-50%);
    z-index: 2; pointer-events: none;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    text-align: center; max-width: 86vw;
  }
  .circ-meta .badge { margin: 0 auto; }
  .circ-title {
    font-size: clamp(2rem, 4vw, 3.6rem);
    font-weight: 800; letter-spacing: -0.01em;
    text-shadow: 0 0 22px rgba(0,240,255,0.5);
    max-width: 80vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .circ-artist { font-size: clamp(1.1rem, 1.8vw, 1.5rem); color: rgba(230,247,255,0.82); }
  .circ-album { font-size: clamp(1.1rem, 1.8vw, 1.5rem); color: rgba(230,247,255,0.82); }
  .stage-circular .station { bottom: 36px; left: 48px; }
  .stage-circular .clock { bottom: 36px; right: 48px; }

  /* NCS has no centre cover and a big orb, so drop the now-playing text
     to a lower-third so it doesn't sit over the sphere. */
  .stage-ncs .circ-meta {
    top: auto;
    bottom: 8%;
  }

  /* ----- Custom background + beat FX ----- */
  .stage { will-change: transform; }
  /* z-index:-2 sits over the stage's own gradient but behind everything
     else (custom-bg → beat-flash → spectrum/content), so an uploaded
     image becomes the backdrop without covering the spectrum. */
  .custom-bg {
    position: absolute; inset: 0;
    z-index: -2; pointer-events: none;
    background-size: cover; background-position: center; background-repeat: no-repeat;
  }
  /* Dark scrim BEHIND the spectrum + cover + text (z-index:-1, above the
     background) — dims a busy/bright background so the now-playing text
     stays legible. Its opacity is driven in the render loop: it DIPS on
     each beat so the background flashes into view. */
  .bg-scrim {
    position: absolute; inset: 0;
    z-index: -1; pointer-events: none;
    background: #04050a;
    opacity: 0.45;
    transition: opacity 80ms linear;
    will-change: opacity;
  }

  /* ----- vizzy-style post effects ----- */
  .vignette {
    position: absolute; inset: 0;
    z-index: 40; pointer-events: none;
    box-shadow: inset 0 0 min(22vw, 280px) rgba(0,0,0,0.72);
  }
  /* Slow full-scene hue rotation (GPU — continuous filter). */
  .stage.hue { animation: cs-hue 14s linear infinite; }
  @keyframes cs-hue {
    from { filter: hue-rotate(0deg); }
    to   { filter: hue-rotate(360deg); }
  }
  /* Film grain — a tiling SVG noise overlay (static, cheap). */
  .grain {
    position: absolute; inset: 0;
    z-index: 41; pointer-events: none; opacity: 0.06;
    mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 180px 180px;
  }
  /* CRT scanlines — a static repeating gradient overlay (cheap). */
  .scanlines {
    position: absolute; inset: 0;
    z-index: 41; pointer-events: none; opacity: 0.18;
    mix-blend-mode: multiply;
    background-image: repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,0) 0px,
      rgba(0,0,0,0) 2px,
      rgba(0,0,0,0.6) 3px,
      rgba(0,0,0,0.6) 4px
    );
  }
  /* Shockwave — an expanding ring re-triggered on each beat (animation set
     imperatively in the render loop). */
  .shockwave {
    position: absolute; top: 50%; left: 50%;
    width: 40vmin; height: 40vmin; margin: -20vmin 0 0 -20vmin;
    z-index: 39; pointer-events: none; opacity: 0;
    border: 2px solid var(--accent, #00f0ff);
    border-radius: 50%;
  }
  @keyframes cs-shock {
    0%   { opacity: 0.7; transform: scale(0.25); }
    100% { opacity: 0;   transform: scale(2.2); }
  }
`;
