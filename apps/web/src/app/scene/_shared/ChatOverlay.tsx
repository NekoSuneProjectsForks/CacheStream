"use client";

/**
 * Live chat overlay widget for scenes.
 *
 * Subscribes to /api/chat/stream (the public SSE feed that the
 * EventSub channel.chat.message handler publishes onto). Renders
 * the most recent N messages as a vertical stack in a configurable
 * corner, with the streamer's accent colour as the badge tint.
 *
 * Designed to overlay any scene without competing for layout
 * space — positioned fixed, transparent background, small max-
 * width. Drop-shadowed text so it stays legible over busy
 * backgrounds.
 *
 * Auto-fades old messages after MESSAGE_LIFETIME_MS so the chat
 * box clears itself between active periods rather than showing
 * stale messages from 20 minutes ago. New messages always replace
 * the oldest visible one when MAX_VISIBLE is hit.
 */

import { useEffect, useState } from "react";

type Corner = "br" | "bl" | "tr" | "tl";

interface ChatMsg {
  id: string;
  login: string | null;
  name: string | null;
  color: string | null;
  badges: string | null;
  message: string;
  isMod: boolean;
  isSub: boolean;
  at: number;
}

interface Props {
  corner?: Corner;
  /** How many messages to keep visible (default 6). */
  max?: number;
  /** Auto-clear messages after this many ms (default 60s). */
  lifetimeMs?: number;
}

const DEFAULT_MAX = 6;
const DEFAULT_LIFETIME_MS = 60_000;

export default function ChatOverlay({
  corner = "bl",
  max = DEFAULT_MAX,
  lifetimeMs = DEFAULT_LIFETIME_MS,
}: Props) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/chat/stream");
    es.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m?.type !== "msg" || !m.message) return;
        const next: ChatMsg = {
          id: m.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          login: m.login || null,
          name: m.name || m.login || "anon",
          color: m.color || null,
          badges: m.badges || null,
          message: String(m.message),
          isMod: !!m.isMod,
          isSub: !!m.isSub,
          at: Date.now(),
        };
        setMsgs((prev) => [...prev.slice(-(max - 1)), next]);
      } catch {}
    };
    return () => es.close();
  }, [max]);

  // Auto-prune stale messages. Run periodically rather than per-
  // message so we don't churn React state on every tick.
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - lifetimeMs;
      setMsgs((prev) => prev.filter((m) => m.at >= cutoff));
    }, 5_000);
    return () => clearInterval(id);
  }, [lifetimeMs]);

  if (msgs.length === 0) return null;

  const pos = positionFor(corner);

  return (
    <>
      <style>{`
        .chat-overlay {
          position: fixed; ${pos.css}
          z-index: 9998;
          display: flex; flex-direction: column;
          gap: 6px;
          max-width: 380px;
          font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
          pointer-events: none;
        }
        .chat-line {
          padding: 6px 10px;
          background: linear-gradient(135deg, rgba(10,13,24,.78), rgba(5,6,10,.86));
          border-left: 2px solid var(--cs-accent-solid, #00f0ff);
          border-radius: 4px;
          font-size: 13px; line-height: 1.4;
          color: #e6f7ff;
          text-shadow: 0 1px 2px rgba(0,0,0,.7);
          animation: chat-in 220ms cubic-bezier(.2,.8,.2,1);
          word-break: break-word;
        }
        @keyframes chat-in {
          0%   { opacity: 0; transform: translateX(${pos.fromX}); }
          100% { opacity: 1; transform: translateX(0); }
        }
        .chat-name {
          font-weight: 700;
          margin-right: 6px;
        }
        .chat-badge {
          display: inline-block;
          font-size: 9px; letter-spacing: .15em; text-transform: uppercase;
          padding: 1px 5px; margin-right: 5px;
          border-radius: 2px;
          background: var(--cs-accent-solid, #00f0ff);
          color: #05060a;
          font-weight: 800;
          vertical-align: 1px;
        }
        .chat-badge.mod { background: #4ade80; color: #052e0e; }
        .chat-badge.sub { background: #facc15; color: #2a1d00; }
      `}</style>
      <div className="chat-overlay">
        {msgs.map((m) => (
          <div className="chat-line" key={m.id}>
            {m.isMod && <span className="chat-badge mod">mod</span>}
            {!m.isMod && m.isSub && <span className="chat-badge sub">sub</span>}
            <span className="chat-name" style={{ color: m.color || undefined }}>
              {m.name}
            </span>
            <span>{m.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function positionFor(c: Corner) {
  switch (c) {
    case "tl": return { css: "top: 24px; left: 24px;",    fromX: "-24px" };
    case "tr": return { css: "top: 24px; right: 24px;",   fromX: "24px"  };
    case "br": return { css: "bottom: 24px; right: 24px;",fromX: "24px"  };
    case "bl":
    default:   return { css: "bottom: 24px; left: 24px;", fromX: "-24px" };
  }
}
