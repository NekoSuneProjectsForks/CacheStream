"use client";

/**
 * Scene-overlay toggle card for the Branding tab.
 *
 * Lets the operator enable / disable each overlay globally and
 * pick its on-screen corner. Per-scene overrides via SceneFrame
 * props still win — this is the global default.
 *
 * Reads + writes /api/overlays/config. Saves are immediate (no
 * "Save" button); each toggle posts on change. The card stays
 * responsive even on a slow Pi because the config blob is tiny.
 */

import { useEffect, useState } from "react";
import { apiJson } from "./util";

type Corner = "br" | "bl" | "tr" | "tl";

interface OverlayConfig {
  nowPlaying:   { enabled: boolean; corner: Corner };
  chat:         { enabled: boolean; corner: Corner };
  alertsTicker: { enabled: boolean };
  streamStats:  { enabled: boolean; corner: Corner };
}

const CORNERS: Array<{ id: Corner; label: string }> = [
  { id: "tl", label: "Top left" },
  { id: "tr", label: "Top right" },
  { id: "bl", label: "Bottom left" },
  { id: "br", label: "Bottom right" },
];

export function OverlayConfigCard() {
  const [cfg, setCfg] = useState<OverlayConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiJson("/api/overlays/config");
        setCfg(data as OverlayConfig);
      } catch (e: any) { setError(e.message); }
    })();
  }, []);

  const patch = async (next: OverlayConfig) => {
    setCfg(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      await apiJson("/api/overlays/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!cfg) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Scene overlays</h2>
        <span className="tag">applies to every scene</span>
      </div>
      <p className="hint">
        Drop a Now Playing card, live chat box, follow/sub ticker, or
        viewer count badge onto every scene. Toggles save immediately;
        switch scene on the streamer to see changes go live.
      </p>

      <div className="overlay-grid">
        <Row
          title="Now Playing card"
          desc="Shows the current track or radio source. Hides when music is idle."
          enabled={cfg.nowPlaying.enabled}
          onToggle={(v) => patch({ ...cfg, nowPlaying: { ...cfg.nowPlaying, enabled: v } })}
          corner={cfg.nowPlaying.corner}
          onCorner={(c) => patch({ ...cfg, nowPlaying: { ...cfg.nowPlaying, corner: c } })}
        />
        <Row
          title="Chat overlay"
          desc="Recent chat messages in a corner stack. Auto-fades old lines."
          enabled={cfg.chat.enabled}
          onToggle={(v) => patch({ ...cfg, chat: { ...cfg.chat, enabled: v } })}
          corner={cfg.chat.corner}
          onCorner={(c) => patch({ ...cfg, chat: { ...cfg.chat, corner: c } })}
        />
        <Row
          title="Alerts ticker"
          desc="Bottom marquee of recent follows, subs, gifts, cheers and raids."
          enabled={cfg.alertsTicker.enabled}
          onToggle={(v) => patch({ ...cfg, alertsTicker: { enabled: v } })}
        />
        <Row
          title="Stream stats badge"
          desc="LIVE indicator, uptime, viewer count. Hides when Twitch reports offline."
          enabled={cfg.streamStats.enabled}
          onToggle={(v) => patch({ ...cfg, streamStats: { ...cfg.streamStats, enabled: v } })}
          corner={cfg.streamStats.corner}
          onCorner={(c) => patch({ ...cfg, streamStats: { ...cfg.streamStats, corner: c } })}
        />
      </div>

      {busy && <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>saving…</div>}
      {error && <div className="error" style={{ marginTop: 8 }}>⚠ {error}</div>}

      {/* global (not scoped): the switch + corner buttons are rendered by
          the <Row> child component, so styled-jsx's per-component scoping
          wouldn't reach them. Everything is namespaced under .overlay-grid
          so nothing leaks to other cards. */}
      <style jsx global>{`
        .overlay-grid {
          display: grid;
          gap: 14px;
          margin-top: .5rem;
        }
        .overlay-grid .ovl-row {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 14px;
          align-items: center;
          padding: 12px 14px;
          background: rgba(0,0,0,.18);
          border: 1px solid var(--line);
          border-radius: 6px;
          transition: border-color .12s ease, background .12s ease;
        }
        .overlay-grid .ovl-row:hover { border-color: rgba(0,240,255,.25); }
        .overlay-grid .ovl-desc { color: var(--text-dim); font-size: 12px; }
        .overlay-grid .ovl-title { font-weight: 700; margin-bottom: 2px; }

        /* ----- Corner picker: a 2×2 grid that maps to the screen ----- */
        .overlay-grid .ovl-corner {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 3px;
          width: 66px;
          padding: 3px;
          border-radius: 7px;
          background: rgba(0,0,0,.3);
          border: 1px solid var(--line);
        }
        .overlay-grid .ovl-corner button {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: .08em;
          padding: 6px 0;
          border: 1px solid transparent;
          background: rgba(255,255,255,.04);
          color: var(--text-mute);
          border-radius: 4px;
          cursor: pointer;
          transition: background .12s ease, color .12s ease, box-shadow .12s ease;
        }
        .overlay-grid .ovl-corner button:hover:not(:disabled):not(.active) {
          background: rgba(0,240,255,.10);
          color: var(--text);
        }
        .overlay-grid .ovl-corner button.active {
          color: #021018;
          background: var(--cs-accent-solid, #00f0ff);
          border-color: var(--cs-accent-solid, #00f0ff);
          box-shadow: 0 0 10px rgba(0,240,255,.45);
        }
        .overlay-grid .ovl-corner button:disabled {
          opacity: .4;
          cursor: not-allowed;
        }

        /* ----- Toggle switch ----- */
        .overlay-grid .switch {
          -webkit-appearance: none;
          appearance: none;
          margin: 0;
          width: 40px; height: 22px;
          background: rgba(255,255,255,0.14);
          border-radius: 999px;
          position: relative;
          cursor: pointer;
          flex: none;
          transition: background .15s ease;
        }
        .overlay-grid .switch:checked {
          background: var(--cs-accent-solid, #00f0ff);
          box-shadow: 0 0 10px rgba(0,240,255,.4);
        }
        .overlay-grid .switch::after {
          content: "";
          position: absolute;
          width: 18px; height: 18px; border-radius: 50%;
          background: #fff;
          top: 2px; left: 2px;
          transition: left .15s ease;
        }
        .overlay-grid .switch:checked::after { left: 20px; }
      `}</style>
    </section>
  );
}

function Row({
  title, desc, enabled, onToggle, corner, onCorner,
}: {
  title: string;
  desc: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  corner?: Corner;
  onCorner?: (c: Corner) => void;
}) {
  return (
    <div className="ovl-row">
      <input
        type="checkbox"
        className="switch"
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={`Toggle ${title}`}
      />
      <div>
        <div className="ovl-title">{title}</div>
        <div className="ovl-desc">{desc}</div>
      </div>
      {corner && onCorner ? (
        <div className="ovl-corner">
          {CORNERS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={corner === c.id ? "active" : ""}
              disabled={!enabled}
              onClick={() => onCorner(c.id)}
              title={c.label}
            >
              {c.id.toUpperCase()}
            </button>
          ))}
        </div>
      ) : <div />}
    </div>
  );
}
