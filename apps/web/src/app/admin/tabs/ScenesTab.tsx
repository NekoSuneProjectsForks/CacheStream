"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./util";

type Template = "starting_soon" | "brb" | "ending" | "generic" | "raw_html";

interface CustomScene {
  id: string;
  slug: string;
  name: string;
  template: Template;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface BuiltIn {
  name: string;
  path: string;
  description: string;
}

const BUILTINS: BuiltIn[] = [
  { name: "Hello World",   path: "/scene",                description: "Default cyberpunk intro scene." },
  { name: "Starting Soon", path: "/scene/starting-soon",  description: "Animated standby. Pass ?title= / ?subtitle= / ?accent= / ?at=ISO." },
  { name: "BRB",           path: "/scene/brb",            description: "Be right back / intermission card." },
  { name: "Ending",        path: "/scene/ending",         description: "Off-air thank you. Pass ?twitch= / ?youtube= / ?twitter= / ?discord=." },
  { name: "Offline",       path: "/scene/offline",        description: "Neutral idle fallback." },
  { name: "Music / Radio", path: "/scene/music",          description: "Now-playing card with cover art + visualiser." },
  { name: "AI Pet",        path: "/scene/pet",            description: "Tamagotchi-style creature driven by chat." },
  { name: "Datacenter",    path: "/scene/datacenter",     description: "Twitch Plays Datacenter (NOC dashboard)." },
];

const TEMPLATE_LABELS: Record<Template, string> = {
  starting_soon: "Starting Soon",
  brb:           "BRB / Intermission",
  ending:        "Ending",
  generic:       "Generic (title + countdown)",
  raw_html:      "Raw HTML / CSS",
};

/**
 * Scenes tab — list every scene the operator can target as a
 * preset URL. Built-ins are read-only entries you can copy to
 * the clipboard or save as a preset. Custom scenes are editable.
 */
export function ScenesTab() {
  const [scenes, setScenes] = useState<CustomScene[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomScene | null>(null);

  const load = useCallback(async () => {
    try {
      const { scenes } = await apiJson("/api/scenes/custom");
      setScenes(scenes || []);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const createScene = async (template: Template) => {
    setBusy("create"); setError(null);
    try {
      const name = prompt(`Name for new "${TEMPLATE_LABELS[template]}" scene?`)?.trim();
      if (!name) { setBusy(null); return; }
      const { scene } = await apiJson("/api/scenes/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, template, config: defaultConfigFor(template) }),
      });
      setScenes((s) => [...s, scene]);
      setEditing(scene);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const saveScene = async () => {
    if (!editing) return;
    setBusy("save"); setError(null);
    try {
      const { scene } = await apiJson(`/api/scenes/custom/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editing.name,
          slug: editing.slug,
          template: editing.template,
          config: editing.config,
        }),
      });
      setScenes((s) => s.map((x) => (x.id === scene.id ? scene : x)));
      setEditing(scene);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const deleteScene = async (id: string) => {
    if (!confirm("Delete this scene?")) return;
    setBusy("delete");
    try {
      await apiJson(`/api/scenes/custom/${id}`, { method: "DELETE" });
      setScenes((s) => s.filter((x) => x.id !== id));
      if (editing?.id === id) setEditing(null);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const saveAsPreset = async (name: string, url: string) => {
    setBusy("preset"); setError(null);
    try {
      await apiJson("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      alert(`Saved "${name}" as a scene preset.`);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const copyUrl = (path: string) => {
    const url = `http://web:7788${path}`;
    navigator.clipboard?.writeText(url).catch(() => {});
  };

  const setCfg = (k: string, v: unknown) => {
    if (!editing) return;
    setEditing({ ...editing, config: { ...editing.config, [k]: v } });
  };
  const cfg = (k: string): string =>
    typeof editing?.config[k] === "string" ? (editing!.config[k] as string) : "";

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      {/* ============ Built-ins ============ */}
      <section className="card">
        <div className="card-head">
          <h2>Built-in scenes</h2>
        </div>
        <p className="hint">
          Real Next.js routes baked into the web container. Use them as scene preset URLs,
          or open them directly to verify they render before going live.
        </p>
        <ul className="scene-grid">
          {BUILTINS.map((b) => (
            <li key={b.path} className="scene-card">
              <div className="scene-card-head">
                <span className="scene-card-name">{b.name}</span>
                <span className="tag">built-in</span>
              </div>
              <div className="scene-card-path">http://web:7788{b.path}</div>
              <div className="scene-card-desc">{b.description}</div>
              <div className="scene-card-actions">
                <button className="btn-ghost   sm" onClick={() => copyUrl(b.path)}>Copy URL</button>
                <button className="btn-primary sm" disabled={!!busy} onClick={() => saveAsPreset(b.name, `http://web:7788${b.path}`)}>Save as preset</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ============ Custom scenes ============ */}
      <section className="card">
        <div className="card-head">
          <h2>Custom scenes <span className="muted">· {scenes.length}</span></h2>
          <div className="row" style={{ gap: 6 }}>
            {(Object.keys(TEMPLATE_LABELS) as Template[]).map((t) => (
              <button key={t} className="btn-ghost sm" disabled={!!busy} onClick={() => createScene(t)}>
                + {TEMPLATE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {scenes.length === 0 && (
          <div className="muted">No custom scenes yet. Pick a template above to start one.</div>
        )}

        <ul className="scene-grid">
          {scenes.map((s) => (
            <li key={s.id} className={`scene-card ${editing?.id === s.id ? "active" : ""}`}>
              <div className="scene-card-head">
                <span className="scene-card-name">{s.name}</span>
                <span className="tag">{TEMPLATE_LABELS[s.template] || s.template}</span>
              </div>
              <div className="scene-card-path">http://web:7788/scene/custom/{s.slug}</div>
              <div className="scene-card-actions">
                <button className="btn-ghost   sm" disabled={!!busy} onClick={() => setEditing(s)}>Edit</button>
                <button className="btn-ghost   sm" disabled={!!busy} onClick={() => copyUrl(`/scene/custom/${s.slug}`)}>Copy URL</button>
                <button className="btn-primary sm" disabled={!!busy} onClick={() => saveAsPreset(s.name, `http://web:7788/scene/custom/${s.slug}`)}>Save as preset</button>
                <button className="btn-ghost   sm" disabled={!!busy} onClick={() => deleteScene(s.id)}>×</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ============ Editor ============ */}
      {editing && (
        <section className="card">
          <div className="card-head">
            <h2>Edit · {editing.name}</h2>
            <span className="tag">{TEMPLATE_LABELS[editing.template]}</span>
          </div>

          <div className="editor-grid">
            <Field label="Name">
              <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Slug (URL)">
              <input className="input mono" value={editing.slug}
                     onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
                     pattern="[a-z0-9-]+" />
              <span className="hint mono">http://web:7788/scene/custom/{editing.slug}</span>
            </Field>

            {editing.template !== "raw_html" && (
              <>
                <Field label="Title">
                  <input className="input" value={cfg("title")} onChange={(e) => setCfg("title", e.target.value)} />
                </Field>
                <Field label="Subtitle">
                  <input className="input" value={cfg("subtitle")} onChange={(e) => setCfg("subtitle", e.target.value)} />
                </Field>
                <Field label="Accent colour">
                  <div className="row" style={{ gap: 6 }}>
                    <input type="color" value={cfg("accent") || "#00f0ff"} onChange={(e) => setCfg("accent", e.target.value)} />
                    <input className="input mono" value={cfg("accent")} placeholder="#00f0ff" onChange={(e) => setCfg("accent", e.target.value)} />
                  </div>
                </Field>
                <Field label="Background image URL">
                  <input className="input mono" placeholder="https://… (or blank for none)" value={cfg("background")}
                         onChange={(e) => setCfg("background", e.target.value)} />
                </Field>
              </>
            )}

            {(editing.template === "starting_soon" || editing.template === "generic") && (
              <>
                <Field label="Countdown target (ISO)">
                  <input
                    type="datetime-local"
                    className="input mono"
                    value={localFromIso(cfg("countdownAt"))}
                    onChange={(e) => setCfg("countdownAt", isoFromLocal(e.target.value))}
                  />
                </Field>
                <Field label="Countdown label">
                  <input className="input" value={cfg("countdownLabel")} placeholder="Live in"
                         onChange={(e) => setCfg("countdownLabel", e.target.value)} />
                </Field>
              </>
            )}

            {editing.template === "ending" && (
              <>
                <Field label="Twitch handle"><input className="input" value={cfg("twitch")}  onChange={(e) => setCfg("twitch",  e.target.value)} /></Field>
                <Field label="YouTube handle"><input className="input" value={cfg("youtube")} onChange={(e) => setCfg("youtube", e.target.value)} /></Field>
                <Field label="X handle"><input className="input" value={cfg("twitter")} onChange={(e) => setCfg("twitter", e.target.value)} /></Field>
                <Field label="Discord invite"><input className="input" value={cfg("discord")} onChange={(e) => setCfg("discord", e.target.value)} /></Field>
              </>
            )}

            {editing.template === "raw_html" && (
              <>
                <Field label="HTML (full document body content)">
                  <textarea
                    className="input mono"
                    rows={10}
                    style={{ resize: "vertical" }}
                    value={cfg("html")}
                    onChange={(e) => setCfg("html", e.target.value)}
                    placeholder={`<div style="display:grid;place-content:center;height:100vh;color:#0ff;font-size:120px">HELLO</div>`}
                  />
                </Field>
                <Field label="CSS (optional)">
                  <textarea
                    className="input mono"
                    rows={6}
                    style={{ resize: "vertical" }}
                    value={cfg("css")}
                    onChange={(e) => setCfg("css", e.target.value)}
                    placeholder={`body { background: black; }`}
                  />
                </Field>
                <p className="hint">
                  Heads up: the raw HTML / CSS is inlined as-is. Anything <code>&lt;script&gt;</code> blocks
                  inside <code>html</code> is what you typed — you're trusted, but typos break the broadcast.
                </p>
              </>
            )}
          </div>

          <div className="actions" style={{ marginTop: "1rem" }}>
            <button className="btn-primary" disabled={!!busy} onClick={saveScene}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button className="btn-ghost" disabled={!!busy} onClick={() => copyUrl(`/scene/custom/${editing.slug}`)}>
              Copy URL
            </button>
            <button className="btn-ghost" disabled={!!busy} onClick={() => window.open(`/scene/custom/${editing.slug}`, "_blank")}>
              Open preview
            </button>
            <button className="btn-ghost" disabled={!!busy} onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
        </section>
      )}

      <style jsx>{`
        .scene-grid {
          list-style: none; padding: 0; margin: 8px 0 0;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 10px;
        }
        .scene-card {
          padding: 12px 14px;
          background: rgba(5,6,10,0.5);
          border: 1px solid var(--line-soft);
          border-radius: 4px;
          display: flex; flex-direction: column; gap: 6px;
          min-width: 0;
        }
        .scene-card.active {
          border-color: var(--neon-cyan);
          background: rgba(0,240,255,0.06);
          box-shadow: 0 0 16px rgba(0,240,255,0.18);
        }
        .scene-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
        .scene-card-name { font-weight: 700; font-size: 0.95rem; }
        .scene-card-path {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.72rem;
          color: var(--text-dim);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .scene-card-desc { color: var(--text-dim); font-size: 0.78rem; }
        .scene-card-actions {
          display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap;
        }

        .editor-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
          margin-top: 4px;
        }
        @media (max-width: 800px) {
          .editor-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </>
  );
}

function defaultConfigFor(t: Template): Record<string, unknown> {
  switch (t) {
    case "starting_soon": return { title: "Starting Soon",        subtitle: "Stream begins shortly",  accent: "#00f0ff" };
    case "brb":           return { title: "BRB",                  subtitle: "Be right back",          accent: "#8a2bff" };
    case "ending":        return { title: "Thanks for watching",  subtitle: "Stream over",            accent: "#ff2bd6", twitch: "" };
    case "generic":       return { title: "Scene",                accent: "#00f0ff" };
    case "raw_html":      return {
      html: `<div style="display:grid;place-content:center;height:100vh;color:#00f0ff;font-family:monospace;font-size:96px;text-shadow:0 0 20px #00f0ff">HELLO</div>`,
      css:  `body { background: #05060a; }`,
    };
  }
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

/**
 * <input type="datetime-local"> ↔ ISO string conversion.
 * `datetime-local` produces / consumes a local-time string like
 * `2026-05-17T20:30`. We store an ISO UTC string in config so the
 * Countdown component can compare against `Date.now()` directly.
 */
function localFromIso(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoFromLocal(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
