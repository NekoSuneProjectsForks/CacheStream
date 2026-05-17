"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./util";

interface Vod {
  id: string; name: string; kind: "file" | "url";
  pathOrUrl: string; durationS: number | null;
  sizeBytes: number | null; loop: boolean; createdAt: number;
}

interface StreamerStatus {
  state: string;
  vod?: { id: string; name: string; kind: string; startedAt: number; loop: boolean } | null;
}

/**
 * VODs tab — upload pre-recorded video files, or add remote URLs.
 * Playing a VOD switches the broadcast away from the live scene
 * pipeline; stop it to return to the scene.
 */
export function VodsTab() {
  const [vods, setVods] = useState<Vod[]>([]);
  const [status, setStatus] = useState<StreamerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Add-URL form -------------------------------------------
  const [draft, setDraft] = useState<{ name: string; url: string; loop: boolean }>({ name: "", url: "", loop: false });

  // ---- Inline edit --------------------------------------------
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ name: string; loop: boolean }>({ name: "", loop: false });

  const load = useCallback(async () => {
    try {
      const [v, s] = await Promise.all([
        apiJson("/api/vods"),
        apiJson("/api/stream/status"),
      ]);
      setVods(v.vods || []);
      setStatus(s.status);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 5_000); return () => clearInterval(id); }, [load]);

  const wrap = async (label: string, fn: () => Promise<any>) => {
    setBusy(label); setError(null);
    try { await fn(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  // ---- Ops ----------------------------------------------------
  const upload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy("upload"); setError(null);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("file", f);
      const r = await fetch("/api/vods/upload", { method: "POST", body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      load();
    } catch (e: any) { setError(e.message); }
    finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addUrl = () =>
    wrap("add-url", async () => {
      if (!draft.url.trim() || !draft.name.trim()) {
        throw new Error("name and URL required");
      }
      await apiJson("/api/vods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draft.name, kind: "url", pathOrUrl: draft.url, loop: draft.loop }),
      });
      setDraft({ name: "", url: "", loop: false });
      load();
    });

  const playVod  = (id: string) => wrap("play",  () => apiJson(`/api/vods/${id}/play`, { method: "POST" }).then(load));
  const stopVod  = ()           => wrap("stop",  () => apiJson("/api/vods/stop",        { method: "POST" }).then(load));
  const beginEdit = (v: Vod) => { setEditingId(v.id); setEditDraft({ name: v.name, loop: v.loop }); };
  const saveEdit = () =>
    wrap("save", async () => {
      if (!editingId) return;
      await apiJson(`/api/vods/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editDraft),
      });
      setEditingId(null);
      load();
    });

  const removeVod = async (id: string) => {
    if (!confirm("Delete this VOD?  If it's a file, the file is removed too.")) return;
    setBusy("del"); setError(null);
    try { await apiJson(`/api/vods/${id}`, { method: "DELETE" }); load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const activeVodId = status?.vod?.id;

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Pre-recorded broadcast</h2>
          {status?.vod ? (
            <span className="badge ok">
              VOD: {status.vod.name}
            </span>
          ) : (
            <span className="badge mute">no VOD active</span>
          )}
        </div>
        <p className="hint">
          Playing a VOD takes over the broadcast: the live Chromium scene pipeline
          is torn down and FFmpeg streams the video directly to Twitch. Stop the VOD
          to return to the scene.
          <br />
          <span className="muted">
            Heads up: large file uploads (&gt; ~100 MB) over Cloudflare Tunnel may fail
            depending on your plan. For big VODs, SFTP them straight into
            <code>./media/vods</code> on the host and use “Add remote URL” with
            <code>file:///app/media/vods/yourfile.mp4</code> or add a row manually then rescan.
          </span>
        </p>

        {status?.vod && (
          <div className="actions" style={{ marginTop: ".5rem" }}>
            <button className="btn-danger" disabled={!!busy} onClick={stopVod}>
              {busy === "stop" ? "Stopping…" : "Stop VOD"}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Sources <span className="muted">· {vods.length}</span></h2>
          <div className="row" style={{ gap: ".4rem" }}>
            <button
              className="btn-ghost sm"
              disabled={!!busy}
              onClick={() => wrap("scan", async () => { await apiJson("/api/vods/scan", { method: "POST" }); load(); })}
            >
              {busy === "scan" ? "Scanning…" : "Scan dir"}
            </button>
            <button className="btn-primary sm" disabled={!!busy} onClick={() => fileInputRef.current?.click()}>
              {busy === "upload" ? "Uploading…" : "+ Upload video"}
            </button>
          </div>
          <input
            type="file"
            ref={fileInputRef}
            multiple
            accept=".mp4,.mov,.mkv,.webm,.m4v"
            style={{ display: "none" }}
            onChange={(e) => upload(e.target.files)}
          />
        </div>

        {vods.length === 0 && <div className="muted">No VODs yet. Upload a video or add a remote URL below.</div>}

        <ul className="vod-list">
          {vods.map((v) => (
            <li key={v.id} className={`vod-row ${activeVodId === v.id ? "active" : ""}`}>
              <div className="vod-icon">{v.kind === "file" ? "▶" : "🌐"}</div>
              {editingId === v.id ? (
                <div className="vod-edit">
                  <input className="input sm" value={editDraft.name}
                         onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
                  <label className="row" style={{ gap: 4 }}>
                    <input type="checkbox" checked={editDraft.loop}
                           onChange={(e) => setEditDraft({ ...editDraft, loop: e.target.checked })} />
                    <span>loop</span>
                  </label>
                </div>
              ) : (
                <div className="vod-meta">
                  <div className="vod-name">
                    {v.name}
                    {v.loop && <span className="tag">loop</span>}
                    {activeVodId === v.id && <span className="tag ok">LIVE</span>}
                  </div>
                  <div className="vod-sub mono">{v.pathOrUrl}</div>
                  <div className="vod-stats">
                    {v.sizeBytes != null && <span>{fmtSize(v.sizeBytes)}</span>}
                    {v.durationS != null && <span>{fmtDur(v.durationS)}</span>}
                    <span className="muted">{v.kind}</span>
                  </div>
                </div>
              )}
              <div className="vod-actions">
                {editingId === v.id ? (
                  <>
                    <button className="btn-primary sm" disabled={!!busy} onClick={saveEdit}>Save</button>
                    <button className="btn-ghost sm"   disabled={!!busy} onClick={() => setEditingId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn-primary sm" disabled={!!busy} onClick={() => playVod(v.id)}>Play</button>
                    <button className="btn-ghost sm"   disabled={!!busy} onClick={() => beginEdit(v)}>Edit</button>
                    <button className="btn-ghost sm"   disabled={!!busy} onClick={() => removeVod(v.id)}>×</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="card-head" style={{ marginTop: "1rem" }}>
          <h3 className="subhead" style={{ margin: 0 }}>Add remote URL</h3>
        </div>
        <div className="row gap">
          <input className="input" placeholder="Name" value={draft.name}
                 onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="input mono grow" placeholder="https://…/movie.mp4 or rtmp://…"
                 value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={draft.loop}
                   onChange={(e) => setDraft({ ...draft, loop: e.target.checked })} />
            <span>loop</span>
          </label>
          <button className="btn-primary" disabled={!!busy || !draft.url || !draft.name} onClick={addUrl}>Add</button>
        </div>
      </section>

      <style jsx>{`
        .vod-list { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; }
        .vod-row {
          display: grid;
          grid-template-columns: 36px 1fr auto;
          gap: 12px; align-items: center;
          padding: 8px 10px;
          background: rgba(5,6,10,0.4);
          border: 1px solid var(--line-soft);
          border-radius: 3px;
        }
        .vod-row.active {
          border-color: var(--neon-cyan);
          background: rgba(0,240,255,0.06);
          box-shadow: 0 0 18px rgba(0,240,255,0.18);
        }
        .vod-icon {
          width: 36px; height: 36px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, rgba(0,240,255,0.18), rgba(138,43,255,0.18));
          border-radius: 4px;
          color: var(--neon-cyan); font-size: 16px;
        }
        .vod-meta { min-width: 0; }
        .vod-name { display: flex; align-items: center; gap: 6px; font-weight: 600; }
        .vod-sub { font-size: .78rem; color: var(--text-dim); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .vod-stats { display: flex; gap: 8px; font-size: .7rem; color: var(--text-mute); margin-top: 2px; letter-spacing: .12em; text-transform: uppercase; }
        .vod-actions { display: flex; gap: 4px; }
        .vod-edit { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; }
      `}</style>
    </>
  );
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDur(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}
