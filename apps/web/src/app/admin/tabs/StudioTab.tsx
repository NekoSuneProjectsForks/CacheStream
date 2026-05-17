"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { OverlaySet, Overlay, ScenePreset } from "@/lib/store";
import type { StreamerStatus } from "@/lib/streamer-client";
import { apiJson } from "./util";

/**
 * Studio tab — large preview canvas with draggable overlays,
 * sidebar for layer management + inspector, small floating
 * "Program" thumbnail showing what's actually live.
 *
 *  ┌──────────────────────────────────────────┐  ┌──────────┐
 *  │                                          │  │  LAYERS  │
 *  │           PREVIEW CANVAS                 │  │          │
 *  │           (drag overlays here)           │  │  + text  │
 *  │                                          │  │  + html  │
 *  │                                          │  │  + image │
 *  │                                          │  │  + chat  │
 *  │     ┌──────────┐                         │  │  + alert │
 *  │     │ Program  │                         │  │ ──────── │
 *  │     │ (live)   │                         │  │ layer 1  │
 *  │     └──────────┘                         │  │ layer 2  │
 *  └──────────────────────────────────────────┘  └──────────┘
 *  [ Scene preset ▾ ] [ Overlay set ▾ ] [ TAKE → PROGRAM ]
 */

const STAGE_W = 1920;
const STAGE_H = 1080;

interface MoveableOverlay extends Overlay {
  _x?: number; _y?: number; _w?: number; _h?: number;
}

