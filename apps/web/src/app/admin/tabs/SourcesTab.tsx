"use client";

/**
 * Sources tab — external content sources you can use as scenes.
 *
 * Three subsystems live here in v1.11.0:
 *
 *   1. Browser-source embeds — drop a URL widget (Streamlabs
 *      alerts, NightBot timers, etc.) into a sandboxed iframe
 *      scene. Each embed gets a stable slug-based scene URL
 *      that you can add to the Scenes presets list.
 *
 *   2. Twitch VOD archive — list recent past broadcasts via
 *      Helix `GET /videos`. Click "Use as scene" to spawn a
 *      preset that loads the Twitch embed player as a scene.
 *
 *   3. Multi-key RTMP ingest — multiple stream keys (e.g. "obs"
 *      / "phone" / "screen"), each its own switchable scene.
 *      The default key "cache" remains the single-key flow from
 *      v1.9.0; this section is purely additive.
 *
 * Each section saves immediately on change. Adding/removing a
 * source doesn't take effect on the broadcast until the operator
 * switches to / reloads the scene.
 */

import { useEffect, useState } from "react";
import { apiJson } from "./util";

interface Embed {
  slug: string;
  name: string;
  url: string;
  width: number | null;
  height: number | null;
  transparent: boolean;
  createdAt: number;
}

interface TwitchVod {
  id: string;
  title: string;
  durationS: number;
  publishedAt: string;
  thumbnailUrl: string | null;
  url: string;
}

interface IngestKey {
  key: string;
  label: string;
  live: boolean;
  startedAt: number | null;
  bitrateKbps?: number;
  clientAddr?: string | null;
}

interface IngestStatus {
  key: string;
  enabled: boolean;
  live: boolean;
  pushUrl: string;
  streamKey: string;
  bitrateKbps: number;
  clientAddr: string | null;
  startedAt: number | null;
  publisherInfo: { width: number; height: number; codec: string } | null;
  lastError: string | null;
}

export function SourcesTab() {
  return (
    <>
      <EmbedsSection />
      <VodsSection />
      <MultiKeySection />
    </>
  );
}

/* ---- 1. Browser-source embeds ---------------------------------- */

