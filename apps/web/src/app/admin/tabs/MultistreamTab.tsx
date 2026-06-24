"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./util";

/**
 * Multistream tab — send the stream to several destinations at once
 * (restream.io-style). Each enabled target runs as its own relay, so the
 * toggle switches turn outputs on/off LIVE without dropping the others.
 * Twitch + linked platforms are auto-added; only enabled targets count
 * toward egress and actually stream.
 */

interface Target {
  id: string;
  label: string;
  platform: string;
  protocol: string;
  ingestUrl: string;
  streamKey: string;   // masked when loaded
  format?: string;
  enabled: boolean;
  hasKey?: boolean;
  state?: string;      // connected | connecting | failed | off | idle
}

const PRESETS: Record<string, { label: string; protocol: string; url: string }> = {
  twitch:  { label: "Twitch",  protocol: "rtmp",  url: "rtmp://live.twitch.tv/app" },
  youtube: { label: "YouTube", protocol: "rtmp",  url: "rtmp://a.rtmp.youtube.com/live2" },
  kick:    { label: "Kick",    protocol: "rtmps", url: "rtmps://" },
  custom:  { label: "Custom",  protocol: "rtmp",  url: "" },
};

const DOT: Record<string, { color: string; title: string }> = {
  connected:  { color: "#4ade80", title: "connected" },
  connecting: { color: "#fb923c", title: "connecting…" },
  failed:     { color: "#ef4444", title: "failed / disconnected" },
  throttled:  { color: "#a855f7", title: "held back — low upload bandwidth" },
  idle:       { color: "#64748b", title: "stream not running" },
  off:        { color: "#3a4252", title: "disabled" },
};

interface Bandwidth {
  autoProtect: boolean;
  upMbps: number | null;
  baselineMbps: number | null;
  usableMbps: number | null;
  perStreamMbps: number | null;
  maxStreams: number | null;
  wanted: number;
  warning: string | null;
  probing: boolean;
  lastProbeAt: number | null;
  intervalMs: number;
}

