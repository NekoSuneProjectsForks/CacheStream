"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./util";

interface ChatStatus {
  tokensPresent: boolean;
  missingScopes: string[];
  chat: { state: string; channel: string | null; connectedAt: number | null; lastError: string | null };
  eventsub: { state: string; sessionId: string | null; lastError: string | null };
}

interface ChatEntry {
  id: number;
  at: number;
  kind: string;
  userLogin: string | null;
  userName: string | null;
  color: string | null;
  message: string;
}

const HISTORY_CAP = 500;

/**
 * Chat tab — read live chat, send messages, see connection state.
 * Subscribes to /api/chat/stream (SSE) for low-latency updates.
 */
export function ChatTab() {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const loadStatus = useCallback(async () => {
    try { setStatus(await apiJson("/api/chat/status")); }
    catch (e: any) { setError(e.message); }
  }, []);

  // Initial: status + recent log.
  useEffect(() => {
    loadStatus();
    apiJson("/api/chat/log?limit=200")
      .then((b) => setEntries(b.entries || []))
      .catch(() => {});
  }, [loadStatus]);

  // Live SSE subscription.
  useEffect(() => {
    const es = new EventSource("/api/chat/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "msg" || data.type === "event") {
          setEntries((prev) => {
            const next: ChatEntry = {
              id: Date.now() + Math.random(),
              at: Date.now(),
              kind: data.type,
              userLogin: data.login || null,
              userName: data.name || null,
              color: data.color || null,
              message: data.message || "",
            };
            return [...prev.slice(-HISTORY_CAP), next];
          });
        } else if (data.type === "connected") {
          loadStatus();
        }
      } catch {}
    };
    es.onerror = () => { /* the browser auto-reconnects */ };
    return () => es.close();
  }, [loadStatus]);

  // Auto-scroll on new message.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [entries.length]);

  const startStop = async (action: "start" | "stop") => {
    setBusy(action); setError(null);
    try {
      setStatus(await apiJson("/api/chat/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy("send"); setError(null);
    try {
      await apiJson("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setText("");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const chatBadge = badgeForState(status?.chat.state);
  const esBadge = badgeForState(status?.eventsub.state);

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      {status && status.missingScopes.length > 0 && (
        <div className="banner err">
          ⚠ Your stored token is missing OAuth scopes ({status.missingScopes.join(", ")}).
          <a href="/api/auth/twitch/login" style={{ marginLeft: 8 }}>Re-authorize</a>.
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Connection</h2>
          <div className="row" style={{ gap: ".5rem" }}>
            <span className={`badge ${chatBadge}`}>chat · {status?.chat.state || "—"}</span>
            <span className={`badge ${esBadge}`}>eventsub · {status?.eventsub.state || "—"}</span>
          </div>
        </div>
        <div className="actions">
          <button className="btn-primary" disabled={!!busy} onClick={() => startStop("start")}>
            {busy === "start" ? "Starting…" : "Start chat + alerts"}
          </button>
          <button className="btn-ghost" disabled={!!busy} onClick={() => startStop("stop")}>
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
        </div>
        {status?.chat.lastError && <p className="hint">chat: {status.chat.lastError}</p>}
        {status?.eventsub.lastError && <p className="hint">eventsub: {status.eventsub.lastError}</p>}
      </section>

      <section className="card">
        <div className="card-head"><h2>Live chat</h2></div>

        <div
          ref={logRef}
          style={{
            height: 380, overflowY: "auto",
            padding: ".75rem 1rem",
            background: "rgba(5,6,10,.55)",
            border: "1px solid var(--line-soft)",
            borderRadius: 4, fontSize: ".88rem",
          }}
        >
          {entries.length === 0 && <div className="muted">No messages yet…</div>}
          {entries.map((e) => (
            <div key={e.id} style={{ padding: "2px 0", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {e.kind === "event" ? (
                <span style={{ color: "var(--neon-magenta)" }}>★ {e.message}</span>
              ) : (
                <>
                  <span style={{ color: e.color || "var(--neon-cyan)", fontWeight: 700 }}>
                    {e.userName || e.userLogin || "anon"}:
                  </span>
                  <span style={{ wordBreak: "break-word" }}>{e.message}</span>
                </>
              )}
            </div>
          ))}
        </div>

        <form onSubmit={send} className="row gap" style={{ marginTop: ".75rem" }}>
          <input
            className="input grow"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={status?.chat.state === "connected" ? "Say something…" : "Connect chat first"}
            disabled={status?.chat.state !== "connected" || busy === "send"}
          />
          <button className="btn-primary" type="submit" disabled={!text.trim() || status?.chat.state !== "connected" || busy === "send"}>
            {busy === "send" ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </>
  );
}

function badgeForState(s?: string): string {
  switch (s) {
    case "connected": return "ok";
    case "connecting": return "warn";
    case "closed":     return "err";
    default:           return "mute";
  }
}
