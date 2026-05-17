"use client";

import { useEffect, useState } from "react";

interface Alert {
  id: number;
  title: string;
  body: string;
  expiresAt: number;
}

const SHOW_MS = 6_500;

/**
 * Alert overlay widget. Pops a brief banner whenever EventSub
 * delivers a follow / sub / cheer / raid event. Each alert fades
 * out after SHOW_MS.
 */
export default function AlertWidget() {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/alerts/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data?.type || data.type === "hello") return;
        const { title, body } = format(data.type, data.event);
        setAlerts((prev) => [...prev, { id: Date.now() + Math.random(), title, body, expiresAt: Date.now() + SHOW_MS }]);
      } catch {}
    };
    return () => es.close();
  }, []);

  // GC expired alerts at 250ms cadence so the fade-out matches CSS.
  useEffect(() => {
    const id = setInterval(() => {
      setAlerts((prev) => prev.filter((a) => a.expiresAt > Date.now()));
    }, 250);
    return () => clearInterval(id);
  }, []);

  return (
    <main
      style={{
        width: "100%", height: "100%",
        display: "flex", flexDirection: "column", justifyContent: "flex-end",
        gap: 10, padding: 8, boxSizing: "border-box",
        font: "16px 'Segoe UI', system-ui, sans-serif",
        color: "#e6f7ff",
      }}
    >
      {alerts.slice(-3).map((a) => {
        const remaining = a.expiresAt - Date.now();
        const opacity = Math.min(1, remaining / 600);
        return (
          <div key={a.id} style={{
            padding: "10px 14px",
            borderRadius: 6,
            background: "linear-gradient(135deg, rgba(138,43,255,.35), rgba(0,240,255,.20))",
            border: "1px solid rgba(0,240,255,.55)",
            boxShadow: "0 0 22px rgba(0,240,255,.45), 0 0 60px rgba(138,43,255,.25)",
            opacity,
            transform: `translateY(${(1 - opacity) * -8}px)`,
            transition: "opacity .3s ease, transform .3s ease",
          }}>
            <div style={{ fontSize: 12, letterSpacing: ".2em", textTransform: "uppercase", color: "#00f0ff" }}>{a.title}</div>
            <div style={{ marginTop: 2, fontWeight: 700 }}>{a.body}</div>
          </div>
        );
      })}
    </main>
  );
}

function format(type: string, e: any): { title: string; body: string } {
  switch (type) {
    case "channel.follow":               return { title: "New follower", body: `${e?.user_name} followed` };
    case "channel.subscribe":            return { title: "Subscriber",   body: `${e?.user_name} (tier ${e?.tier})${e?.is_gift ? " · gifted" : ""}` };
    case "channel.subscription.gift":    return { title: "Gift sub",     body: `${e?.user_name || "Anonymous"} gifted ${e?.total} subs` };
    case "channel.subscription.message": return { title: "Resub",        body: `${e?.user_name} — ${e?.cumulative_months} months` };
    case "channel.cheer":                return { title: "Cheer",        body: `${e?.user_name || "Anonymous"} · ${e?.bits} bits` };
    case "channel.raid":                 return { title: "Raid!",        body: `${e?.from_broadcaster_user_name} +${e?.viewers}` };
    default:                             return { title: type, body: JSON.stringify(e).slice(0, 80) };
  }
}
