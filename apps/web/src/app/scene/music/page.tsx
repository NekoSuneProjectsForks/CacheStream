"use client";

import { useEffect, useRef, useState } from "react";
import ClientSceneOverlays from "../_shared/ClientSceneOverlays";

/**
 * Music scene — radio-station style display for the broadcast.
 *
 * Pulls the currently-playing track from /api/music/now every
 * second. When the trackId changes, it fetches the same file
 * via /api/music/file/:id, pipes it into a Web Audio
 * AnalyserNode, and draws frequency bars to a <canvas>.
 *
 * The actual broadcast audio comes from the music engine's
 * FFmpeg → FIFO pipeline; this scene is purely visual. The
 * Web Audio analysis tracks within ~200ms of the streamed
 * audio because both start playback at the same wall clock.
 *
 * Important: the <audio> element here is muted (`autoplay`
 * + `muted` to satisfy browser policies). We never want the
 * scene to also emit audio — that would double up in the
 * broadcast.
 *
 * For radio mode (no trackId, just a URL) we fall back to a
 * procedural pseudo-visualizer because CORS will usually block
 * us from analysing the Shoutcast/Icecast stream directly.
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
// v1.9.0: dropped from 64 → 48 bars. Each bar is an FFT bin lookup
// + a shadowBlur rect draw + a flipped reflection draw, so the
// canvas-paint cost scales linearly with this. 48 still looks busy
// at 1280px and saves ~25% of the visualiser's per-frame work.
const BAR_COUNT = 48;
// Render at 30fps instead of the requestAnimationFrame default
// (60+). The streamer captures the page at 30fps anyway, so
// painting faster than that is purely wasted CPU.
const RENDER_FPS = 30;

export default function MusicScene() {
  const [mode, setMode] = useState<"idle" | "library" | "radio">("idle");
  const [now, setNow] = useState<NowPlaying | null>(null);
  const audioRef    = useRef<HTMLAudioElement | null>(null);
  const canvasRef   = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const ctxRef      = useRef<AudioContext | null>(null);
  const sourceRef   = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef      = useRef<number | null>(null);
  const lastTrackId = useRef<string | null>(null);

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
  //    actually producing sound out of the scene tab. Since the
  //    streamer captures the page as VIDEO frames only (CDP
  //    screencast doesn't capture audio), this is safe — no risk
  //    of doubling the broadcast audio.
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
      // Autoplay can still be denied in dev (when viewing this scene
      // in a normal browser tab). It works in headless Chromium.
      console.warn("[music scene] audio.play() denied:", err?.message || err);
    });

    if (!ctxRef.current) {
      const AC = (window.AudioContext || (window as any).webkitAudioContext);
      const ac = new AC();
      const an = ac.createAnalyser();
      // v1.9.0: 512 → 256. The FFT cost is O(N log N) per audio
      // callback. 256 gives us 128 bins which we average down to
      // BAR_COUNT (48) for display — already heavily downsampled,
      // so the extra resolution from 256 was never visible. Cuts
      // analyser CPU roughly in half.
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.78;

      const src = ac.createMediaElementSource(audio);
      const sink = ac.createGain();
      sink.gain.value = 0;            // silent output

      // src → analyser (taps the audio data)
      // src → sink(0) → destination (keeps the graph "live")
      src.connect(an);
      src.connect(sink);
      sink.connect(ac.destination);

      // Some Chromium builds start the AudioContext suspended.
      if (ac.state === "suspended") ac.resume().catch(() => {});

      ctxRef.current = ac;
      analyserRef.current = an;
      sourceRef.current = src;
    }
  }, [now?.trackId]);

  // ---- Render loop -----------------------------------------------
  //
  // v1.9.0: paced to RENDER_FPS (default 30) instead of running
  // wide-open via requestAnimationFrame. Chromium's RAF cadence is
  // typically 60Hz; the streamer captures the page at 30fps, so
  // painting at 60Hz means HALF of our frames are computed,
  // discarded, and never streamed. Capping at 30 cuts canvas-paint
  // CPU roughly in half with zero visible difference.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const minFrameInterval = 1000 / RENDER_FPS;
    let lastDraw = 0;

    const draw = (t: number) => {
      rafRef.current = requestAnimationFrame(draw);
      if (t - lastDraw < minFrameInterval) return;
      lastDraw = t;

      const w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
      const h = canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);

      ctx.clearRect(0, 0, w, h);

      let bars: number[];
      if (analyserRef.current && mode === "library") {
        const an = analyserRef.current;
        const data = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(data);
        bars = sampleBars(data, BAR_COUNT);
      } else {
        // Procedural fallback: smooth perlin-ish bars on a clock.
        bars = procedural(BAR_COUNT);
      }

      drawBars(ctx, bars, w, h);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [mode]);

  const hasTrack = !!now?.trackId;
  // Cover-art cascade:
  //   1. Track-embedded cover (when a library track has one)
  //   2. Broadcaster's uploaded logo (Branding tab) — fits radio
  //      mode where there's no track-level art at all, and library
  //      tracks missing artwork
  //   3. Built-in ♫ placeholder (rendered by the .cover-placeholder
  //      div when the <img> fails — covers the case where no logo
  //      has been uploaded yet either)
  const coverUrl = hasTrack ? `/api/music/cover/${now!.trackId}` : "/api/branding/logo";

  return (
    <>
      <style>{`
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
        .cover-wrap {
          position: relative;
          width: 480px; height: 480px;
          max-width: 100%;
        }
        .cover {
          width: 100%; height: 100%;
          border-radius: 8px;
          background:
            linear-gradient(135deg, rgba(0,240,255,0.18), rgba(138,43,255,0.18));
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
        .meta {
          min-width: 0;
          display: flex; flex-direction: column; gap: 12px;
        }
        .badge {
          font-size: 12px; letter-spacing: 0.32em; text-transform: uppercase;
          color: var(--neon-cyan, #00f0ff);
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
          font-weight: 800;
          line-height: 1.1;
          letter-spacing: -0.01em;
          text-shadow: 0 0 18px rgba(0,240,255,0.45);
          overflow: hidden; text-overflow: ellipsis;
        }
        .artist {
          font-size: clamp(1.2rem, 2vw, 1.6rem);
          color: rgba(230,247,255,0.8);
          letter-spacing: 0.04em;
        }
        .album {
          font-size: 0.95rem;
          color: rgba(230,247,255,0.45);
          letter-spacing: 0.06em;
        }

        /* ----- Visualizer ----- */
        .vis-wrap {
          position: relative;
          height: 200px;
          padding: 0 64px 56px;
        }
        canvas {
          width: 100%; height: 100%;
          display: block;
          /* v1.9.0: GPU-composited drop-shadow replaces the
             per-bar canvas shadowBlur. Same look at a fraction
             of the per-frame CPU. */
          filter: drop-shadow(0 0 14px rgba(0,240,255,0.45));
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
      `}</style>

      <main className="stage">
        <div className="top">
          <div className="cover-wrap">
            <div className="vinyl" />
            <img
              className="cover"
              src={coverUrl}
              alt=""
              onError={(e) => {
                // Track cover failed (404 / missing). Step down the
                // fallback chain: try the broadcaster's logo next;
                // if THAT also fails, hide the img and reveal the
                // ♫ placeholder beneath.
                const img = e.currentTarget as HTMLImageElement;
                const logoUrl = "/api/branding/logo";
                if (!img.src.endsWith(logoUrl)) {
                  img.src = logoUrl;
                  return;
                }
                img.style.display = "none";
                (img.nextElementSibling as HTMLElement | null)?.style.removeProperty("display");
              }}
            />
            <div className="cover-placeholder" style={{ display: "none", position: "absolute", inset: 0 }}>♫</div>
          </div>

          <div className="meta">
            <span className="badge">
              <span className="pulse" />
              {mode === "radio" ? "ON AIR · RADIO" : mode === "library" ? "ON AIR · NOW PLAYING" : "ON AIR · SILENCE"}
            </span>
            <div className="title">{now?.title || (mode === "radio" ? "Radio Stream" : "Cache Radio")}</div>
            <div className="artist">{now?.artist || (mode === "radio" ? new URL(now?.url || "https://radio").hostname.replace(/^www\./, "") : "—")}</div>
            {now?.album && <div className="album">{now.album}</div>}
          </div>
        </div>

        <div className="vis-wrap">
          <span className="station">CacheStream  ·  91.7 FM</span>
          <canvas ref={canvasRef} />
          <Clock />
        </div>

        {/* Muted audio element — analysed for visualisation only.
            Its src is set imperatively in the effect above. */}
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

// ---- Bar helpers ------------------------------------------------

function sampleBars(data: Uint8Array, n: number): number[] {
  const step = Math.floor(data.length / n);
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += data[i * step + j];
    bars.push(sum / step / 255);
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

function drawBars(ctx: CanvasRenderingContext2D, bars: number[], w: number, h: number) {
  const gap = 4 * (window.devicePixelRatio || 1);
  const barW = (w - gap * (bars.length - 1)) / bars.length;
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, "rgba(0,240,255,0.95)");
  grad.addColorStop(0.6, "rgba(138,43,255,0.85)");
  grad.addColorStop(1, "rgba(255,43,214,0.85)");

  // v1.9.0: removed per-bar `shadowBlur = 12`. That blur was the
  // single most expensive op in the visualiser — it forces canvas
  // to render every bar as a separate composited layer with a
  // gaussian blur. The same glow effect now comes from the
  // gradient itself + a single CSS drop-shadow on the canvas
  // element (set in the .vis-wrap CSS), drawn once by the GPU
  // rather than per-bar per-frame.
  ctx.fillStyle = grad;
  for (let i = 0; i < bars.length; i++) {
    const v = bars[i];
    const barH = Math.max(2, v * h);
    const x = i * (barW + gap);
    const y = h - barH;
    ctx.fillRect(x, y, barW, barH);
  }

  // Mirror underneath at lower opacity (reflection).
  ctx.globalAlpha = 0.18;
  ctx.scale(1, -1);
  for (let i = 0; i < bars.length; i++) {
    const v = bars[i];
    const barH = Math.max(2, v * h);
    const x = i * (barW + gap);
    ctx.fillRect(x, -h - barH * 0.7, barW, barH * 0.7);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}