function EmbedsSection() {
  const [list, setList] = useState<Embed[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: "", url: "",
    width: "", height: "",
    transparent: false,
  });
  const [busy, setBusy] = useState(false);
  const sceneOrigin = typeof window === "undefined"
    ? "http://web:7788"
    : window.location.origin;

  const refresh = async () => {
    try { setList(await apiJson("/api/embeds")); }
    catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    if (!draft.name.trim() || !draft.url.trim()) return;
    setBusy(true); setError(null);
    try {
      await apiJson("/api/embeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          url:  draft.url,
          width:  draft.width  ? parseInt(draft.width,  10) : undefined,
          height: draft.height ? parseInt(draft.height, 10) : undefined,
          transparent: draft.transparent,
        }),
      });
      setDraft({ name: "", url: "", width: "", height: "", transparent: false });
      await refresh();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (slug: string) => {
    if (!confirm("Delete this embed?")) return;
    setBusy(true);
    try {
      await fetch(`/api/embeds/${encodeURIComponent(slug)}`, { method: "DELETE" });
      await refresh();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const addAsScene = async (e: Embed) => {
    try {
      await apiJson("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Embed: ${e.name}`,
          // Use the internal docker DNS hostname (web:7788) so
          // the streamer can reach it from inside its own container.
          // The browser preview link below uses sceneOrigin for the
          // operator's convenience.
          url: `http://web:7788/scene/embed/${e.slug}`,
        }),
      });
      alert(`Added "${e.name}" as a scene preset. See the Scenes tab.`);
    } catch (err: any) { setError(err.message); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Browser-source embeds</h2>
        <span className="tag">v1.11.0</span>
      </div>
      <p className="hint">
        Drop a URL widget (Streamlabs alerts, NightBot timers, custom Carbon
        widgets) into a full-bleed scene. Each embed gets a stable URL you can
        promote to a scene preset; the headless Chromium loads it in a
        sandboxed iframe so it can't read your panel cookies.
      </p>

      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Name" style={{ flex: "1 1 180px" }}>
          <input className="input"
                 placeholder="e.g. Streamlabs alerts"
                 value={draft.name}
                 onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="URL" style={{ flex: "2 1 360px" }}>
          <input className="input mono"
                 placeholder="https://streamlabs.com/alert-box/v3/…"
                 value={draft.url}
                 onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
        </Field>
        <Field label="Width (opt)" style={{ flex: "0 1 100px" }}>
          <input className="input" type="number" inputMode="numeric"
                 placeholder="auto" value={draft.width}
                 onChange={(e) => setDraft({ ...draft, width: e.target.value })} />
        </Field>
        <Field label="Height (opt)" style={{ flex: "0 1 100px" }}>
          <input className="input" type="number" inputMode="numeric"
                 placeholder="auto" value={draft.height}
                 onChange={(e) => setDraft({ ...draft, height: e.target.value })} />
        </Field>
        <label className="row" style={{ gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={draft.transparent}
                 onChange={(e) => setDraft({ ...draft, transparent: e.target.checked })} />
          transparent
        </label>
        <button className="btn-primary" disabled={busy} onClick={add}>
          {busy ? "…" : "Add"}
        </button>
      </div>

      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}

      {list.length > 0 && (
        <ul className="rows" style={{ marginTop: 14 }}>
          {list.map((e) => (
            <li key={e.slug} className="row gap" style={{ alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{e.name}</div>
                <div className="muted mono" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.url}
                </div>
              </div>
              <a className="btn-ghost sm" href={`${sceneOrigin}/scene/embed/${e.slug}`} target="_blank" rel="noreferrer">
                Preview
              </a>
              <button className="btn-ghost sm" onClick={() => addAsScene(e)}>Use as scene</button>
              <button className="btn-ghost sm" onClick={() => remove(e.slug)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---- 2. Twitch VOD archive -------------------------------------- */

function VodsSection() {
  const [vods, setVods] = useState<TwitchVod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try { setVods(await apiJson("/api/twitch/vods")); }
    catch (e: any) { setError(e.message); setVods([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const addAsScene = async (v: TwitchVod) => {
    try {
      await apiJson("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `VOD: ${v.title.slice(0, 32)}`,
          url:  `http://web:7788/scene/vod/twitch/${v.id}`,
        }),
      });
      alert(`Added rerun scene for "${v.title}". See the Scenes tab.`);
    } catch (err: any) { setError(err.message); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Twitch VOD archive</h2>
        <span className="tag">rerun a past broadcast as a scene</span>
      </div>
      <p className="hint">
        Pulls your most recent Twitch broadcasts via Helix.
        Pick one and "Use as scene" to spawn a preset that plays it back via
        the Twitch embed player. Useful for sleep streams, intermissions, or
        24/7 reruns between live blocks.
      </p>

      <div className="row gap" style={{ marginBottom: 10 }}>
        <button className="btn-ghost" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {vods && vods.length === 0 && !error && (
        <div className="muted">No archived broadcasts found.</div>
      )}

      {vods && vods.length > 0 && (
        <ul className="rows">
          {vods.map((v) => (
            <li key={v.id} className="row gap" style={{ alignItems: "center" }}>
              {v.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.thumbnailUrl.replace("%{width}", "180").replace("%{height}", "100")}
                     alt="" style={{ width: 90, height: 50, objectFit: "cover", borderRadius: 3 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.title}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {fmtDuration(v.durationS)} · {new Date(v.publishedAt).toLocaleString()}
                </div>
              </div>
              <a className="btn-ghost sm" href={v.url} target="_blank" rel="noreferrer">Open on Twitch</a>
              <button className="btn-ghost sm" onClick={() => addAsScene(v)}>Use as scene</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---- 3. Multi-key RTMP ingest ----------------------------------- */

function MultiKeySection() {
  const [keys, setKeys] = useState<IngestKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [pushUrl, setPushUrl] = useState<string>("");

  const refresh = async () => {
    try {
      const ks = await apiJson("/api/ingest/keys") as IngestKey[];
      // v1.13.6: pull richer per-key liveness + bitrate from the
      // status endpoint (which now reads nginx-rtmp's /stat XML).
      // The keys-list endpoint only knows configured keys, not
      // their real-time inbound state.
      const enriched = await Promise.all(ks.map(async (k) => {
        try {
          const s = await apiJson(`/api/ingest/status?k=${encodeURIComponent(k.key)}`) as IngestStatus;
          return {
            ...k,
            live: s.live,
            bitrateKbps: s.bitrateKbps,
            clientAddr: s.clientAddr,
          };
        } catch { return k; }
      }));
      setKeys(enriched);

      // Cache the push URL once (it's the same for every key).
      if (ks.length > 0) {
        try {
          const s = await apiJson(`/api/ingest/status?k=${encodeURIComponent(ks[0].key)}`) as IngestStatus;
          if (s.pushUrl) setPushUrl(s.pushUrl);
        } catch {}
      }
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id); }, []);

  const add = async () => {
    if (!draftLabel.trim()) return;
    setError(null);
    try {
      await apiJson("/api/ingest/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: draftLabel }),
      });
      setDraftLabel("");
      await refresh();
    } catch (e: any) { setError(e.message); }
  };

  const remove = async (k: string) => {
    if (k === "cache") {
      alert("The 'cache' key is the default fallback; it can't be deleted.");
      return;
    }
    if (!confirm(`Delete key "${k}"?`)) return;
    await fetch(`/api/ingest/keys/${encodeURIComponent(k)}`, { method: "DELETE" });
    await refresh();
  };

  const addAsScene = async (k: IngestKey) => {
    try {
      await apiJson("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `RTMP: ${k.label || k.key}`,
          url:  `http://web:7788/scene/ingest?k=${encodeURIComponent(k.key)}`,
        }),
      });
      alert(`Added "${k.label}" as a scene preset.`);
    } catch (err: any) { setError(err.message); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {}
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Multi-key RTMP ingest</h2>
        <span className="tag">phone · screen · obs</span>
      </div>
      <p className="hint">
        Push from multiple encoders simultaneously, switch between them on the
        fly. Each key becomes its own scene preset. In OBS / your encoder,
        paste the <strong>Server</strong> URL below and one of the
        <strong> Stream Keys</strong> — the panel will show the live
        bitrate + publisher IP within a few seconds of you hitting Start
        Streaming.
      </p>

      {/* v1.13.6: prominently surface the push URL so operators don't
          have to mentally fill in <host>. The endpoint derives this
          from PUBLIC_URL or RTMP_PUBLIC_HOST. */}
      {pushUrl && (
        <div className="row gap" style={{ marginBottom: 10, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase",
                          color: "var(--text-mute)", marginBottom: 4 }}>
              Server URL (paste into OBS → Settings → Stream → Server)
            </div>
            <code style={{ display: "block", padding: "8px 12px",
                            background: "rgba(0,0,0,.35)", borderRadius: 3,
                            fontSize: 13, overflowX: "auto", whiteSpace: "nowrap" }}>
              {pushUrl}
            </code>
          </div>
          <button className="btn-ghost sm" onClick={() => copy(pushUrl)}>Copy</button>
        </div>
      )}

      <div className="row gap" style={{ marginBottom: 10 }}>
        <input className="input"
               placeholder="Label — e.g. Phone, Capture card"
               value={draftLabel}
               onChange={(e) => setDraftLabel(e.target.value)} />
        <button className="btn-primary" onClick={add}>Add key</button>
      </div>

      {error && <div className="error">{error}</div>}

      <ul className="rows">
        {keys.map((k) => (
          <li key={k.key} className="row gap" style={{ alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{k.label || k.key}</div>
              <div className="muted mono" style={{ fontSize: 11 }}>key: {k.key}</div>
              {k.live && (
                <div className="muted" style={{ fontSize: 11, color: "#4ade80", marginTop: 2 }}>
                  {k.bitrateKbps ? `${k.bitrateKbps} kbps` : "publishing"}
                  {k.clientAddr ? ` · from ${k.clientAddr}` : ""}
                </div>
              )}
            </div>
            <button className="btn-ghost sm" onClick={() => copy(k.key)} title="Copy stream key">📋 key</button>
            <span className={`badge ${k.live ? "badge-ok" : ""}`}>
              {k.live ? "LIVE" : "idle"}
            </span>
            <button className="btn-ghost sm" onClick={() => addAsScene(k)}>Use as scene</button>
            <button className="btn-ghost sm" onClick={() => remove(k.key)}>×</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---- Helpers ---------------------------------------------------- */

function Field({ label, style, children }: { label: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div style={style}>
      <div style={{
        fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase",
        color: "var(--text-mute)", marginBottom: 4,
      }}>{label}</div>
      {children}
    </div>
  );
}

function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
