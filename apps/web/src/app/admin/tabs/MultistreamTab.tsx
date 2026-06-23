"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./util";

/**
 * Multistream tab — send the single encode to multiple RTMP targets at
 * once (restream.io-style). Targets are pushed to the streamer, which
 * fans out via FFmpeg's `tee` muxer. See docs/design/multistream.md.
 */

interface Target {
  id: string;
  label: string;
  platform: string;
  ingestUrl: string;
  streamKey: string;   // masked (••••xxxx) when loaded; real when freshly typed
  enabled: boolean;
  hasKey?: boolean;
}

const PRESETS: Record<string, { label: string; url: string }> = {
  twitch:  { label: "Twitch",  url: "rtmp://live.twitch.tv/app" },
  youtube: { label: "YouTube", url: "rtmp://a.rtmp.youtube.com/live2" },
  kick:    { label: "Kick",    url: "rtmps://" },
  custom:  { label: "Custom",  url: "" },
};

export function MultistreamTab() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [bitrate, setBitrate] = useState(6000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, status] = await Promise.all([
        apiJson("/api/stream/targets"),
        apiJson("/api/stream/status").catch(() => null),
      ]);
      setTargets(t.targets || []);
      const b = status?.status?.video?.bitrateKbps;
      if (b) setBitrate(b);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addTarget = (platform: string) => {
    const p = PRESETS[platform] || PRESETS.custom;
    setTargets((ts) => [...ts, {
      id: crypto.randomUUID(), label: p.label, platform,
      ingestUrl: p.url, streamKey: "", enabled: true,
    }]);
    setSaved(false);
  };
  const update = (id: string, patch: Partial<Target>) => {
    setTargets((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setSaved(false);
  };
  const remove = (id: string) => { setTargets((ts) => ts.filter((t) => t.id !== id)); setSaved(false); };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await apiJson("/api/stream/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets }),
      });
      setTargets(r.targets || []);
      setSaved(true);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const enabled = targets.filter((t) => t.enabled);
  const egressMbps = ((enabled.length * bitrate) / 1000).toFixed(1);

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Multistream</h2>
          <span className="muted">{enabled.length} target{enabled.length === 1 ? "" : "s"} · ~{egressMbps} Mbps up</span>
        </div>
        <p className="hint">
          Send your stream to several platforms at once. The encode is shared,
          so CPU/GPU cost is unchanged — but your <b>upload</b> needs ~{egressMbps} Mbps
          for the enabled targets (one dead target won’t drop the others).
          Changes apply on save; if you’re live it hot-restarts the pipeline.
        </p>

        <div className="mt-list">
          {targets.length === 0 && <div className="muted">No targets — add one below. With none, it streams to your single Twitch ingest as before.</div>}
          {targets.map((t) => (
            <div key={t.id} className={`mt-row ${t.enabled ? "on" : ""}`}>
              <input type="checkbox" checked={t.enabled} onChange={(e) => update(t.id, { enabled: e.target.checked })} />
              <input className="input" style={{ width: 120 }} placeholder="Label"
                     value={t.label} onChange={(e) => update(t.id, { label: e.target.value })} />
              <input className="input mono grow" placeholder="rtmp(s)://… ingest URL"
                     value={t.ingestUrl} onChange={(e) => update(t.id, { ingestUrl: e.target.value })} />
              <input className="input mono" style={{ width: 180 }} type="password"
                     placeholder={t.hasKey ? "(keep saved key)" : "stream key"}
                     value={t.streamKey} onChange={(e) => update(t.id, { streamKey: e.target.value })} />
              <button className="btn-ghost sm" onClick={() => remove(t.id)}>×</button>
            </div>
          ))}
        </div>

        <div className="row gap" style={{ flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
          <span className="muted" style={{ fontSize: ".72rem" }}>ADD:</span>
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} className="btn-ghost sm" onClick={() => addTarget(k)}>＋ {p.label}</button>
          ))}
          <div style={{ flex: 1 }} />
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : saved ? "Saved ✓" : "Save targets"}
          </button>
        </div>
      </section>

      <style jsx>{`
        .mt-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
        .mt-row {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px;
          background: rgba(0,0,0,.18);
          border: 1px solid var(--line); border-radius: 6px;
        }
        .mt-row.on { border-color: rgba(0,240,255,.3); }
        .mt-row input[type="checkbox"] { accent-color: var(--neon-cyan); }
      `}</style>
    </>
  );
}