export function StudioTab() {
  const [scenes, setScenes] = useState<ScenePreset[]>([]);
  const [overlaySets, setOverlaySets] = useState<OverlaySet[]>([]);
  const [activeOverlayId, setActiveOverlayId] = useState<string | null>(null);
  const [streamerStatus, setStreamerStatus] = useState<StreamerStatus | null>(null);

  const [previewSceneUrl, setPreviewSceneUrl] = useState<string>("");
  const [draftSetId, setDraftSetId] = useState<string>("");
  const [overlays, setOverlays] = useState<MoveableOverlay[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(false);
  const [showThirds, setShowThirds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ---- Auto-fit canvas to its container --------------------------
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth - 48;  // padding
      const h = wrap.clientHeight - 48;
      setScale(Math.max(0.05, Math.min(w / STAGE_W, h / STAGE_H)));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // ---- Initial load ----------------------------------------------
  const load = useCallback(async () => {
    try {
      const [s, ov, status] = await Promise.all([
        apiJson("/api/scenes"),
        apiJson("/api/overlays"),
        apiJson("/api/stream/status"),
      ]);
      setScenes(s.scenes || []);
      setOverlaySets(ov.overlaySets || []);
      setActiveOverlayId(ov.activeOverlaySetId || null);
      setStreamerStatus(status.status);
      if (!previewSceneUrl) {
        if (status.status?.sceneUrl) setPreviewSceneUrl(status.status.sceneUrl);
        else if (s.scenes?.length)  setPreviewSceneUrl(s.scenes[0].url);
      }
    } catch (e: any) { setError(e.message); }
  }, [previewSceneUrl]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await apiJson("/api/stream/status");
        setStreamerStatus(r.status);
      } catch {}
    }, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!draftSetId) { setOverlays([]); return; }
    const set = overlaySets.find((o) => o.id === draftSetId);
    if (!set) return;
    setOverlays(set.overlays.map(hydrate));
  }, [draftSetId, overlaySets]);

  // ---- Helpers ---------------------------------------------------
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const saveDraft = () =>
    run("save", async () => {
      if (!draftSetId) return;
      const { overlaySet } = await apiJson(`/api/overlays/${draftSetId}/update`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overlays: overlays.map(dehydrate) }),
      });
      setOverlaySets((s) => s.map((x) => (x.id === draftSetId ? overlaySet : x)));
    });

  const saveAsNewSet = () =>
    run("save-new", async () => {
      const name = prompt("Name for the new overlay set?")?.trim();
      if (!name) return;
      const { overlaySet } = await apiJson("/api/overlays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, overlays: overlays.map(dehydrate) }),
      });
      setOverlaySets((s) => [...s, overlaySet]);
      setDraftSetId(overlaySet.id);
    });

  const takeToProgram = () =>
    run("take", async () => {
      if (previewSceneUrl && previewSceneUrl !== streamerStatus?.sceneUrl) {
        const r = await apiJson("/api/stream/scene", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: previewSceneUrl }),
        });
        setStreamerStatus(r.status);
      }
      if (overlays.length === 0 && activeOverlayId) {
        const r = await apiJson("/api/overlays/clear", { method: "POST" });
        setStreamerStatus(r.status); setActiveOverlayId(null);
      } else if (draftSetId) {
        await saveDraft();
        const r = await apiJson(`/api/overlays/${draftSetId}/activate`, { method: "POST" });
        setStreamerStatus(r.status); setActiveOverlayId(draftSetId);
      } else if (overlays.length > 0) {
        const { overlaySet } = await apiJson("/api/overlays", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Studio draft", overlays: overlays.map(dehydrate) }),
        });
        setOverlaySets((s) => [...s, overlaySet]);
        setDraftSetId(overlaySet.id);
        const r = await apiJson(`/api/overlays/${overlaySet.id}/activate`, { method: "POST" });
        setStreamerStatus(r.status); setActiveOverlayId(overlaySet.id);
      }
    });

  // ---- Drag / resize ---------------------------------------------
  const dragRef = useRef<null | {
    id: string;
    mode: "move" | "resize";
    startX: number; startY: number;
    ox: number; oy: number; ow: number; oh: number;
  }>(null);

  const onPointerDown = (e: React.PointerEvent, id: string, mode: "move" | "resize") => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setSelectedId(id);
    const o = overlays.find((x) => x.id === id);
    if (!o) return;
    dragRef.current = {
      id, mode,
      startX: e.clientX, startY: e.clientY,
      ox: o._x ?? 100, oy: o._y ?? 100, ow: o._w ?? 420, oh: o._h ?? 140,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / scale;
    const dy = (e.clientY - d.startY) / scale;
    setOverlays((prev) =>
      prev.map((o) => {
        if (o.id !== d.id) return o;
        if (d.mode === "move") {
          return {
            ...o,
            _x: clamp(d.ox + dx, 0, STAGE_W - (o._w || 0)),
            _y: clamp(d.oy + dy, 0, STAGE_H - (o._h || 0)),
          };
        }
        return { ...o, _w: Math.max(80, d.ow + dx), _h: Math.max(40, d.oh + dy) };
      })
    );
  };

  const onPointerUp = () => { dragRef.current = null; };

  // ---- Layer ops -------------------------------------------------
  const addLayer = (type: Overlay["type"]) => {
    const id = crypto.randomUUID();
    setOverlays((o) => [
      ...o,
      {
        id, type,
        text: type === "text" ? "Live" : undefined,
        html: type === "html" ? "<div>HTML</div>" : undefined,
        src:
          type === "image" ? "" :
          type === "chat"  ? "http://web:7788/widgets/chat" :
          type === "alert" ? "http://web:7788/widgets/alert" :
          undefined,
        _x: 80, _y: 80, _w: 420, _h: type === "chat" ? 320 : 140,
      },
    ]);
    setSelectedId(id);
  };
  const removeLayer = (id: string) => {
    setOverlays((o) => o.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const updateLayer = (id: string, patch: Partial<MoveableOverlay>) =>
    setOverlays((o) => o.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const selected = overlays.find((o) => o.id === selectedId) || null;
  const programUrl = streamerStatus?.sceneUrl || previewSceneUrl;
  const hasScenePresets = scenes.length > 0;

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      {/* ============ Toolbar ============ */}
      <section className="card studio-toolbar">
        <div className="row gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <span className="studio-label">SCENE</span>
          <select
            className="input"
            value={previewSceneUrl}
            onChange={(e) => setPreviewSceneUrl(e.target.value)}
            style={{ minWidth: 220 }}
          >
            <option value="">— pick scene —</option>
            {scenes.map((s) => <option key={s.id} value={s.url}>{s.name}</option>)}
          </select>

          <span className="studio-label">OVERLAYS</span>
          <select
            className="input"
            value={draftSetId}
            onChange={(e) => setDraftSetId(e.target.value)}
            style={{ minWidth: 220 }}
          >
            <option value="">— draft (unsaved) —</option>
            {overlaySets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}{activeOverlayId === o.id ? "  • LIVE" : ""}
              </option>
            ))}
          </select>

          <div style={{ flex: 1 }} />

          <label className="row" style={{ gap: 6, color: "var(--text-dim)", fontSize: ".75rem" }}>
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Grid
          </label>
          <label className="row" style={{ gap: 6, color: "var(--text-dim)", fontSize: ".75rem" }}>
            <input type="checkbox" checked={showThirds} onChange={(e) => setShowThirds(e.target.checked)} /> Thirds
          </label>

          <button className="btn-ghost"   disabled={!!busy || !draftSetId} onClick={saveDraft}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button className="btn-ghost"   disabled={!!busy || overlays.length === 0} onClick={saveAsNewSet}>
            {busy === "save-new" ? "…" : "Save as…"}
          </button>
          <button className="btn-primary" disabled={!!busy} onClick={takeToProgram}>
            {busy === "take" ? "Taking…" : "Take → Program"}
          </button>
        </div>
      </section>

      {/* ============ Stage + sidebar ============ */}
      <section className="card studio-stage-card">
        <div className="studio-grid">
          <div className="studio-canvas-wrap" ref={canvasWrapRef}>
            <div
              className="studio-canvas"
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerDown={() => setSelectedId(null)}
              style={{ width: STAGE_W * scale, height: STAGE_H * scale }}
            >
              {!previewSceneUrl && (
                <div className="studio-empty">
                  <div className="studio-empty-title">No scene selected</div>
                  <div className="studio-empty-sub">
                    {hasScenePresets
                      ? <>Pick one from the dropdown above ↑</>
                      : <>You have no scene presets yet. Open the <b>Scenes</b> tab
                          to save built-ins as presets, or paste a URL into
                          <b> Status → Scene presets</b>:
                          <div className="studio-empty-list">
                            <code>http://web:7788/scene</code>
                            <code>http://web:7788/scene/starting-soon</code>
                            <code>http://web:7788/scene/brb</code>
                            <code>http://web:7788/scene/ending</code>
                            <code>http://web:7788/scene/offline</code>
                            <code>http://web:7788/scene/music</code>
                            <code>http://web:7788/scene/pet</code>
                            <code>http://web:7788/scene/datacenter</code>
                          </div>
                        </>}
                  </div>
                </div>
              )}

              {previewSceneUrl && (
                <iframe
                  src={previewSceneUrl}
                  className="studio-iframe"
                  style={{
                    width: STAGE_W,
                    height: STAGE_H,
                    transform: `scale(${scale})`,
                  }}
                />
              )}

              {showGrid   && <div className="studio-grid-lines" />}
              {showThirds && <div className="studio-thirds-lines" />}

              <div className="studio-res-badge">1920 × 1080  ·  {Math.round(scale * 100)}%</div>

              {overlays.map((o) => {
                const isSelected = o.id === selectedId;
                return (
                  <div
                    key={o.id}
                    className={`studio-layer ${isSelected ? "selected" : ""}`}
                    onPointerDown={(e) => onPointerDown(e, o.id, "move")}
                    style={{
                      left:   (o._x ?? 0) * scale,
                      top:    (o._y ?? 0) * scale,
                      width:  (o._w ?? 420) * scale,
                      height: (o._h ?? 140) * scale,
                    }}
                  >
                    <div className="studio-layer-content">
                      <span className="studio-layer-tag">{o.type}</span>
                      <span className="studio-layer-label">{labelFor(o)}</span>
                    </div>
                    {isSelected && (
                      <div
                        className="studio-resize-handle"
                        onPointerDown={(e) => onPointerDown(e, o.id, "resize")}
                      />
                    )}
                  </div>
                );
              })}

              {programUrl && (
                <div
                  className="studio-pgm"
                  style={{
                    width:  STAGE_W * 0.32 * scale,
                    height: STAGE_H * 0.32 * scale,
                  }}
                >
                  <div className="studio-pgm-label">
                    <span className={`studio-pgm-dot ${streamerStatus?.state === "running" ? "on" : ""}`} />
                    PGM · {streamerStatus?.state || "—"}
                  </div>
                  <iframe
                    src={programUrl}
                    style={{
                      width: STAGE_W,
                      height: STAGE_H,
                      transform: `scale(${scale * 0.32})`,
                      transformOrigin: "top left",
                      border: 0,
                      pointerEvents: "none",
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          <aside className="studio-sidebar">
            <div className="studio-sidebar-section">
              <div className="studio-sidebar-title">Add layer</div>
              <div className="studio-add-grid">
                <button className="btn-ghost sm" onClick={() => addLayer("text")}>＋ Text</button>
                <button className="btn-ghost sm" onClick={() => addLayer("html")}>＋ HTML</button>
                <button className="btn-ghost sm" onClick={() => addLayer("image")}>＋ Image</button>
                <button className="btn-ghost sm" onClick={() => addLayer("chat")}>＋ Chat</button>
                <button className="btn-ghost sm" onClick={() => addLayer("alert")}>＋ Alert</button>
              </div>
            </div>

            <div className="studio-sidebar-section">
              <div className="studio-sidebar-title">
                Layers <span className="muted">· {overlays.length}</span>
              </div>
              {overlays.length === 0 && (
                <div className="muted" style={{ padding: "8px 0" }}>
                  Empty. Use “Add layer” above.
                </div>
              )}
              <div className="studio-layer-list">
                {overlays.map((o, i) => (
                  <div
                    key={o.id}
                    className={`studio-layer-row ${selectedId === o.id ? "active" : ""}`}
                    onClick={() => setSelectedId(o.id)}
                  >
                    <span className="studio-layer-row-icon">{iconFor(o.type)}</span>
                    <span className="studio-layer-row-name">
                      {labelFor(o) || `${o.type} ${i + 1}`}
                    </span>
                    <span
                      className="studio-layer-row-del"
                      onClick={(e) => { e.stopPropagation(); removeLayer(o.id); }}
                    >×</span>
                  </div>
                ))}
              </div>
            </div>

            {selected && (
              <div className="studio-sidebar-section">
                <div className="studio-sidebar-title">Inspector</div>
                <div className="studio-inspector">
                  {selected.type === "text" && (
                    <Field label="Text">
                      <input className="input" value={selected.text || ""}
                             onChange={(e) => updateLayer(selected.id, { text: e.target.value })} />
                    </Field>
                  )}
                  {selected.type === "html" && (
                    <Field label="HTML">
                      <textarea className="input mono" rows={3} value={selected.html || ""}
                                onChange={(e) => updateLayer(selected.id, { html: e.target.value })}
                                style={{ resize: "vertical" }} />
                    </Field>
                  )}
                  {(selected.type === "image" || selected.type === "chat" || selected.type === "alert") && (
                    <Field label="Source">
                      <input className="input mono" value={selected.src || ""}
                             onChange={(e) => updateLayer(selected.id, { src: e.target.value })} />
                    </Field>
                  )}
                  <div className="studio-inspector-grid">
                    <NumberField label="X" value={selected._x} onChange={(v) => updateLayer(selected.id, { _x: v })} />
                    <NumberField label="Y" value={selected._y} onChange={(v) => updateLayer(selected.id, { _y: v })} />
                    <NumberField label="W" value={selected._w} onChange={(v) => updateLayer(selected.id, { _w: v })} />
                    <NumberField label="H" value={selected._h} onChange={(v) => updateLayer(selected.id, { _h: v })} />
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      </section>

      <style jsx>{`
        :global(.studio-toolbar) { padding: 0.85rem 1.1rem; }
        .studio-label {
          color: var(--text-mute);
          font-size: 0.65rem;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          margin-right: 0.25rem;
        }
        :global(.studio-stage-card) { padding: 0; overflow: hidden; }
        .studio-grid {
          display: grid;
          grid-template-columns: 1fr 280px;
          min-height: 640px;
        }
        @media (max-width: 1000px) {
          .studio-grid { grid-template-columns: 1fr; }
        }

        .studio-canvas-wrap {
          position: relative;
          width: 100%;
          height: 640px;
          background:
            repeating-conic-gradient(rgba(255,255,255,0.015) 0% 25%, transparent 0% 50%) 0 0 / 24px 24px,
            #02030a;
          display: flex; align-items: center; justify-content: center;
          padding: 24px;
          overflow: hidden;
        }
        .studio-canvas {
          position: relative;
          overflow: hidden;
          background: #05060a;
          border: 1px solid rgba(0,240,255,0.25);
          box-shadow:
            0 0 0 1px rgba(0,240,255,0.04) inset,
            0 0 60px rgba(0,240,255,0.06),
            0 0 120px rgba(138,43,255,0.05);
          border-radius: 4px;
        }
        .studio-iframe {
          border: 0;
          transform-origin: top left;
          pointer-events: none;
          background: #05060a;
        }
        .studio-empty {
          position: absolute; inset: 0;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 24px; text-align: center; gap: 12px;
        }
        .studio-empty-title {
          font-size: 1rem; font-weight: 700; letter-spacing: 0.18em;
          text-transform: uppercase; color: var(--text-dim);
        }
        .studio-empty-sub { color: var(--text-mute); font-size: 0.82rem; max-width: 460px; }
        .studio-empty-list {
          display: flex; flex-direction: column; align-items: center; gap: 4px; margin-top: 10px;
        }
        .studio-empty-list :global(code) {
          font-size: 0.78rem; color: var(--neon-cyan);
          background: rgba(0,240,255,0.06);
          padding: 2px 8px; border-radius: 3px;
        }

        .studio-grid-lines {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(rgba(0,240,255,0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,240,255,0.08) 1px, transparent 1px);
          background-size: 8.333% 8.333%;
          pointer-events: none;
        }
        .studio-thirds-lines {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(rgba(255,43,214,0.5) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,43,214,0.5) 1px, transparent 1px);
          background-size: 33.333% 33.333%;
          background-position: 0 33.333%, 33.333% 0;
          background-repeat: no-repeat;
          pointer-events: none;
        }

        .studio-res-badge {
          position: absolute; top: 8px; left: 8px;
          padding: 3px 8px; font-size: 10px;
          letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--text-dim);
          background: rgba(5,6,10,0.7);
          border: 1px solid rgba(0,240,255,0.2);
          border-radius: 3px;
          pointer-events: none;
        }

        .studio-layer {
          position: absolute;
          border: 1px solid rgba(0,240,255,0.4);
          background: rgba(0,240,255,0.06);
          box-sizing: border-box;
          cursor: move;
          user-select: none;
          transition: border-color 0.1s, box-shadow 0.1s;
        }
        .studio-layer:hover { border-color: rgba(0,240,255,0.7); }
        .studio-layer.selected {
          border: 1px dashed var(--neon-cyan);
          box-shadow: 0 0 0 1px rgba(0,240,255,0.15), 0 0 18px rgba(0,240,255,0.25);
          background: rgba(0,240,255,0.1);
        }
        .studio-layer-content {
          position: absolute; inset: 0;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 4px;
          pointer-events: none;
          padding: 4px 8px;
        }
        .studio-layer-tag {
          font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
          color: var(--neon-cyan); opacity: 0.85;
        }
        .studio-layer-label {
          font-size: 11px; color: var(--text);
          text-align: center; max-width: 100%;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          text-shadow: 0 0 4px rgba(0,0,0,0.8);
        }
        .studio-resize-handle {
          position: absolute; right: -1px; bottom: -1px;
          width: 14px; height: 14px;
          background: var(--neon-cyan);
          cursor: nwse-resize;
          border-radius: 0 0 3px 0;
          box-shadow: 0 0 8px rgba(0,240,255,0.6);
        }

        .studio-pgm {
          position: absolute; right: 12px; bottom: 12px;
          border: 1px solid rgba(255,43,214,0.4);
          border-radius: 3px;
          overflow: hidden;
          background: #05060a;
          box-shadow: 0 0 18px rgba(255,43,214,0.25);
          pointer-events: none;
        }
        .studio-pgm-label {
          position: absolute; top: 4px; left: 6px;
          font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
          color: var(--text);
          background: rgba(5,6,10,0.75);
          padding: 2px 6px;
          border-radius: 2px;
          z-index: 2;
          display: flex; align-items: center; gap: 4px;
        }
        .studio-pgm-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--text-mute);
        }
        .studio-pgm-dot.on {
          background: #4ade80;
          box-shadow: 0 0 6px #4ade80;
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

        .studio-sidebar {
          border-left: 1px solid var(--line);
          background: rgba(5,6,10,0.55);
          padding: 18px 16px;
          display: flex; flex-direction: column; gap: 18px;
          max-height: 640px;
          overflow-y: auto;
        }
        @media (max-width: 1000px) {
          .studio-sidebar { border-left: 0; border-top: 1px solid var(--line); max-height: none; }
        }
        .studio-sidebar-section { display: flex; flex-direction: column; gap: 8px; }
        .studio-sidebar-title {
          font-size: 0.65rem; letter-spacing: 0.25em; text-transform: uppercase;
          color: var(--text-mute);
        }
        .studio-add-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
        }
        .studio-add-grid :global(button) { width: 100%; }

        .studio-layer-list { display: flex; flex-direction: column; gap: 4px; }
        .studio-layer-row {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 9px;
          background: rgba(10,13,24,0.55);
          border: 1px solid var(--line-soft);
          border-radius: 3px;
          color: var(--text);
          font-size: 0.82rem;
          cursor: pointer;
          transition: border-color 0.1s, background 0.1s;
        }
        .studio-layer-row:hover { border-color: rgba(0,240,255,0.4); }
        .studio-layer-row.active {
          border-color: var(--neon-cyan);
          background: rgba(0,240,255,0.08);
        }
        .studio-layer-row-icon {
          width: 22px; text-align: center;
          color: var(--neon-cyan); font-size: 0.95rem;
        }
        .studio-layer-row-name {
          flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .studio-layer-row-del {
          padding: 0 6px; color: var(--text-mute);
          line-height: 1;
        }
        .studio-layer-row-del:hover { color: var(--err); }

        .studio-inspector { display: flex; flex-direction: column; gap: 10px; }
        .studio-inspector-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
        }
      `}</style>
    </>
  );
}

function labelFor(o: MoveableOverlay): string {
  if (o.type === "text")  return o.text || "(text)";
  if (o.type === "image") return o.src || "(image)";
  if (o.type === "chat")  return "Live chat";
  if (o.type === "alert") return "Alert feed";
  if (o.type === "html")  return (o.html || "").slice(0, 40) || "(html)";
  return o.type;
}

function iconFor(t: Overlay["type"]): string {
  switch (t) {
    case "text":  return "T";
    case "html":  return "</>";
    case "image": return "▣";
    case "chat":  return "💬";
    case "alert": return "★";
    default:      return "·";
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase",
        color: "var(--text-mute)", marginBottom: 4,
      }}>{label}</div>
      {children}
    </div>
  );
}

function NumberField({
  label, value, onChange,
}: { label: string; value: number | undefined; onChange: (v: number) => void }) {
  return (
    <div>
      <div style={{
        fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase",
        color: "var(--text-mute)", marginBottom: 4,
      }}>{label}</div>
      <input
        type="number"
        className="input sm"
        value={Math.round(value ?? 0)}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </div>
  );
}

// ---- Position (de)serialisation ---------------------------------

function hydrate(o: Overlay): MoveableOverlay {
  const x = parsePx(o.left,
    o.right ? STAGE_W - parsePx(o.right, 0) - parsePx(o.width, 320) : 100);
  const y = parsePx(o.top,
    o.bottom ? STAGE_H - parsePx(o.bottom, 0) - parsePx(o.height, 80) : 100);
  const w = parsePx(o.width, 420);
  const h = parsePx(o.height, 140);
  return { ...o, _x: x, _y: y, _w: w, _h: h };
}

function dehydrate(o: MoveableOverlay): Overlay {
  const { _x, _y, _w, _h, ...rest } = o;
  return {
    ...rest,
    left:   _x !== undefined ? `${Math.round(_x)}px` : rest.left,
    top:    _y !== undefined ? `${Math.round(_y)}px` : rest.top,
    width:  _w !== undefined ? `${Math.round(_w)}px` : rest.width,
    height: _h !== undefined ? `${Math.round(_h)}px` : rest.height,
    right:  undefined,
    bottom: undefined,
  };
}

function parsePx(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const m = v.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (m) return Number(m[1]);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
