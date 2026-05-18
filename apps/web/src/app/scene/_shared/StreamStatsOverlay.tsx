"use client";

/**
 * Stream stats overlay — uptime + viewer count.
 *
 * Polls /api/twitch/live-public every 10 s for Twitch's view of
 * the broadcast. Renders a tiny corner card with a live indicator,
 * elapsed time, and viewer count when the channel is live.
 *
 * Hides entirely when not live so it doesn't clutter offline /
 * BRB scenes. Uptime is computed client-side from `startedAt` so
 * the seconds tick smoothly without burning Helix calls.
 */

import { useEffect, useState } from "react";

type Corner = "br" | "bl" | "tr" | "tl";

interface LiveData {
  liveOnTwitch: boolean;
  stream: {
    startedAt: string;
    viewerCount: number;
    title: string;
    game: string;
  } | null;
}

interface Props {
  corner?: Corner;
  /** Hide the title/game text — keep just LIVE + uptime + viewers (default false). */
  minimal?: boolean;
}

const POLL_MS = 10_000;

export default function StreamStatsOverlay({ corner = "tl", minimal = false }: Props) {
  const [data, setData] = useState<LiveData | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchLive = async () => {
      try {
        const r = await fetch("/api/twitch/live-public", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setData(j);
      } catch {}
    };
    fetchLive();
    const id = setInterval(fetchLive, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Re-render every second for the uptime counter.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!data?.liveOnTwitch || !data.stream) return null;

  const startedMs = Date.parse(data.stream.startedAt);
  const uptime = formatUptime(Date.now() - startedMs);
  const pos = positionFor(corner);

  return (
    <>
      <style>{`
        .stats-overlay {
          position: fixed; ${pos.css}
          z-index: 9996;
          display: inline-flex; align-items: center; gap: 12px;
          padding: 6px 14px;
          background: linear-gradient(135deg, rgba(10,13,24,.78), rgba(5,6,10,.86));
          border: 1px solid rgba(248,113,113,.36);
          border-radius: 999px;
          backdrop-filter: blur(4px);
          font-family: 'JetBrains Mono', 'Segoe UI', monospace;
          color: #e6f7ff;
          font-size: 12px;
          letter-spacing: .06em;
          font-variant-numeric: tabular-nums;
          box-shadow: 0 6px 20px rgba(0,0,0,.45);
        }
        .stats-live {
          display: inline-flex; align-items: center; gap: 6px;
          font-weight: 800; letter-spacing: .22em;
          color: #f87171;
          text-shadow: 0 0 8px rgba(248,113,113,.6);
        }
        .stats-live .dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: #f87171; box-shadow: 0 0 10px #f87171;
          animation: stats-pulse 1.6s ease-in-out infinite;
        }
        @keyframes stats-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
        .stats-sep { color: rgba(230,247,255,.25); }
        .stats-uptime { color: rgba(230,247,255,.85); }
        .stats-viewers { color: var(--cs-accent-solid, #00f0ff); font-weight: 700; }
        .stats-title {
          color: rgba(230,247,255,.55);
          max-width: 260px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
      `}</style>
      <div className="stats-overlay" data-tick={tick}>
        <span className="stats-live"><span className="dot" />LIVE</span>
        <span className="stats-sep">|</span>
        <span className="stats-uptime">{uptime}</span>
        <span className="stats-sep">|</span>
        <span className="stats-viewers">{data.stream.viewerCount.toLocaleString()} watching</span>
        {!minimal && data.stream.title && (
          <>
            <span className="stats-sep">|</span>
            <span className="stats-title">{data.stream.title}</span>
          </>
        )}
      </div>
    </>
  );
}

function positionFor(c: Corner) {
  switch (c) {
    case "br": return { css: "bottom: 24px; right: 24px;" };
    case "bl": return { css: "bottom: 24px; left: 24px;"  };
    case "tr": return { css: "top: 24px; right: 24px;"    };
    case "tl":
    default:   return { css: "top: 24px; left: 24px;"     };
  }
}

function formatUptime(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}
