"use client";

import { useEffect, useState } from "react";
import ClientSceneOverlays from "../_shared/ClientSceneOverlays";

interface PetState {
  name: string; species: string;
  hunger: number; happiness: number; energy: number;
  intelligence: number; aggression: number; morality: number;
  ageMinutes: number; evolution: number;
  mutations: Array<{ at: number; kind: string; detail: string }>;
  lastAction: string | null; lastActor: string | null;
  bornAt: number;
}

const MOODS = ["sleepy", "curious", "ravenous", "smug", "vengeful", "playful", "introspective"];
const EYE_COLORS = ["#00f0ff", "#ff2bd6", "#8a2bff", "#ffb800", "#4ade80"];

export default function PetScene() {
  const [s, setS] = useState<PetState | null>(null);
  const [recent, setRecent] = useState<Array<{ at: number; kind: string; detail: string }>>([]);

  useEffect(() => {
    const es = new EventSource("/api/games/pet/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.state) {
          setS(data.state);
          if (data.type === "update") {
            const last = data.state.mutations.slice(-1)[0];
            if (last) setRecent((r) => [...r.slice(-4), last]);
          } else {
            setRecent(data.state.mutations.slice(-5));
          }
        }
      } catch {}
    };
    return () => es.close();
  }, []);

  if (!s) return <Scene><div className="loading">booting creature…</div></Scene>;

  const tier = s.evolution;
  const mood = MOODS[Math.abs(s.aggression + s.happiness + s.intelligence) % MOODS.length];
  const eyeColor = EYE_COLORS[tier % EYE_COLORS.length];

  return (
    <Scene>
      <style>{`
        html, body { background: #05060a; color: #e6f7ff; height: 100%; overflow: hidden;
          font-family: 'JetBrains Mono', 'Segoe UI', monospace; }
        .scene-wrap {
          position: relative; width: 100vw; height: 100vh;
          display: grid; grid-template-rows: 1fr auto;
          background:
            radial-gradient(circle at 50% 38%, rgba(0,240,255,.14), transparent 60%),
            radial-gradient(circle at 50% 100%, rgba(255,43,214,.12), transparent 70%),
            #05060a;
        }
        .stage { position: relative; display: flex; align-items: center; justify-content: center; }
        .creature {
          width: ${260 + tier * 60}px; height: ${260 + tier * 60}px;
          border-radius: 50% 50% 48% 52% / 56% 54% 46% 44%;
          background: radial-gradient(circle at 50% 35%, rgba(0,240,255,.45), rgba(10,13,24,.95) 60%, #05060a 100%);
          border: 1px solid rgba(0,240,255,.4);
          box-shadow:
            0 0 60px rgba(0,240,255,.35),
            inset 0 0 80px rgba(138,43,255,.25);
          position: relative;
          animation: bob 4s ease-in-out infinite;
          transform-style: preserve-3d;
        }
        @keyframes bob { 0%,100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-12px) rotate(1deg); } }
        .eye {
          position: absolute; top: 35%; width: 30px; height: 30px; border-radius: 50%;
          background: ${eyeColor};
          box-shadow: 0 0 22px ${eyeColor};
          animation: blink 4.5s steps(1) infinite;
        }
        .eye.l { left: 28%; } .eye.r { right: 28%; }
        @keyframes blink { 0%,93%,100% { transform: scaleY(1); } 94%,97% { transform: scaleY(0.1); } }
        .mouth {
          position: absolute; bottom: 30%; left: 50%; transform: translateX(-50%);
          width: ${30 + s.happiness / 5}px; height: ${10 + Math.abs(s.happiness - 50) / 8}px;
          border-bottom: 3px solid #e6f7ff;
          border-radius: ${s.happiness > 50 ? "0 0 40% 40%" : "40% 40% 0 0"};
          opacity: .8;
        }
        .nameplate {
          position: absolute; top: 32px; left: 50%; transform: translateX(-50%);
          padding: 6px 14px; border: 1px solid rgba(0,240,255,.35);
          border-radius: 4px; background: rgba(10,13,24,.55); backdrop-filter: blur(2px);
          letter-spacing: .3em; text-transform: uppercase; font-size: 14px;
        }
        .nameplate .name { color: #00f0ff; font-weight: 700; }
        .nameplate .species { color: rgba(230,247,255,.6); font-size: 11px; }
        .hud {
          padding: 16px 24px 24px; display: grid; gap: 8px;
          grid-template-columns: repeat(6, 1fr);
          border-top: 1px solid rgba(0,240,255,.18);
          background: linear-gradient(180deg, rgba(5,6,10,0), rgba(5,6,10,.75));
        }
        .stat { font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: rgba(230,247,255,.6); }
        .bar  { height: 6px; background: rgba(0,240,255,.08); border-radius: 3px; overflow: hidden; margin-top: 4px; }
        .fill { height: 100%; background: linear-gradient(90deg, #00f0ff, #8a2bff); box-shadow: 0 0 12px rgba(0,240,255,.6); }
        .meta {
          position: absolute; bottom: 18px; right: 24px;
          font-size: 11px; letter-spacing: .2em; text-transform: uppercase;
          color: rgba(230,247,255,.45);
        }
        .feed {
          position: absolute; bottom: 48px; left: 24px;
          font-size: 11px; max-width: 40%;
          color: rgba(230,247,255,.55);
        }
        .feed div { padding: 2px 0; }
        .help {
          position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
          font-size: 11px; letter-spacing: .25em; text-transform: uppercase;
          color: rgba(230,247,255,.55);
          padding: 6px 14px; border: 1px solid rgba(0,240,255,.2); border-radius: 4px;
          background: rgba(10,13,24,.55); backdrop-filter: blur(2px);
          white-space: nowrap;
        }
        .help b { color: #00f0ff; font-weight: 700; }
        .loading { color: rgba(230,247,255,.4); font-size: 14px; letter-spacing: .3em; text-transform: uppercase; }
      `}</style>

      <div className="scene-wrap">
        <div className="stage">
          <div className="nameplate">
            <span className="name">{s.name}</span>
            {" · "}
            <span className="species">{s.species} · evo {s.evolution}</span>
          </div>
          <div className="creature">
            <div className="eye l" />
            <div className="eye r" />
            <div className="mouth" />
          </div>
          <div className="meta">{mood} · age {fmtAge(s.ageMinutes)}</div>
          <div className="feed">
            {recent.length === 0
              ? <div>waiting for the chat to interact…</div>
              : recent.map((m, i) => <div key={i}>★ {m.detail}</div>)}
          </div>
          <div className="help">
            <b>!feed</b> · <b>!pet</b> · <b>!play</b> · <b>!sleep</b> · <b>!teach</b> · <b>!hit</b>
          </div>
        </div>

        <div className="hud">
          <Stat label="Hunger"      v={s.hunger} />
          <Stat label="Happiness"   v={s.happiness} />
          <Stat label="Energy"      v={s.energy} />
          <Stat label="Intelligence" v={s.intelligence} />
          <Stat label="Aggression"  v={s.aggression} />
          <Stat label="Morality"    v={s.morality} />
        </div>
      </div>
      <ClientSceneOverlays nowPlayingCorner="tr" />
    </Scene>
  );
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div>
      <div className="stat">{label} · {v}</div>
      <div className="bar"><div className="fill" style={{ width: `${v}%` }} /></div>
    </div>
  );
}

function fmtAge(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function Scene({ children }: { children: React.ReactNode }) { return <>{children}</>; }
