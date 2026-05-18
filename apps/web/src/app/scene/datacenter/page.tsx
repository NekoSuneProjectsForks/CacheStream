"use client";

import { useEffect, useState } from "react";

interface DCState {
  servers: number; serversMax: number;
  powerKw: number; powerKwCap: number;
  coolant: number; temperatureC: number;
  uptimePct: number; attacksActive: number;
  budget: number; reputation: number;
  tick: number;
  log: Array<{ at: number; kind: string; text: string }>;
}

export default function DatacenterScene() {
  const [s, setS] = useState<DCState | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/games/datacenter/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.state) setS(data.state);
      } catch {}
    };
    return () => es.close();
  }, []);

  if (!s) return <div style={{ color: "#e6f7ff", padding: 32 }}>booting NOC…</div>;

  return (
    <>
      <style>{`
        html, body { background: #05060a; color: #e6f7ff; height: 100%; margin: 0;
          font-family: 'JetBrains Mono', 'Segoe UI', monospace; overflow: hidden; }
        .noc {
          width: 100vw; height: 100vh;
          display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr auto;
          gap: 16px; padding: 24px; box-sizing: border-box;
          background:
            radial-gradient(circle at 0% 0%, rgba(0,240,255,.07), transparent 40%),
            radial-gradient(circle at 100% 100%, rgba(255,43,214,.07), transparent 40%),
            repeating-linear-gradient(0deg, rgba(0,240,255,.03) 0 1px, transparent 1px 80px),
            repeating-linear-gradient(90deg, rgba(0,240,255,.03) 0 1px, transparent 1px 80px),
            #05060a;
        }
        .head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center;
          padding: 12px 20px; border: 1px solid rgba(0,240,255,.2); border-radius: 6px;
          background: linear-gradient(90deg, rgba(0,240,255,.07), rgba(138,43,255,.05));
        }
        .head .title { letter-spacing: .35em; text-transform: uppercase; font-weight: 800; font-size: 18px;
          text-shadow: 0 0 12px rgba(0,240,255,.55); }
        .head .sub { letter-spacing: .25em; text-transform: uppercase; font-size: 11px; color: rgba(230,247,255,.5); }

        .panel { border: 1px solid rgba(0,240,255,.2); border-radius: 6px; padding: 16px;
          background: rgba(10,13,24,.55); backdrop-filter: blur(2px); }
        .panel h2 { font-size: 11px; letter-spacing: .3em; text-transform: uppercase;
          color: rgba(230,247,255,.6); margin: 0 0 12px; }

        .servers { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
        .server { aspect-ratio: 1.6 / 1; border: 1px solid rgba(0,240,255,.3); border-radius: 4px;
          display: flex; align-items: center; justify-content: center; font-size: 14px;
          background: linear-gradient(180deg, rgba(0,240,255,.06), rgba(10,13,24,.6));
          box-shadow: inset 0 0 10px rgba(0,240,255,.15);
          position: relative;
        }
        .server::before { content: ""; position: absolute; top: 8px; left: 8px;
          width: 6px; height: 6px; border-radius: 50%; background: #4ade80;
          box-shadow: 0 0 8px #4ade80; animation: pulse 2s ease-in-out infinite; }
        .server.off { color: rgba(230,247,255,.2); border-color: rgba(255,255,255,.08); }
        .server.off::before { background: rgba(255,255,255,.1); box-shadow: none; animation: none; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

        .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .stat-card { padding: 10px 12px; border: 1px solid rgba(0,240,255,.15); border-radius: 4px; background: rgba(5,6,10,.6); }
        .stat-card .label { font-size: 10px; letter-spacing: .25em; text-transform: uppercase; color: rgba(230,247,255,.5); }
        .stat-card .val { font-size: 22px; font-weight: 800; margin-top: 4px; }
        .stat-card.crit .val { color: #f87171; text-shadow: 0 0 14px rgba(248,113,113,.55); }
        .stat-card.warn .val { color: #facc15; }

        .feed { grid-column: 1 / -1; min-height: 0; max-height: 180px; overflow: hidden;
          display: flex; flex-direction: column; }
        .feed-list { display: flex; flex-direction: column; gap: 6px;
          font-size: 13px; line-height: 1.35; color: rgba(230,247,255,.72);
          padding: 0; flex: 1; min-height: 0; overflow: hidden;
          font-variant-numeric: tabular-nums; }
        .feed-line {
          display: grid; grid-template-columns: 84px 1fr;
          gap: 12px; align-items: baseline;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .feed-line .ts {
          font-size: 11px; letter-spacing: .15em;
          color: rgba(230,247,255,.35);
          font-family: 'JetBrains Mono', monospace;
        }
        .feed-line .body { overflow: hidden; text-overflow: ellipsis; }
        .feed-line.attack .body { color: #f87171; }
        .feed-line.act .body { color: rgba(0,240,255,.85); }
        .feed-empty { color: rgba(230,247,255,.3); font-style: italic; }
        .help {
          position: absolute; right: 24px; bottom: 18px;
          font-size: 11px; letter-spacing: .2em; text-transform: uppercase;
          color: rgba(230,247,255,.45);
        }
      `}</style>

      <div className="noc">
        <div className="head">
          <div className="title">CacheStream // NOC</div>
          <div className="sub">tick {s.tick} · ${s.budget} budget · rep {s.reputation}</div>
        </div>

        <div className="panel">
          <h2>Server racks · {s.servers}/{s.serversMax}</h2>
          <div className="servers">
            {Array.from({ length: Math.max(12, s.serversMax) }).map((_, i) => (
              <div key={i} className={`server ${i < s.servers ? "" : "off"}`}>{`SRV-${i.toString().padStart(2, "0")}`}</div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>Vitals</h2>
          <div className="stats">
            <StatCard label="Uptime"    val={`${s.uptimePct}%`}              tone={s.uptimePct < 60 ? "crit" : s.uptimePct < 85 ? "warn" : ""} />
            <StatCard label="Temp"      val={`${s.temperatureC}°C`}          tone={s.temperatureC > 80 ? "crit" : s.temperatureC > 60 ? "warn" : ""} />
            <StatCard label="Power"     val={`${s.powerKw}/${s.powerKwCap}kW`} tone={s.powerKw === s.powerKwCap ? "warn" : ""} />
            <StatCard label="Coolant"   val={`${s.coolant}%`}                tone={s.coolant < 20 ? "crit" : s.coolant < 50 ? "warn" : ""} />
            <StatCard label="Attacks"   val={String(s.attacksActive)}        tone={s.attacksActive > 0 ? "crit" : ""} />
            <StatCard label="Rep"       val={String(s.reputation)} />
          </div>
        </div>

        <div className="panel feed">
          <h2>Event feed</h2>
          <div className="feed-list">
            {s.log.length === 0 && <div className="feed-empty">no events yet — chat type !add-server, !defend, !cool…</div>}
            {s.log.slice(-7).reverse().map((l, i) => (
              <div key={`${l.at}-${i}`} className={`feed-line ${l.kind}`}>
                <span className="ts">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className="body">{l.text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="help">!add-server · !defend · !cool · !power+ · !invest · !restart</div>
      </div>
    </>
  );
}

function StatCard({ label, val, tone = "" }: { label: string; val: string; tone?: string }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="label">{label}</div>
      <div className="val">{val}</div>
    </div>
  );
}
