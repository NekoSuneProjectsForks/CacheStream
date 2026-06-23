"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./util";
import {
  VISUALIZER_DEFAULTS,
  VISUALIZER_LAYOUTS,
  VISUALIZER_LAYOUT_LABELS,
  type VisualizerConfig,
} from "@/lib/visualizer-config";

/**
 * Visualizer tab — everything that controls the /scene/music spectrum:
 * layout (Trap Nation / NCS / Monstercat / Bars / Mirror / Waveform),
 * accent colors, sensitivity, bar count, FPS cap, beat FX (flash +
 * shake), particles/vinyl, and a custom background image.
 *
 * Config is persisted via POST /api/music/visualizer and polled live by
 * the scene, so edits apply to a running broadcast within a few seconds.
 * The preview iframe below mirrors the real scene at the same cadence.
 */
export function VisualizerTab() {
  const [vis, setVis] = useState<VisualizerConfig>(VISUALIZER_DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const v = await apiJson("/api/music/visualizer");
      if (v.visualizer) setVis(v.visualizer);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Persist a change (optimistic local update so controls feel instant).
  const updateVis = async (patch: Partial<VisualizerConfig>) => {
    setVis((cur) => ({ ...cur, ...patch }));
    try {
      const r = await apiJson("/api/music/visualizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (r.visualizer) setVis(r.visualizer);
    } catch (e: any) { setError(e.message); }
  };

  // ---- Custom background ----------------------------------------
  const bgInputRef = useRef<HTMLInputElement | null>(null);
  const uploadBg = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy("bg"); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", files[0]);
      const r = await fetch("/api/music/background", { method: "POST", body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      if (body.visualizer) setVis(body.visualizer);
      setPreviewKey((k) => k + 1);
    } catch (e: any) { setError(e.message); }
    finally {
      setBusy(null);
      if (bgInputRef.current) bgInputRef.current.value = "";
    }
  };
  const clearBg = async () => {
    setBusy("bg"); setError(null);
    try {
      const r = await apiJson("/api/music/background", { method: "DELETE" });
      if (r.visualizer) setVis(r.visualizer);
      setPreviewKey((k) => k + 1);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Visualizer</h2>
          <span className="muted">/scene/music spectrum</span>
        </div>
        <p className="hint">
          Style the Music scene spectrum. Changes apply to a running scene within a
          few seconds — no restart needed. Lower the FPS cap if the spectrum costs
          you frames in games.
        </p>

        <div className="vis-grid">
          <label className="vis-field">
            <span className="vis-label">Layout</span>
            <select className="input" value={vis.layout}
                    onChange={(e) => updateVis({ layout: e.target.value as VisualizerConfig["layout"] })}>
              {VISUALIZER_LAYOUTS.map((l) => (
                <option key={l} value={l}>{VISUALIZER_LAYOUT_LABELS[l]}</option>
              ))}
            </select>
          </label>

          <label className="vis-field">
            <span className="vis-label">FPS cap <span className="mono">{vis.fps}</span></span>
            <input type="range" min={15} max={30} step={1} value={vis.fps}
                   onChange={(e) => updateVis({ fps: Number(e.target.value) })} />
          </label>

          <label className="vis-field">
            <span className="vis-label">Sensitivity <span className="mono">{vis.sensitivity.toFixed(2)}×</span></span>
            <input type="range" min={0.5} max={2.5} step={0.05} value={vis.sensitivity}
                   onChange={(e) => updateVis({ sensitivity: Number(e.target.value) })} />
          </label>

          <label className="vis-field">
            <span className="vis-label">Bar count <span className="mono">{vis.barCount}</span></span>
            <input type="range" min={16} max={96} step={2} value={vis.barCount}
                   onChange={(e) => updateVis({ barCount: Number(e.target.value) })} />
          </label>

          <label className="vis-field">
            <span className="vis-label">Accent</span>
            <input type="color" className="vis-color" value={vis.accent}
                   onChange={(e) => updateVis({ accent: e.target.value })} />
          </label>

          <label className="vis-field">
            <span className="vis-label">Accent 2</span>
            <input type="color" className="vis-color" value={vis.accent2}
                   onChange={(e) => updateVis({ accent2: e.target.value })} />
          </label>
        </div>

        <div className="vis-toggles">
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={vis.flash}
                   onChange={(e) => updateVis({ flash: e.target.checked })} />
            Beat flash <span className="muted">(all)</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={vis.shake}
                   onChange={(e) => updateVis({ shake: e.target.checked })} />
            Beat shake <span className="muted">(all)</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={vis.mirror}
                   onChange={(e) => updateVis({ mirror: e.target.checked })} />
            Mirror reflection <span className="muted">(bars)</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={vis.particles}
                   onChange={(e) => updateVis({ particles: e.target.checked })} />
            Particles <span className="muted">(circular)</span>
          </label>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={vis.showVinyl}
                   onChange={(e) => updateVis({ showVinyl: e.target.checked })} />
            Spinning vinyl <span className="muted">(bars)</span>
          </label>
        </div>

        <div className="vis-bg">
          <div className="vis-label" style={{ marginBottom: 6 }}>Background</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Defaults to the built-in gradient. Upload an image (or paste a URL) to
            use your own — it applies to the running scene within a few seconds.
          </p>
          <div className="row gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="input mono grow"
              placeholder="https://… image URL (optional)"
              value={vis.background}
              onChange={(e) => setVis({ ...vis, background: e.target.value })}
              onBlur={(e) => updateVis({ background: e.target.value.trim() })}
            />
            <button className="btn-ghost sm" disabled={!!busy}
                    onClick={() => bgInputRef.current?.click()}>
              {busy === "bg" ? "…" : "Upload"}
            </button>
            <button className="btn-ghost sm" disabled={!!busy || !vis.background}
                    onClick={clearBg}>Clear</button>
            <input
              type="file" ref={bgInputRef}
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: "none" }}
              onChange={(e) => uploadBg(e.target.files)}
            />
          </div>
          {vis.background && (
            <div className="vis-bg-preview"
                 style={{ backgroundImage: `url("${vis.background.replace(/["\\]/g, "")}")` }} />
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Live preview</h2>
          <button className="btn-ghost sm" onClick={() => setPreviewKey((k) => k + 1)}>Reload</button>
        </div>
        <p className="hint">
          Mirrors <code>/scene/music</code>. It tracks config changes on the same
          ~5s cadence as the broadcast; hit Reload to refresh immediately.
        </p>
        <div className="vis-preview-frame">
          <iframe key={previewKey} src="/scene/music" title="Music scene preview" />
        </div>
      </section>

      <style jsx>{`
        .vis-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 14px;
          margin-top: 6px;
        }
        .vis-field { display: flex; flex-direction: column; gap: 6px; }
        .vis-label {
          font-size: 10px; letter-spacing: .22em; text-transform: uppercase;
          color: var(--text-mute);
          display: flex; justify-content: space-between; align-items: center;
        }
        .vis-field input[type="range"] { width: 100%; accent-color: var(--neon-cyan); }
        .vis-color {
          width: 100%; height: 34px; padding: 2px;
          background: rgba(5,6,10,0.4);
          border: 1px solid var(--line); border-radius: 4px; cursor: pointer;
        }
        .vis-toggles {
          display: flex; flex-wrap: wrap; gap: 18px;
          margin-top: 14px; padding-top: 12px;
          border-top: 1px solid var(--line-soft);
          font-size: .85rem; color: var(--text-dim);
        }
        .vis-toggles input[type="checkbox"] { accent-color: var(--neon-cyan); }
        .vis-bg {
          margin-top: 14px; padding-top: 12px;
          border-top: 1px solid var(--line-soft);
        }
        .vis-bg-preview {
          margin-top: 10px;
          height: 90px; border-radius: 4px;
          border: 1px solid var(--line);
          background-size: cover; background-position: center;
        }
        .vis-preview-frame {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          border: 1px solid var(--line);
          border-radius: 4px;
          overflow: hidden;
          background: #04050a;
        }
        .vis-preview-frame :global(iframe) {
          position: absolute; inset: 0;
          width: 100%; height: 100%; border: 0;
        }
      `}</style>
    </>
  );
}
