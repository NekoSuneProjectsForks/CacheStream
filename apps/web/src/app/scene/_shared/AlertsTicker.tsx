"use client";

/**
 * Followers / subs / raids / cheers ticker.
 *
 * Subscribes to /api/alerts/stream (EventSub fan-out) and shows
 * the most recent N events as a horizontally-scrolling bottom
 * marquee. Reuses the public SSE feed so it works from inside
 * the headless Chromium scene without an auth session.
 *
 * Position is fixed at the bottom edge; doesn't conflict with
 * the bottom-corner widgets (NowPlaying, ChatOverlay) since
 * those occupy ~360px corners and this is full-width but only
 * 28px tall.
 *
 * Events are kept in memory only — a refresh clears the ticker.
 * For an event history persist, hit the `chat_log` table where
 * we also append a kind="event" row for each alert.
 */

import { useEffect, useState } from "react";

interface Alert {
  id: string;
  text: string;
  kind: "follow" | "sub" | "gift" | "resub" | "cheer" | "raid" | "other";
  at: number;
}

const MAX_VISIBLE = 12;
const LIFETIME_MS = 5 * 60_000;

interface Props {
  /** Hide the ticker (default false — always visible). */
  hidden?: boolean;
}

export default function AlertsTicker({ hidden = false }: Props) {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/alerts/stream");
    es.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m?.type === "hello") return;
        const a = humanize(m);
        if (!a) return;
        setAlerts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), a]);
      } catch {}
    };
    return () => es.close();
  }, []);

  // Prune stale events.
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - LIFETIME_MS;
      setAlerts((prev) => prev.filter((a) => a.at >= cutoff));
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  if (hidden || alerts.length === 0) return null;

  // Duplicate the items so the marquee scrolls seamlessly. CSS
  // animation translates by -50% over N seconds, then loops; with
  // two copies side-by-side that loop is invisible.
  const items = [...alerts, ...alerts];

  return (
    <>
      <style>{`
        .alerts-ticker {
          position: fixed; left: 0; right: 0; bottom: 0;
          height: 30px; z-index: 9997;
          background: linear-gradient(180deg, rgba(5,6,10,0), rgba(5,6,10,.78));
          border-top: 1px solid rgba(0,240,255,.18);
          overflow: hidden;
          font-family: 'JetBrains Mono', 'Segoe UI', monospace;
          font-size: 12px; color: #e6f7ff;
        }
        .alerts-track {
          display: flex; gap: 36px;
          padding: 7px 0;
          white-space: nowrap;
          animation: alerts-scroll 50s linear infinite;
          width: max-content;
        }
        @keyframes alerts-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .alert-item {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 0 10px;
        }
        .alert-glyph {
          font-size: 14px; line-height: 1;
        }
        .alert-item.follow .alert-glyph { color: #00f0ff; }
        .alert-item.sub    .alert-glyph,
        .alert-item.resub  .alert-glyph,
        .alert-item.gift   .alert-glyph { color: #facc15; }
        .alert-item.cheer  .alert-glyph { color: #ff6ad5; }
        .alert-item.raid   .alert-glyph { color: #4ade80; }
        .alert-text strong { color: var(--cs-accent-solid, #00f0ff); }
      `}</style>
      <div className="alerts-ticker">
        <div className="alerts-track">
          {items.map((a, i) => (
            <span key={`${a.id}-${i}`} className={`alert-item ${a.kind}`}>
              <span className="alert-glyph">{glyphFor(a.kind)}</span>
              <span className="alert-text" dangerouslySetInnerHTML={{ __html: a.text }} />
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function glyphFor(kind: Alert["kind"]): string {
  switch (kind) {
    case "follow": return "♥";
    case "sub":
    case "resub":  return "★";
    case "gift":   return "🎁";
    case "cheer":  return "✦";
    case "raid":   return "⚔";
    default:       return "•";
  }
}

function escape(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function humanize(m: any): Alert | null {
  const at = Date.now();
  const id = `${at}-${Math.random().toString(36).slice(2, 8)}`;
  const e = m?.event;
  if (!e) return null;
  const name = (n: string | undefined | null) => `<strong>${escape(n || "someone")}</strong>`;

  switch (m.type) {
    case "channel.follow":
      return { id, kind: "follow", at, text: `${name(e.user_name)} followed` };
    case "channel.subscribe":
      return { id, kind: "sub", at, text: `${name(e.user_name)} subscribed${e.is_gift ? " (gift)" : ""}` };
    case "channel.subscription.gift":
      return { id, kind: "gift", at, text: `${name(e.user_name)} gifted ${e.total} sub${e.total === 1 ? "" : "s"}` };
    case "channel.subscription.message":
      return { id, kind: "resub", at, text: `${name(e.user_name)} resubbed (${e.cumulative_months} months)` };
    case "channel.cheer":
      return { id, kind: "cheer", at, text: `${name(e.user_name || "Anonymous")} cheered ${e.bits} bits` };
    case "channel.raid":
      return { id, kind: "raid", at, text: `${name(e.from_broadcaster_user_name)} raided with ${e.viewers}` };
    default:
      return null;
  }
}
