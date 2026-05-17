"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./util";

interface Track  {
  id: string; path: string;
  title: string | null; artist: string | null; album: string | null;
  durationS: number | null; coverPath: string | null;
  manual: boolean;
}
interface RadioPreset { id: string; name: string; url: string; createdAt: number }
interface Status {
  mode: "idle" | "library" | "radio";
  volume: number;
  loop: boolean;
  shuffle: boolean;
  queue: Track[];
  nowPlaying: {
    trackId?: string; title?: string; artist?: string; album?: string;
    coverPath?: string | null; url?: string; startedAt?: number;
  } | null;
  fifoReady: boolean;
  lastError: string | null;
}

/**
 * Music tab — upload, edit, delete, queue, and stream.
 * Backing audio routes through the FFmpeg → FIFO → streamer pipeline.
 */
export function MusicTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [presets, setPresets] = useState<RadioPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, lib, radio] = await Promise.all([
        apiJson("/api/music/status"),
        apiJson("/api/music/library"),
        apiJson("/api/music/radio"),
      ]);
      setStatus(s.status); setTracks(lib.tracks || []); setPresets(radio.presets || []);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { loadAll(); const id = setInterval(loadAll, 5_000); return () => clearInterval(id); }, [loadAll]);

  const wrap = async (label: string, fn: () => Promise<any>) => {
    setBusy(label); setError(null);
    try { const r = await fn(); if (r?.status) setStatus(r.status); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  // ---- Controls ------------------------------------------------
  const play = (id: string) =>
    wrap("play", () => apiJson("/api/music/play", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: id }),
    }));
  const next = () => wrap("next", () => apiJson("/api/music/next", { method: "POST" }));
  const stop = () => wrap("stop", () => apiJson("/api/music/stop", { method: "POST" }));
  const setVolume = (v: number) =>
    wrap("vol", () => apiJson("/api/music/volume", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: v }),
    }));
  const toggleLoop = () =>
    wrap("loop", () => apiJson("/api/music/mode", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loop: !status?.loop }),
    }));
  const toggleShuffle = () =>
    wrap("shuf", () => apiJson("/api/music/mode", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shuffle: !status?.shuffle }),
    }));

  // ---- Library ops --------------------------------------------
  const rescan = () =>
    wrap("rescan", async () => {
      const { tracks } = await apiJson("/api/music/library", { method: "POST" });
      setTracks(tracks);
    });

  const upload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy("upload"); setError(null);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("file", f);
      const r = await fetch("/api/music/upload", { method: "POST", body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setTracks(body.tracks || []);
    } catch (e: any) { setError(e.message); }
    finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeTrack = async (id: string) => {
    if (!confirm("Delete this track? The file will be removed too.")) return;
    setBusy("del"); setError(null);
    try {
      await apiJson(`/api/music/library/${id}`, { method: "DELETE" });
      setTracks((t) => t.filter((x) => x.id !== id));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  // ---- Radio --------------------------------------------------
  const [radioUrl, setRadioUrl] = useState("");
  const [radioName, setRadioName] = useState("");
  const playRadio = () =>
    wrap("radio", async () => {
      const r = await apiJson("/api/music/radio", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: radioUrl, name: radioName || undefined }),
      });
      setRadioUrl(""); setRadioName("");
      if (radioName) loadAll();
      return r;
    });
  const playPreset = (id: string) =>
    wrap("radio-preset", () => apiJson("/api/music/radio", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ presetId: id }),
    }));
  const removePreset = async (id: string) => {
    setBusy("preset-del");
    try { await apiJson(`/api/music/radio/${id}`, { method: "DELETE" }); setPresets((p) => p.filter((x) => x.id !== id)); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  // ---- Inline edit ----------------------------------------------
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; artist: string; album: string; coverUrl: string }>({
    title: "", artist: "", album: "", coverUrl: "",
  });
  const beginEdit = (t: Track) => {
    setEditingId(t.id);
    setEditDraft({
      title: t.title || "",
      artist: t.artist || "",
      album: t.album || "",
      coverUrl: "",
    });
  };
  const saveEdit = async () => {
    if (!editingId) return;
    setBusy("save");
    try {
      const { track } = await apiJson(`/api/music/library/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editDraft.title || null,
          artist: editDraft.artist || null,
          album: editDraft.album || null,
          coverPath: editDraft.coverUrl || undefined,
        }),
      });
      setTracks((ts) => ts.map((x) => (x.id === editingId ? track : x)));
      setEditingId(null);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const np = status?.nowPlaying;
  const cover = np?.trackId ? `/api/music/cover/${np.trackId}` : null;

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Player</h2>
          <span className={`badge ${status?.fifoReady ? "ok" : "warn"}`}>
            {status?.fifoReady ? "FIFO ready" : "FIFO not present"}
          </span>
        </div>

        <div className="now-playing">
          <div className="np-cover">
            {cover ? <img src={cover} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0"; }} /> : <span>♫</span>}
          </div>
          <div className="np-meta">
            <div className="np-mode">{status?.mode || "idle"} · {np ? "now playing" : "—"}</div>
            <div className="np-title">{np?.title || "Nothing playing"}</div>
            {np?.artist && <div className="np-artist">{np.artist}</div>}
            {np?.album  && <div className="np-album">{np.album}</div>}
          </div>
        </div>

        <div className="actions">
          <button className="btn-primary" disabled={!!busy} onClick={next}>Next</button>
          <button className="btn-danger"  disabled={!!busy} onClick={stop}>Stop</button>
          <button className="btn-ghost"   disabled={!!busy} onClick={toggleLoop}>Loop · {status?.loop ? "on" : "off"}</button>
          <button className="btn-ghost"   disabled={!!busy} onClick={toggleShuffle}>Shuffle · {status?.shuffle ? "on" : "off"}</button>
        </div>

        <div className="row gap" style={{ marginTop: ".75rem", alignItems: "center" }}>
          <span style={{ color: "var(--text-dim)" }}>Volume</span>
          <input type="range" min={0} max={1} step={0.02}
                 value={status?.volume ?? 0.6}
                 onChange={(e) => setVolume(Number(e.target.value))}
                 style={{ flex: 1 }} />
          <span className="mono">{Math.round((status?.volume ?? 0) * 100)}%</span>
        </div>

        {status?.lastError && <p className="hint" style={{ color: "var(--err)" }}>{status.lastError}</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Library <span className="muted">· {tracks.length}</span></h2>
          <div className="row" style={{ gap: ".4rem" }}>
            <button className="btn-ghost sm" disabled={!!busy} onClick={rescan}>
              {busy === "rescan" ? "Scanning…" : "Rescan"}
            </button>
            <button className="btn-primary sm" disabled={!!busy} onClick={() => fileInputRef.current?.click()}>
              {busy === "upload" ? "Uploading…" : "+ Upload"}
            </button>
            <input
              type="file"
              ref={fileInputRef}
              multiple
              accept=".mp3,.m4a,.ogg,.oga,.flac,.wav,.opus"
              style={{ display: "none" }}
              onChange={(e) => upload(e.target.files)}
            />
          </div>
        </div>

        <p className="hint">Tags + embedded cover art are read on upload / rescan. Manually-edited tracks aren't overwritten by rescans.</p>

        {tracks.length === 0 && <div className="muted">No tracks yet — upload some MP3s.</div>}
        <ul className="track-list">
          {tracks.map((t) => (
            <li key={t.id} className={`track-row ${np?.trackId === t.id ? "playing" : ""}`}>
              <div className="track-cover">
                {t.coverPath
                  ? <img src={`/api/music/cover/${t.id}`} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0"; }} />
                  : <span>♫</span>}
              </div>

              {editingId === t.id ? (
                <div className="track-edit">
                  <input className="input sm" placeholder="Title"  value={editDraft.title}
                         onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })} />
                  <input className="input sm" placeholder="Artist" value={editDraft.artist}
                         onChange={(e) => setEditDraft({ ...editDraft, artist: e.target.value })} />
                  <input className="input sm" placeholder="Album"  value={editDraft.album}
                         onChange={(e) => setEditDraft({ ...editDraft, album: e.target.value })} />
                </div>
              ) : (
                <div className="track-meta">
                  <div className="track-title">
                    {t.title || t.path}
                    {t.manual && <span className="tag" title="manually edited">edited</span>}
                  </div>
                  <div className="track-sub">
                    {[t.artist, t.album].filter(Boolean).join(" · ") || <span className="muted mono">{t.path}</span>}
                  </div>
                </div>
              )}

              <div className="track-actions">
                {editingId === t.id ? (
                  <>
                    <button className="btn-primary sm" disabled={!!busy} onClick={saveEdit}>Save</button>
                    <button className="btn-ghost   sm" disabled={!!busy} onClick={() => setEditingId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn-primary sm" disabled={!!busy} onClick={() => play(t.id)}>Play</button>
                    <button className="btn-ghost   sm" disabled={!!busy} onClick={() => beginEdit(t)}>Edit</button>
                    <button className="btn-ghost   sm" disabled={!!busy} onClick={() => removeTrack(t.id)}>×</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card-head"><h2>Radio</h2></div>

        <ul className="list">
          {presets.length === 0 && <li className="muted">No radio presets saved.</li>}
          {presets.map((p) => (
            <li key={p.id} className="list-row">
              <div className="grow">
                <div className="row-title">{p.name}</div>
                <div className="row-sub mono">{p.url}</div>
              </div>
              <button className="btn-primary sm" disabled={!!busy} onClick={() => playPreset(p.id)}>Play</button>
              <button className="btn-ghost sm"   disabled={!!busy} onClick={() => removePreset(p.id)}>×</button>
            </li>
          ))}
        </ul>

        <div className="row gap">
          <input className="input"      placeholder="Preset name (optional)" value={radioName} onChange={(e) => setRadioName(e.target.value)} />
          <input className="input mono grow" placeholder="https://… (Icecast / Shoutcast / direct .mp3 stream)" value={radioUrl} onChange={(e) => setRadioUrl(e.target.value)} />
          <button className="btn-primary" disabled={!!busy || !radioUrl} onClick={playRadio}>Play radio</button>
        </div>
      </section>

      <style jsx>{`
        .now-playing {
          display: grid; grid-template-columns: 84px 1fr;
          gap: 16px; padding: 8px 0 14px;
          border-bottom: 1px solid var(--line-soft);
          margin-bottom: 10px;
        }
        .np-cover {
          width: 84px; height: 84px;
          background: linear-gradient(135deg, rgba(0,240,255,0.18), rgba(138,43,255,0.18));
          border: 1px solid var(--line);
          border-radius: 4px;
          display: flex; align-items: center; justify-content: center;
          color: var(--neon-cyan); font-size: 32px;
          overflow: hidden;
        }
        .np-cover img { width: 100%; height: 100%; object-fit: cover; }
        .np-meta { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; }
        .np-mode { font-size: 10px; letter-spacing: .25em; text-transform: uppercase; color: var(--text-mute); }
        .np-title { font-size: 1.15rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .np-artist { color: var(--text-dim); }
        .np-album { color: var(--text-mute); font-size: .82rem; }

        .track-list {
          list-style: none; padding: 0; margin: 8px 0 0;
          display: flex; flex-direction: column; gap: 4px;
        }
        .track-row {
          display: grid;
          grid-template-columns: 48px 1fr auto;
          gap: 12px; align-items: center;
          padding: 6px 10px;
          background: rgba(5,6,10,0.4);
          border: 1px solid var(--line-soft);
          border-radius: 3px;
        }
        .track-row.playing {
          border-color: var(--neon-cyan);
          background: rgba(0,240,255,0.06);
        }
        .track-cover {
          width: 48px; height: 48px;
          background: linear-gradient(135deg, rgba(0,240,255,0.18), rgba(138,43,255,0.18));
          border-radius: 3px;
          display: flex; align-items: center; justify-content: center;
          color: var(--neon-cyan); font-size: 18px;
          overflow: hidden;
        }
        .track-cover img { width: 100%; height: 100%; object-fit: cover; }
        .track-meta { min-width: 0; }
        .track-title { font-weight: 600; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .track-sub { font-size: .78rem; color: var(--text-dim); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .track-actions { display: flex; gap: 4px; }
        .track-edit {
          display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;
        }
      `}</style>
    </>
  );
}
