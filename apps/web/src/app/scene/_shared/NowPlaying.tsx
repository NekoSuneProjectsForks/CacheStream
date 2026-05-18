"use client";

/**
 * Now Playing overlay widget. Pulls /api/music/now on a 1s
 * cadence and renders a small bottom-corner card with cover +
 * title + artist. Designed to be dropped into any scene as a
 * persistent overlay, no per-scene plumbing needed.
 *
 * Visibility: hides itself entirely when music is idle (no
 * track + no radio URL) so scenes don't have a phantom widget
 * when nothing's playing. Animates the slide-in / slide-out at
 * the corner so transitions feel intentional rather than jumpy.
 *
 * Cover-art cascade matches the dedicated music scene:
 *   track cover → broadcaster logo → CD-icon placeholder.
 *
 * Positioning: defaults to bottom-right with 24px gutter. Pass
 * `corner="bl"` / `"tl"` / `"tr"` to flip — useful for scenes
 * whose own art lives in a particular corner.
 */

import { useEffect, useState } from "react";

interface NowPlaying {
  trackId?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationS?: number | null;
  url?: string;
  startedAt?: number;
}

type Corner = "br" | "bl" | "tr" | "tl";

const POLL_MS = 1000;

interface Props {
  /** Corner placement (default "br"). */
  corner?: Corner;
  /** Show even when idle (with placeholder text). Default false. */
  showWhenIdle?: boolean;
}

export default function NowPlayingWidget({ corner = "br", showWhenIdle = false }: Props) {
  const [mode, setMode] = useState<"idle" | "library" | "radio">("idle");
  const [now,  setNow]  = useState<NowPlaying | null>(null);
  const [coverSrc, setCoverSrc] = useState<string>("");
  const [coverStep, setCoverStep] = useState<"track" | "logo" | "fallback">("track");

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

  // Reset cover cascade whenever the track changes.
  useEffect(() => {
    if (now?.trackId) {
      setCoverSrc(`/api/music/cover/${now.trackId}`);
      setCoverStep("track");
    } else {
      setCoverSrc("/api/branding/logo");
      setCoverStep("logo");
    }
  }, [now?.trackId]);

  const isPlaying = mode !== "idle" && (now?.trackId || now?.url);
  if (!isPlaying && !showWhenIdle) return null;

  const title  = now?.title  || (mode === "radio" ? "Radio Stream" : "Cache Radio");
  const artist = now?.artist || (mode === "radio" && now?.url
    ? safeHostname(now.url) : "—");

  const pos = positionFor(corner);

  return (
    <>
      <style>{`
        .np-widget {
          position: fixed; ${pos.css}
          z-index: 9999;
          display: grid; grid-template-columns: 56px 1fr;
          gap: 12px; align-items: center;
          padding: 10px 16px 10px 10px;
          background: linear-gradient(135deg, rgba(10,13,24,.85), rgba(5,6,10,.92));
          border: 1px solid rgba(0,240,255,.32);
          border-radius: 8px;
          backdrop-filter: blur(6px);
          box-shadow:
            0 0 0 1px rgba(0,240,255,.06) inset,
            0 0 24px rgba(0,240,255,.18),
            0 12px 40px rgba(0,0,0,.55);
          color: #e6f7ff;
          font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
          max-width: 360px;
          animation: np-in 360ms cubic-bezier(.2,.8,.2,1);
        }
        @keyframes np-in {
          0%   { opacity: 0; transform: translate(${pos.fromX}, ${pos.fromY}); }
          100% { opacity: 1; transform: translate(0, 0); }
        }
        .np-cover {
          width: 56px; height: 56px; border-radius: 4px;
          background: linear-gradient(135deg, rgba(0,240,255,.18), rgba(138,43,255,.18));
          object-fit: cover;
          border: 1px solid rgba(0,240,255,.25);
        }
        .np-cover.fallback {
          display: flex; align-items: center; justify-content: center;
          font-size: 26px; color: rgba(0,240,255,.55);
        }
        .np-text { min-width: 0; }
        .np-badge {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 9px; letter-spacing: .32em; text-transform: uppercase;
          color: #00f0ff; margin-bottom: 3px;
        }
        .np-badge .pulse {
          width: 6px; height: 6px; border-radius: 50%;
          background: #4ade80; box-shadow: 0 0 6px #4ade80;
          animation: np-blink 1.6s ease-in-out infinite;
        }
        @keyframes np-blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
        .np-title {
          font-size: 14px; font-weight: 700;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          letter-spacing: -.01em;
        }
        .np-artist {
          font-size: 11px; color: rgba(230,247,255,.65);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          margin-top: 1px;
        }
      `}</style>
      <div className="np-widget">
        {coverStep === "fallback" ? (
          <div className="np-cover fallback">♫</div>
        ) : (
          <img
            className="np-cover"
            src={coverSrc}
            alt=""
            onError={() => {
              // Cascade: track cover → broadcaster logo → CD icon.
              if (coverStep === "track") {
                setCoverSrc("/api/branding/logo");
                setCoverStep("logo");
              } else if (coverStep === "logo") {
                setCoverStep("fallback");
              }
            }}
          />
        )}
        <div className="np-text">
          <div className="np-badge">
            <span className="pulse" />
            {mode === "radio" ? "On Air · Radio" : "Now Playing"}
          </div>
          <div className="np-title">{title}</div>
          <div className="np-artist">{artist}</div>
        </div>
      </div>
    </>
  );
}

function positionFor(c: Corner) {
  switch (c) {
    case "tl": return { css: "top: 24px; left: 24px;",    fromX: "-24px", fromY: "-24px" };
    case "tr": return { css: "top: 24px; right: 24px;",   fromX: "24px",  fromY: "-24px" };
    case "bl": return { css: "bottom: 24px; left: 24px;", fromX: "-24px", fromY: "24px" };
    case "br":
    default:   return { css: "bottom: 24px; right: 24px;",fromX: "24px",  fromY: "24px" };
  }
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}
