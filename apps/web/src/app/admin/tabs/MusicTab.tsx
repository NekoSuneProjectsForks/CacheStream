"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./util";
import {
  VISUALIZER_DEFAULTS,
  VISUALIZER_LAYOUTS,
  VISUALIZER_LAYOUT_LABELS,
  type VisualizerConfig,
} from "@/lib/visualizer-config";

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
  const [vis, setVis] = useState<VisualizerConfig>(VISUALIZER_DEFAULTS);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, lib, radio, v] = await Promise.all([
        apiJson("/api/music/status"),
        apiJson("/api/music/library"),
        apiJson("/api/music/radio"),
        apiJson("/api/music/visualizer"),
      ]);
      setStatus(s.status); setTracks(lib.tracks || []); setPresets(radio.presets || []);
      if (v.visualizer) setVis(v.visualizer);
    } catch (e: any) { setError(e.message); }
  }, []);

  // Persist a visualizer change. Optimistically updates local state
  // so the controls feel instant; the scene picks it up within its
  // ~5s config poll.
  const updateVis = async (patch: Partial<VisualizerConfig>) => {
    const next = { ...vis, ...patch };
    setVis(next);
    try {
      const r = await apiJson("/api/music/visualizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (r.visualizer) setVis(r.visualizer);
    } catch (e: any) { setError(e.message); }
  };
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
  // Start playback when nothing is queued: grab the first track in
  // the library (or a random one if shuffle is on) and play it.
  const playLibrary = () => {
    if (tracks.length === 0) return;
    const pick = status?.shuffle ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[0];
    return play(pick.id);
  };

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
  const isPlaying = !!np && (status?.mode === "library" || status?.mode === "radio");
  const subtitle =
    status?.mode === "radio"   ? "Radio stream" :
    status?.mode === "library" ? (np?.artist || "Library") :
    "Idle";

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
          <div className={`np-cover ${isPlaying ? "spin" : ""}`}>
            {cover ? <img src={cover} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0"; }} /> : <span>♫</span>}
          </div>
          <div className="np-meta">
            <div className="np-mode">
              <span className={`dot ${isPlaying ? "live" : ""}`} />
              {status?.mode === "radio" ? "On air · Radio" : status?.mode === "library" ? "On air · Library" : "Idle"}
            </div>
            <div className="np-title">{np?.title || (isPlaying ? "—" : "Nothing playing")}</div>
            <div className="np-artist">{subtitle}</div>
            {np?.album && <div className="np-album">{np.album}</div>}
          </div>
        </div>

        <div className="actions">
          {isPlaying ? (
            <button className="btn-primary" disabled={!!busy} onClick={next}>Next ▸</button>
          ) : (
            <button className="btn-primary" disabled={!!busy || tracks.length === 0} onClick={playLibrary}>▶ Play library</button>
          )}
          <button className="btn-danger" disabled={!!busy || !isPlaying} onClick={stop}>■ Stop</button>
          <button className={`btn-ghost toggle ${status?.loop ? "on" : ""}`}    disabled={!!busy} onClick={toggleLoop}>Loop</button>
          <button className={`btn-ghost toggle ${status?.shuffle ? "on" : ""}`} disabled={!!busy} onClick={toggleShuffle}>Shuffle</button>
        </div>

        <div className="vol-row">
          <span className="vol-label">Volume</span>
          <input type="range" min={0} max={1} step={0.02}
                 value={status?.volume ?? 0.6}
                 onChange={(e) => setVolume(Number(e.target.value))} />
          <span className="vol-val mono">{Math.round((status?.volume ?? 0) * 100)}%</span>
        </div>

        {status?.queue && status.queue.length > 0 && (
          <div className="up-next">
            <div className="up-next-head">Up next · {status.queue.length}</div>
            <ol className="up-next-list">
              {status.queue.slice(0, 3).map((t, i) => (
                <li key={`${t.id}-${i}`}>
                  <span className="idx mono">{String(i + 1).padStart(2, "0")}</span>
                  <span className="t">{t.title || t.path}</span>
                  {t.artist && <span className="a">{t.artist}</span>}
                </li>
              ))}
              {status.queue.length > 3 && <li className="muted">+ {status.queue.length - 3} more</li>}
            </ol>
          </div>
        )}

        {status?.lastError && <p className="hint" style={{ color: "var(--err)" }}>{status.lastError}</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Visualizer</h2>
          <span className="muted">/scene/music spectrum</span>
        </div>
        <p className="hint">
          Pick the spectrum style for the Music scene. Changes apply to a running
          scene within a few seconds — no restart needed. Lower the FPS cap if the
          spectrum costs you frames in games.
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
                    {[t.artist, t.album, fmtDuration(t.durationS)].filter(Boolean).join(" · ") || <span className="muted mono">{t.path}</span>}
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
          transition: box-shadow .25s ease;
        }
        .np-cover.spin {
          box-shadow: 0 0 28px rgba(0,240,255,0.30);
        }
        .np-cover.spin img { animation: cover-spin 24s linear infinite; }
        @keyframes cover-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
        .np-cover img { width: 100%; height: 100%; object-fit: cover; }
        .np-meta { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; }
        .np-mode {
          display: inline-flex; align-items: center; gap: 8px;
          font-size: 10px; letter-spacing: .25em; text-transform: uppercase;
          color: var(--text-mute);
        }
        .np-mode .dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: rgba(230,247,255,0.2);
        }
        .np-mode .dot.live {
          background: var(--ok);
          box-shadow: 0 0 10px var(--ok);
          animation: live-pulse 1.6s ease-in-out infinite;
        }
        @keyframes live-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        .np-title { font-size: 1.15rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .np-artist { color: var(--text-dim); }
        .np-album { color: var(--text-mute); font-size: .82rem; }

        .btn-ghost.toggle.on {
          color: var(--neon-cyan);
          border-color: var(--neon-cyan);
          background: rgba(0,240,255,0.08);
          box-shadow: 0 0 14px rgba(0,240,255,0.25);
        }

        .vol-row {
          display: grid; grid-template-columns: 64px 1fr 48px;
          gap: 12px; align-items: center;
          margin-top: .9rem;
        }
        .vol-label {
          font-size: 10px; letter-spacing: .25em; text-transform: uppercase;
          color: var(--text-mute);
        }
        .vol-row input[type="range"] {
          width: 100%;
          accent-color: var(--neon-cyan);
        }
        .vol-val { text-align: right; color: var(--text-dim); font-size: .82rem; }

        .up-next {
          margin-top: .9rem;
          padding-top: .75rem;
          border-top: 1px solid var(--line-soft);
        }
        .up-next-head {
          font-size: 10px; letter-spacing: .25em; text-transform: uppercase;
          color: var(--text-mute);
          margin-bottom: .4rem;
        }
        .up-next-list {
          list-style: none; padding: 0; margin: 0;
          display: flex; flex-direction: column; gap: 2px;
        }
        .up-next-list li {
          display: grid; grid-template-columns: 28px 1fr auto;
          gap: 10px; align-items: baseline;
          font-size: .85rem;
          padding: 3px 0;
        }
        .up-next-list .idx { color: var(--text-mute); font-size: .72rem; }
        .up-next-list .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .up-next-list .a { color: var(--text-dim); font-size: .76rem; }
        .up-next-list li.muted { grid-template-columns: 1fr; color: var(--text-mute); font-size: .76rem; padding-left: 38px; }

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
      `}</style>
    </>
  );
}

function fmtDuration(s: number | null | undefined): string | null {
  if (!s || s <= 0) return null;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}
