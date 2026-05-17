"use client";

import { useEffect, useRef, useState } from "react";

interface ChatMsg {
  id: number;
  user: string;
  color: string;
  text: string;
}

const HISTORY_CAP = 80;

/**
 * Chat overlay widget. Used as an iframe inside a stream scene
 * (via an "chat" overlay layer in the admin panel). Subscribes to
 * the SSE chat stream and renders a scrollable transparent list.
 */
export default function ChatWidget() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/chat/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== "msg") return;
        setMsgs((prev) => [
          ...prev.slice(-HISTORY_CAP + 1),
          {
            id: Date.now() + Math.random(),
            user: data.name || data.login || "anon",
            color: data.color || "#00f0ff",
            text: data.message || "",
          },
        ]);
      } catch {}
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [msgs.length]);

  return (
    <main
      ref={ref}
      style={{
        width: "100%", height: "100%",
        overflow: "hidden",
        padding: "12px 14px",
        background: "rgba(5,6,10,0.55)",
        border: "1px solid rgba(0,240,255,.25)",
        borderRadius: 6,
        backdropFilter: "blur(2px)",
        font: "14px 'Segoe UI', system-ui, sans-serif",
        color: "#e6f7ff",
        boxSizing: "border-box",
      }}
    >
      {msgs.length === 0 && (
        <div style={{ color: "rgba(230,247,255,.35)" }}>chat // waiting…</div>
      )}
      {msgs.map((m) => (
        <div key={m.id} style={{ padding: "2px 0", display: "flex", gap: 6, lineHeight: 1.35 }}>
          <span style={{ color: m.color, fontWeight: 700, textShadow: "0 0 6px rgba(0,0,0,.6)" }}>{m.user}:</span>
          <span style={{ wordBreak: "break-word", textShadow: "0 0 6px rgba(0,0,0,.6)" }}>{m.text}</span>
        </div>
      ))}
    </main>
  );
}
