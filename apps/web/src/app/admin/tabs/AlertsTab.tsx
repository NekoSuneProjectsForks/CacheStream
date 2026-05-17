"use client";

import { useEffect, useState } from "react";

interface AlertEvent {
  id: number;
  at: number;
  type: string;
  payload: any;
}

const HISTORY_CAP = 200;

/**
 * Alerts tab — live feed of EventSub notifications (follow,
 * sub, cheer, raid). Backed by /api/alerts/stream (SSE).
 */
export function AlertsTab() {
  const [events, setEvents] = useState<AlertEvent[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/alerts/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data?.type || data.type === "hello") return;
        setEvents((prev) => [
          ...prev.slice(-HISTORY_CAP + 1),
          { id: Date.now() + Math.random(), at: Date.now(), type: data.type, payload: data.event },
        ]);
      } catch {}
    };
    return () => es.close();
  }, []);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Live alerts</h2>
        <span className="badge mute">{events.length} this session</span>
      </div>
      <p className="hint">
        Backed by Twitch EventSub WebSocket. Subscribes on connect to follows,
        subs, gifts, resubs, cheers, raids.
      </p>

      <ul className="list">
        {events.length === 0 && <li className="muted">Waiting for events… stream something and follow yourself to test.</li>}
        {events.slice().reverse().map((e) => (
          <li key={e.id} className="list-row">
            <div className="grow">
              <div className="row-title">
                <span className="tag">{shortType(e.type)}</span>
                <span>{summarise(e.type, e.payload)}</span>
              </div>
              <div className="row-sub muted">{new Date(e.at).toLocaleTimeString()}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function shortType(t: string): string {
  return t.replace(/^channel\./, "");
}

function summarise(type: string, e: any): string {
  switch (type) {
    case "channel.follow":               return `${e?.user_name || "someone"} followed`;
    case "channel.subscribe":            return `${e?.user_name} subbed (tier ${e?.tier})${e?.is_gift ? " — gift" : ""}`;
    case "channel.subscription.gift":    return `${e?.user_name || "anonymous"} gifted ${e?.total} subs`;
    case "channel.subscription.message": return `${e?.user_name} resub (${e?.cumulative_months} mo): ${e?.message?.text || ""}`;
    case "channel.cheer":                return `${e?.user_name || "anonymous"} cheered ${e?.bits} bits${e?.message ? ` — ${e.message}` : ""}`;
    case "channel.raid":                 return `${e?.from_broadcaster_user_name} raided with ${e?.viewers}`;
    default:                             return JSON.stringify(e);
  }
}
