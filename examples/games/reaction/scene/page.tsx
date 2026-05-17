"use client";

/**
 * Reaction Race scene
 *
 * Copy to: apps/web/src/app/scene/reaction/page.tsx
 *
 * Subscribes to /api/games/reaction/stream (SSE). Two visual
 * modes:
 *   - Active round → giant target word + countdown
 *   - Idle         → leaderboard + "next round in N seconds"
 *
 * All cyberpunk styling lives in this file; the example is
 * intentionally self-contained so newcomers can read one file
 * top-to-bottom.
 */

import { useEffect, useState } from "react";

interface ReactionState {
  phase: "idle" | "active";
  target: string | null;
  startedAt: number | null;
  endsAt: number | null;
  lastWinner: { login: string; name: string; ms: number } | null;
  nextRoundAt: number;
  top: Array<{ login: string; name: string; wins: number }>;
}

export default function ReactionScene() {
  const [state, setState] = useState<ReactionState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // SSE subscription.
  useEffect(() => {
    const es = new EventSource("/api/games/reaction/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.state) setState(data.state);
      } catch {}
    };
    return () => es.close();
  }, []);

  // Tick the local clock so countdowns are smooth without
  // re-rendering on every server push.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  if (!state) {
    return <div style={{ color: "#aaa", padding: 32 }}>Connecting…</div>;
  }

  const remainMs = Math.max(0, (state.endsAt || 0) - now);
  const nextInMs = Math.max(0, state.nextRoundAt - now);

  return (
    <>
      <style>{css}</style>
      <main className="scene">
        <div className="grid"  />
        <div className="scanlines" />

        {state.phase === "active" ? (
          <div className="active">
            <div className="badge">
              <span className="dot" /> ROUND LIVE
            </div>
            <div className="prompt">TYPE THIS WORD</div>
            <div className="target" data-text={state.target ?? ""}>
              {state.target}
            </div>
            <div className="timer">
              {(remainMs / 1000).toFixed(1)}s
            </div>
          </div>
        ) : (
          <div className="idle">
            <div className="badge">
              <span className="dot dim" /> WAITING
            </div>
            {state.lastWinner ? (
              <div className="last">
                Last win — <strong>{state.lastWinner.name}</strong>{" "}
                in <strong>{(state.lastWinner.ms / 1000).toFixed(2)}s</strong>
              </div>
            ) : (
              <div className="last muted">No winner yet — round drops any second.</div>
            )}
            <div className="next">Next round in {(nextInMs / 1000).toFixed(0)}s</div>

            <h2 className="board-title">LEADERBOARD</h2>
            <ol className="board">
              {state.top.length === 0 && <li className="empty">First chatter to win goes here.</li>}
              {state.top.map((row, i) => (
                <li key={row.login} className={i === 0 ? "first" : ""}>
                  <span className="rank">#{i + 1}</span>
                  <span className="name">{row.name}</span>
                  <span className="wins">{row.wins.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </main>
    </>
  );
}

// ---- Styling (inline so this example is one file) -------------

const css = `
  html, body {
    margin: 0; height: 100%; overflow: hidden;
    background: #05060a; color: #e6f7ff;
    font-family: "Segoe UI", system-ui, sans-serif;
  }
  .scene {
    position: relative;
    width: 100vw; height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(ellipse at 50% 30%, rgba(138,43,255,.18) 0%, transparent 60%),
      radial-gradient(ellipse at 50% 100%, rgba(0,240,255,.14) 0%, transparent 70%),
      #05060a;
  }
  .grid {
    position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(rgba(0,240,255,.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,240,255,.06) 1px, transparent 1px);
    background-size: 80px 80px;
    mask-image: radial-gradient(ellipse at center, #000 35%, transparent 75%);
    animation: drift 14s linear infinite;
  }
  @keyframes drift {
    from { background-position: 0 0, 0 0; }
    to   { background-position: 0 80px, 80px 0; }
  }
  .scanlines {
    position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(to bottom,
      rgba(255,255,255,.015) 0 1px, transparent 1px 3px);
    mix-blend-mode: overlay;
    opacity: .55;
  }

  .badge {
    display: inline-flex; align-items: center; gap: .6rem;
    padding: .55rem 1.4rem;
    border: 1px solid rgba(0,240,255,.35);
    border-radius: 999px;
    background: rgba(10,13,24,.55);
    font-size: .9rem; letter-spacing: .4em; text-transform: uppercase;
    color: rgba(230,247,255,.7);
  }
  .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 12px #4ade80;
    animation: pulse 1.4s ease-in-out infinite;
  }
  .dot.dim { background: rgba(230,247,255,.3); box-shadow: none; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

  .active {
    text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 2rem;
    z-index: 1;
  }
  .prompt { font-size: 1.2rem; letter-spacing: .35em; text-transform: uppercase;
            color: rgba(230,247,255,.7); }
  .target {
    position: relative;
    font-size: clamp(6rem, 14vw, 14rem);
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    color: #fff;
    text-shadow:
      0 0 16px rgba(0,240,255,.8),
      0 0 48px rgba(0,240,255,.6),
      0 0 120px rgba(138,43,255,.55);
    animation: target-pulse 1.4s ease-in-out infinite;
  }
  @keyframes target-pulse {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.03); }
  }
  .target::before,
  .target::after {
    content: attr(data-text);
    position: absolute; inset: 0;
    pointer-events: none; mix-blend-mode: screen;
  }
  .target::before {
    color: #ff2bd6;
    transform: translate(-3px, 0);
    animation: glitch 4.8s steps(1) infinite;
  }
  .target::after {
    color: #00f0ff;
    transform: translate(3px, 0);
    animation: glitch 5.6s steps(1) infinite reverse;
  }
  @keyframes glitch {
    0%, 92%, 100% { transform: translate(0, 0); opacity: 0; }
    93%           { transform: translate(-4px, 1px); opacity: .6; }
    96%           { transform: translate(3px, -2px); opacity: .55; }
  }
  .timer {
    font-family: "JetBrains Mono", monospace;
    font-size: clamp(2rem, 4vw, 3.4rem);
    color: #00f0ff;
    text-shadow: 0 0 18px rgba(0,240,255,.5);
  }

  .idle {
    width: min(900px, 90vw);
    display: flex; flex-direction: column; align-items: center; gap: 1rem;
    z-index: 1;
  }
  .last  { font-size: 1.15rem; color: rgba(230,247,255,.85); margin-top: .5rem; }
  .last.muted { color: rgba(230,247,255,.45); }
  .next  { font-family: "JetBrains Mono", monospace;
           font-size: 1rem; letter-spacing: .25em;
           color: rgba(230,247,255,.5); text-transform: uppercase; }

  .board-title {
    margin: 2rem 0 .5rem;
    font-size: 1.2rem; letter-spacing: .4em; text-transform: uppercase;
    color: rgba(230,247,255,.7);
    border-bottom: 1px solid rgba(0,240,255,.2);
    padding-bottom: .5rem; width: 100%;
    text-align: center;
  }
  .board {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 6px;
    width: 100%;
  }
  .board li {
    display: grid; grid-template-columns: 60px 1fr auto; gap: 14px;
    align-items: center;
    padding: 10px 16px;
    background: rgba(10,13,24,.55);
    border: 1px solid rgba(0,240,255,.18);
    border-radius: 4px;
  }
  .board li.first {
    border-color: rgba(0,240,255,.5);
    box-shadow: 0 0 18px rgba(0,240,255,.15);
  }
  .board li.empty {
    grid-template-columns: 1fr;
    color: rgba(230,247,255,.4); font-style: italic;
  }
  .rank { font-family: "JetBrains Mono", monospace;
          color: rgba(230,247,255,.5); font-weight: 800; }
  .name { font-weight: 700; }
  .wins { font-family: "JetBrains Mono", monospace;
          color: #00f0ff; font-weight: 800;
          text-shadow: 0 0 10px rgba(0,240,255,.45); }
`;