const mbps = (v: number | null | undefined) =>
  v == null ? "—" : `${v.toFixed(1)} Mbps`;

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function MultistreamTab() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [protocols, setProtocols] = useState<string[]>(["rtmp", "rtmps", "srt", "rtsp", "mpegts", "custom"]);
  const [bitrate, setBitrate] = useState(6000);
  const [band, setBand] = useState<Bandwidth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);   // pause status merge while typing

  const load = useCallback(async () => {
    try {
      const [t, status, bw] = await Promise.all([
        apiJson("/api/stream/targets"),
        apiJson("/api/stream/status").catch(() => null),
        apiJson("/api/stream/bandwidth").catch(() => null),
      ]);
      setTargets(t.targets || []);
      if (t.protocols) setProtocols(t.protocols);
      const b = status?.status?.video?.bitrateKbps;
      if (b) setBitrate(b);
      if (bw?.bandwidth) setBand(bw.bandwidth);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Poll status for the dots + bandwidth — merge only `state` so it never
  // clobbers edits.
  useEffect(() => {
    const id = setInterval(async () => {
      if (editing.current) return;
      try {
        const [t, bw] = await Promise.all([
          apiJson("/api/stream/targets"),
          apiJson("/api/stream/bandwidth").catch(() => null),
        ]);
        const stateById: Record<string, string> = {};
        for (const x of t.targets || []) stateById[x.id] = x.state;
        setTargets((cur) => cur.map((c) => ({ ...c, state: stateById[c.id] ?? c.state })));
        if (bw?.bandwidth) setBand(bw.bandwidth);
      } catch {}
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const setBandwidth = async (opts: { autoProtect?: boolean; retest?: boolean }) => {
    // optimistic for the toggle so it feels instant
    if (typeof opts.autoProtect === "boolean") {
      setBand((b) => (b ? { ...b, autoProtect: opts.autoProtect! } : b));
    }
    try {
      const r = await apiJson("/api/stream/bandwidth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (r?.bandwidth) setBand(r.bandwidth);
    } catch (e: any) { setError(e.message); }
  };

  const persist = async (next: Target[]) => {
    setBusy(true); setError(null);
    try {
      const r = await apiJson("/api/stream/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: next }),
      });
      setTargets(r.targets || []);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  // Toggling applies LIVE — persist immediately.
  const toggle = (id: string) => {
    const next = targets.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t));
    setTargets(next);
    persist(next);
  };
  const update = (id: string, patch: Partial<Target>) =>
    setTargets((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const remove = (id: string) => { const next = targets.filter((t) => t.id !== id); setTargets(next); persist(next); };
  const addTarget = (k: string) => {
    const p = PRESETS[k] || PRESETS.custom;
    setTargets((ts) => [...ts, {
      id: crypto.randomUUID(), label: p.label, platform: k,
      protocol: p.protocol, ingestUrl: p.url, streamKey: "", enabled: false,
    }]);
  };

  const enabled = targets.filter((t) => t.enabled && t.ingestUrl);
  const egressMbps = ((enabled.length * bitrate) / 1000).toFixed(1);

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Multistream</h2>
          <span className="muted">{enabled.length} live · ~{egressMbps} Mbps up</span>
        </div>
        <p className="hint">
          Stream to several platforms at once. Toggle a destination on/off <b>live</b> —
          the others keep going. Twitch + linked platforms (Connections) are added
          automatically; fill in each ingest URL + key. Only enabled targets use upload
          (~{egressMbps} Mbps) and actually stream.
        </p>

        <div className="mt-list">
          {targets.length === 0 && <div className="muted">No targets yet.</div>}
          {targets.map((t) => {
            const dot = DOT[t.state || "off"] || DOT.off;
            return (
              <div key={t.id} className={`mt-row ${t.enabled ? "on" : ""}`}>
                <button className={`mt-switch ${t.enabled ? "on" : ""}`} title="Toggle live"
                        onClick={() => toggle(t.id)} disabled={busy} />
                <span className="mt-dot" style={{ background: dot.color, boxShadow: `0 0 7px ${dot.color}` }}
                      title={dot.title} />
                <input className="input" style={{ width: 110 }} placeholder="Label" value={t.label}
                       onFocus={() => editing.current = true} onBlur={() => editing.current = false}
                       onChange={(e) => update(t.id, { label: e.target.value })} />
                <select className="input" style={{ width: 92 }} value={t.protocol}
                        onChange={(e) => update(t.id, { protocol: e.target.value })}>
                  {protocols.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <input className="input mono grow" placeholder="ingest URL (rtmp/srt/rtsp…)" value={t.ingestUrl}
                       onFocus={() => editing.current = true} onBlur={() => editing.current = false}
                       onChange={(e) => update(t.id, { ingestUrl: e.target.value })} />
                <input className="input mono" style={{ width: 150 }} type="password"
                       placeholder={t.hasKey ? "(saved key)" : "stream key"} value={t.streamKey}
                       onFocus={() => editing.current = true} onBlur={() => editing.current = false}
                       onChange={(e) => update(t.id, { streamKey: e.target.value })} />
                <button className="btn-ghost sm" onClick={() => remove(t.id)} title="Remove">×</button>
              </div>
            );
          })}
        </div>

        <div className="row gap" style={{ flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
          <span className="muted" style={{ fontSize: ".72rem" }}>ADD:</span>
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} className="btn-ghost sm" onClick={() => addTarget(k)}>＋ {p.label}</button>
          ))}
          <div style={{ flex: 1 }} />
          <button className="btn-primary" disabled={busy} onClick={() => persist(targets)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          <span style={{ color: "#4ade80" }}>●</span> connected ·
          <span style={{ color: "#fb923c" }}> ●</span> connecting ·
          <span style={{ color: "#ef4444" }}> ●</span> failed ·
          <span style={{ color: "#a855f7" }}> ●</span> held (low bandwidth).
          SRT/RTSP/custom use copy (no re-encode). WHEP/FTL aren’t supported by FFmpeg.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Network · Auto-protect</h2>
          <button className={`mt-switch ${band?.autoProtect ? "on" : ""}`} title="Auto-protect"
                  onClick={() => setBandwidth({ autoProtect: !band?.autoProtect })} />
        </div>
        <p className="hint">
          Measures your real upload speed every {band ? Math.round(band.intervalMs / 60000) : 20} min
          (and right away if an output starts dropping). With auto-protect on, if your uplink can’t
          carry every enabled output it <b>holds the extras</b> (purple dot) instead of letting all of
          them stutter — and re-enables them once your speed recovers.
        </p>

        {band?.warning && <div className="banner warn" style={{ marginTop: 4 }}>⚠ {band.warning}</div>}

        <div className="bw-grid">
          <div className="bw-cell"><span>Upload</span><b>{mbps(band?.upMbps)}</b></div>
          <div className="bw-cell"><span>Baseline</span><b>{mbps(band?.baselineMbps)}</b></div>
          <div className="bw-cell"><span>Usable (80%)</span><b>{mbps(band?.usableMbps)}</b></div>
          <div className="bw-cell"><span>Per output</span><b>{mbps(band?.perStreamMbps)}</b></div>
          <div className="bw-cell"><span>Max outputs</span>
            <b>{band?.maxStreams != null ? band.maxStreams : "—"}</b></div>
          <div className="bw-cell"><span>Enabled</span>
            <b className={band && band.maxStreams != null && band.wanted > band.maxStreams ? "over" : ""}>
              {band ? band.wanted : "—"}</b></div>
        </div>

        <div className="row gap" style={{ alignItems: "center", marginTop: 10 }}>
          <button className="btn-ghost sm" disabled={!band || band.probing}
                  onClick={() => setBandwidth({ retest: true })}>
            {band?.probing ? "Testing…" : "Re-test now"}
          </button>
          <span className="muted" style={{ fontSize: ".72rem" }}>
            {band?.lastProbeAt
              ? `last tested ${ago(band.lastProbeAt)}`
              : band ? "no measurement yet" : "streamer offline / not desktop"}
          </span>
        </div>
      </section>

      <style jsx>{`
        .bw-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
          gap: 8px; margin-top: 10px;
        }
        .bw-cell {
          display: flex; flex-direction: column; gap: 2px;
          padding: 8px 10px; border-radius: 6px;
          background: rgba(0,0,0,.18); border: 1px solid var(--line);
        }
        .bw-cell span { font-size: .68rem; color: var(--muted, #8b95a7); text-transform: uppercase; letter-spacing: .04em; }
        .bw-cell b { font-size: 1.05rem; font-variant-numeric: tabular-nums; }
        .bw-cell b.over { color: #fbbf24; }
        .banner.warn { background: rgba(251,191,36,.12); border: 1px solid rgba(251,191,36,.4); color: #fde68a; border-radius: 6px; padding: 8px 10px; font-size: .82rem; }
        .mt-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
        .mt-row {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px;
          background: rgba(0,0,0,.18);
          border: 1px solid var(--line); border-radius: 6px;
        }
        .mt-row.on { border-color: rgba(0,240,255,.3); }
        .mt-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
        .mt-switch {
          flex: none; width: 40px; height: 22px; border-radius: 999px;
          border: 1px solid var(--line); background: rgba(255,255,255,.12);
          position: relative; cursor: pointer; transition: background .15s ease;
        }
        .mt-switch.on { background: var(--neon-cyan, #00f0ff); box-shadow: 0 0 10px rgba(0,240,255,.4); }
        .mt-switch::after {
          content: ""; position: absolute; top: 2px; left: 2px;
          width: 16px; height: 16px; border-radius: 50%; background: #fff;
          transition: left .15s ease;
        }
        .mt-switch.on::after { left: 20px; }
      `}</style>
    </>
  );
}
