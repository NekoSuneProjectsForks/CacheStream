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
      } catch {}
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
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

    if (!ctxRef.current) {
      const AC = (window.AudioContext || (window as any).webkitAudioContext);
      const ac = new AC();
      const an = ac.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.78;

      const src = ac.createMediaElementSource(audio);
      const sink = ac.createGain();
      sink.gain.value = 0;            // silent output

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

    const draw = () => {
      resizeIfNeeded();
      ctx.clearRect(0, 0, w, h);

      const an = analyserRef.current;
      const live = an && mode === "library";

      if (cfg.layout === "waveform") {
        let wave: number[];
        if (live && timeBuf.current) {
          an!.getByteTimeDomainData(timeBuf.current);
          wave = Array.from(timeBuf.current, (v) => (v - 128) / 128);
        } else {
          wave = proceduralWave(128);
        }
        drawWaveform(ctx, wave, w, h, cfg);
        return;
      }

      // Frequency-domain layouts (bars / mirror / circular).
      let bars: number[];
      if (live && freqBuf.current) {
        an!.getByteFrequencyData(freqBuf.current);
        bars = sampleBars(freqBuf.current, cfg.barCount, cfg.sensitivity);
      } else {
        bars = procedural(cfg.barCount);
      }

      if (cfg.layout === "circular") {
        drawCircular(ctx, bars, w, h, dpr, cfg, particles);
      } else {
        drawBars(ctx, bars, w, h, dpr, cfg, barGrad!);
      }
    };

    const fps = Math.max(10, Math.min(30, cfg.fps || 30));
    const id = setInterval(draw, 1000 / fps);
    draw();
    return () => clearInterval(id);
  }, [mode, cfg]);

  const hasTrack = !!now?.trackId;
  // Cover-art cascade: track cover → broadcaster logo → ♫ placeholder.
  const coverUrl = hasTrack ? `/api/music/cover/${now!.trackId}` : "/api/branding/logo";
  const isCircular = cfg.layout === "circular";

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

  return (
    <>
      <style>{baseCss}</style>
      <style>{`
        .stage {
          --accent: ${cfg.accent};
          --accent2: ${cfg.accent2};
        }
      `}</style>

      {isCircular ? (
        /* ---------- Circular / radial (vizzy-style) ---------- */
        <main className="stage stage-circular">
          <canvas ref={canvasRef} className="vis-full" />
          <div className="circ-center">
            <div className="circ-cover-ring">
              <img className="circ-cover" src={coverUrl} alt="" onError={onCoverError} />
              <div className="circ-cover-ph" style={{ display: "none" }}>♫</div>
            </div>
            <div className="circ-meta">
              <span className="badge"><span className="pulse" />{badge}</span>
              <div className="circ-title">{title}</div>
              <div className="circ-artist">{artist}</div>
              {now?.album && <div className="album">{now.album}</div>}
            </div>
          </div>
          <span className="station">CacheStream · 91.7 FM</span>
          <Clock />
          <audio ref={audioRef} muted playsInline preload="auto" crossOrigin="anonymous" />
        </main>
      ) : (
        /* ---------- Bars / mirror / waveform ---------- */
        <main className="stage">
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

          <audio ref={audioRef} muted playsInline preload="auto" crossOrigin="anonymous" />
        </main>
      )}

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

function drawCircular(
  ctx: CanvasRenderingContext2D,
  bars: number[],
  w: number, h: number, dpr: number,
  cfg: VisualizerConfig,
  particles: Particle[],
) {
  const cx = w / 2, cy = h / 2;
  const baseR = Math.min(w, h) * 0.22;     // inner ring radius
  const maxLen = Math.min(w, h) * 0.20;    // max bar length outward
  const level = bars.reduce((s, v) => s + v, 0) / bars.length;

  // Drifting background particles (cheap; updates in place).
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

  // Pulsing glow ring behind the centre, scaled by overall level.
  const glowR = baseR * (1.15 + level * 0.5);
  const glow = ctx.createRadialGradient(cx, cy, baseR * 0.4, cx, cy, glowR);
  glow.addColorStop(0, hexA(cfg.accent, 0.0));
  glow.addColorStop(0.7, hexA(cfg.accent, 0.10 + level * 0.18));
  glow.addColorStop(1, hexA(cfg.accent2, 0.0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();

  // Radial bars. Mirror the spectrum across the vertical axis so the
  // ring is symmetric (low freqs at top, fanning both ways).
  const n = bars.length;
  const barW = Math.max(2 * dpr, (Math.PI * 2 * baseR) / (n * 2) * 0.6);
  ctx.lineWidth = barW;
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const v = bars[i];
    const len = baseR + v * maxLen;
    // Two mirrored angles per bin → full ring.
    for (const sign of [-1, 1]) {
      const ang = -Math.PI / 2 + sign * (i / n) * Math.PI;
      const x1 = cx + Math.cos(ang) * baseR;
      const y1 = cy + Math.sin(ang) * baseR;
      const x2 = cx + Math.cos(ang) * len;
      const y2 = cy + Math.sin(ang) * len;
      ctx.strokeStyle = hexA(mix(cfg.accent, cfg.accent2, v), 0.85);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // Crisp inner ring outline.
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = hexA(cfg.accent, 0.5);
  ctx.beginPath();
  ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
  ctx.stroke();
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
  .circ-center {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 28px; z-index: 1; pointer-events: none;
    text-align: center;
  }
  .circ-cover-ring {
    position: relative;
    width: min(26vw, 320px); height: min(26vw, 320px);
    border-radius: 50%;
    padding: 10px;
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
  .circ-meta { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .circ-meta .badge { margin: 0 auto; }
  .circ-title {
    font-size: clamp(2rem, 4vw, 3.6rem);
    font-weight: 800; letter-spacing: -0.01em;
    text-shadow: 0 0 22px rgba(0,240,255,0.5);
    max-width: 80vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .circ-artist { font-size: clamp(1.1rem, 1.8vw, 1.5rem); color: rgba(230,247,255,0.82); }
  .stage-circular .station { bottom: 36px; left: 48px; }
  .stage-circular .clock { bottom: 36px; right: 48px; }
`;
