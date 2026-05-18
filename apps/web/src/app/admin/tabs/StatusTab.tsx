"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ScenePreset,
  OverlaySet,
  Overlay,
  ScheduleEntry,
} from "@/lib/store";
import type { StreamerStatus } from "@/lib/streamer-client";
import { apiJson } from "./util";
import { SystemUpdateCard } from "./SystemUpdateCard";

interface Props {
  initialStatus: StreamerStatus | null;
  initialScenes: ScenePreset[];
  initialOverlaySets: OverlaySet[];
  initialActiveOverlayId: string | null;
  initialSchedule: ScheduleEntry[];
  defaultSceneUrl: string;
}

// Polling cadence for the status block. 5s instead of 3s is
// barely noticeable in the UI and reduces server CPU on quiet
// boxes by ~40% compared to v1.2.
const POLL_INTERVAL_MS = 5_000;

/**
 * Status tab — live stream state, scene presets, overlays, schedule.
 * This is the v1.1 control panel body, unchanged in behaviour.
 */
export function StatusTab(props: Props) {
  const [status, setStatus] = useState<StreamerStatus | null>(props.initialStatus);
  // Twitch's own view of "are we live" — independent of the
  // streamer's "I'm pushing bytes" state. Fetched on the same
  // cadence as the status poll below.
  const [liveCheck, setLiveCheck] = useState<{
    liveOnTwitch: boolean;
    reason: string;
    stream: { startedAt: string; viewerCount: number; title: string; game: string } | null;
  } | null>(null);
  const [scenes, setScenes] = useState<ScenePreset[]>(props.initialScenes);
  const [overlaySets, setOverlaySets] = useState<OverlaySet[]>(props.initialOverlaySets);
  const [activeOverlayId, setActiveOverlayId] = useState<string | null>(props.initialActiveOverlayId);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>(props.initialSchedule);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [s, l] = await Promise.all([
          fetch("/api/stream/status",   { cache: "no-store" }).then((r) => r.ok ? r.json() : null),
          // /api/twitch/live can 502 if Helix is down; that's fine,
          // we just keep the previous value rather than flapping.
          fetch("/api/twitch/live",     { cache: "no-store" }).then((r) => r.ok ? r.json() : null),
        ]);
        if (cancelled) return;
        if (s) setStatus(s.status);
        if (l) setLiveCheck(l);
      } catch {}
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null);
    try { await fn(); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(null); }
  }, []);

  const start    = () => run("start",   async () => setStatus((await apiJson("/api/stream/start",   { method: "POST" })).status));
  const stop     = () => run("stop",    async () => setStatus((await apiJson("/api/stream/stop",    { method: "POST" })).status));
  const restart  = () => run("restart", async () => setStatus((await apiJson("/api/stream/restart", { method: "POST" })).status));

  const [sceneUrlInput, setSceneUrlInput] = useState(props.initialStatus?.sceneUrl || props.defaultSceneUrl);
  const setSceneNow = () =>
    run("scene", async () => {
      setStatus((await apiJson("/api/stream/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sceneUrlInput }),
      })).status);
    });

  const [newSceneName, setNewSceneName] = useState("");
  const [newSceneUrl, setNewSceneUrl] = useState("");
  const addScene = () =>
    run("scene-add", async () => {
      const { scene } = await apiJson("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newSceneName, url: newSceneUrl }),
      });
      setScenes((s) => [...s, scene]);
      setNewSceneName(""); setNewSceneUrl("");
    });
  const removeScene = (id: string) =>
    run("scene-del", async () => {
      await apiJson(`/api/scenes/${id}`, { method: "DELETE" });
      setScenes((s) => s.filter((x) => x.id !== id));
    });
  const activateScene = (id: string) =>
    run("scene-act", async () => {
      const { status } = await apiJson(`/api/scenes/${id}/activate`, { method: "POST" });
      setStatus(status);
    });

  // ---- Overlays ---------------------------------------------
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [overlaySetName, setOverlaySetName] = useState("");
  const addOverlayRow = () =>
    setOverlays((o) => [
      ...o,
      { id: crypto.randomUUID(), type: "text", text: "Live", bottom: "24px", left: "24px" },
    ]);
  const updateOverlay = (id: string, patch: Partial<Overlay>) =>
    setOverlays((o) => o.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeOverlay = (id: string) =>
    setOverlays((o) => o.filter((x) => x.id !== id));
  const saveOverlaySet = () =>
    run("overlay-save", async () => {
      const { overlaySet } = await apiJson("/api/overlays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: overlaySetName || "Untitled", overlays }),
      });
      setOverlaySets((s) => [...s, overlaySet]);
      setOverlaySetName("");
    });
  const activateOverlaySet = (id: string) =>
    run("overlay-act", async () => {
      const { status, overlaySet } = await apiJson(`/api/overlays/${id}/activate`, { method: "POST" });
      setStatus(status);
      setActiveOverlayId(overlaySet.id);
    });
  const clearOverlays = () =>
    run("overlay-clr", async () => {
      const { status } = await apiJson("/api/overlays/clear", { method: "POST" });
      setStatus(status); setActiveOverlayId(null);
    });
  const removeOverlaySet = (id: string) =>
    run("overlay-del", async () => {
      await apiJson(`/api/overlays/${id}`, { method: "DELETE" });
      setOverlaySets((s) => s.filter((x) => x.id !== id));
      if (activeOverlayId === id) setActiveOverlayId(null);
    });

  // ---- Schedule ---------------------------------------------
  const [sched, setSched] = useState<{ scenePresetId: string; overlaySetId: string; at: string; days: number[] }>({
    scenePresetId: "", overlaySetId: "", at: "12:00", days: [],
  });
  const addSchedule = () =>
    run("sched-add", async () => {
      const { entry } = await apiJson("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          scenePresetId: sched.scenePresetId,
          overlaySetId: sched.overlaySetId || null,
          at: sched.at,
          days: sched.days,
        }),
      });
      setSchedule((s) => [...s, entry]);
    });
  const toggleSchedule = (entry: ScheduleEntry) =>
    run("sched-tog", async () => {
      const { entry: updated } = await apiJson(`/api/schedule/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !entry.enabled }),
      });
      setSchedule((s) => s.map((x) => (x.id === entry.id ? updated : x)));
    });
  const removeSchedule = (id: string) =>
    run("sched-del", async () => {
      await apiJson(`/api/schedule/${id}`, { method: "DELETE" });
      setSchedule((s) => s.filter((x) => x.id !== id));
    });

  // ---- Derived ----------------------------------------------
  // The badge collapses three signals into one colour:
  //   - status.state          (idle / running / reconnecting / etc.)
  //   - status.ingestAccepted (FFmpeg confirmed Twitch ACK'd RTMP)
  //   - liveCheck.liveOnTwitch (Helix says the channel is live)
  //
  // All three green → broadcast really is on Twitch.
  // FFmpeg says yes but Twitch /streams says no → red, with a hint.
  // FFmpeg says yes AND Twitch says yes → solid green LIVE.
  const stateColor = useMemo(() => {
    switch (status?.state) {
      case "running":
        if (status.ingestAccepted === false)        return "err";
        if (liveCheck && liveCheck.liveOnTwitch)    return "ok";
        // Encoding fine, ingest ACK'd, but Helix /streams hasn't
        // shown the channel as live yet. Could be propagation
        // (~30s after first frames), or a silent reject Helix
        // happens to know about. Yellow so the operator notices.
        if (liveCheck && !liveCheck.liveOnTwitch)   return "warn";
        return "ok";
      case "starting":     return "warn";
      case "reconnecting": return "warn";
      case "stopping":     return "warn";
      default:             return "mute";
    }
  }, [status?.state, status?.ingestAccepted, liveCheck?.liveOnTwitch]);

  const stateLabel = useMemo(() => {
    if (status?.state !== "running") return status?.state || "unknown";
    if (status.ingestAccepted === false) return "running · not on twitch";
    if (liveCheck && !liveCheck.liveOnTwitch) return "encoding · waiting for twitch";
    if (liveCheck?.liveOnTwitch) return "LIVE on twitch";
    return "running";
  }, [status?.state, status?.ingestAccepted, liveCheck?.liveOnTwitch]);

  const uptime = useMemo(() => {
    if (!status?.startedAt) return "—";
    const ms = Date.now() - status.startedAt;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${h}h ${m}m ${ss}s`;
  }, [status?.startedAt, status?.uptimeMs]);

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card status-card">
        <div className="card-head">
          <h2>Live status</h2>
          <span className={`badge ${stateColor}`}>{stateLabel}</span>
        </div>
        <div className="metrics">
          <Metric label="Scene"        value={status?.sceneUrl || "—"} mono />
          <Metric label="Uptime"       value={uptime} />
          <Metric label="Frames"       value={status?.frameCount?.toLocaleString() ?? "0"} />
          <Metric label="Resolution"   value={status ? `${status.video.width}×${status.video.height} @ ${status.video.fps}fps` : "—"} />
          <Metric label="Bitrate"      value={status ? `${status.video.bitrateKbps} kbps` : "—"} />
          <Metric label="Codec"        value={status?.autoProfile?.codecTag || status?.video.codec || "libx264"} />
          <Metric label="Ingest"       value={status?.twitch.ingestUrl || "—"} mono />
          <Metric label="Stream key"   value={status?.twitch.keyConfigured ? "configured" : "MISSING"} tone={status?.twitch.keyConfigured ? "ok" : "err"} />
          {status?.autoProfile && (
            <Metric
              label="Auto-profile"
              value={`${status.autoProfile.category} · ${status.autoProfile.host?.cores ?? "?"}c ${status.autoProfile.host?.arch ?? ""}`}
            />
          )}
          {status?.thermal?.enabled && (
            <Metric
              label="CPU temp"
              value={status.thermal.lastTempC != null ? `${status.thermal.lastTempC}°C` : "—"}
              tone={status.thermal.state === "throttled" ? "err" : undefined}
            />
          )}
          {liveCheck?.stream && (
            <>
              <Metric
                label="Twitch viewers"
                value={liveCheck.stream.viewerCount.toLocaleString()}
                tone="ok"
              />
              <Metric
                label="Twitch title"
                value={liveCheck.stream.title || "—"}
              />
            </>
          )}
          {status?.error && <Metric label="Last error" value={status.error} tone="err" />}
        </div>

        <div className="actions">
          <button className="btn-primary" disabled={!!busy || status?.state === "running"} onClick={start}>
            {busy === "start" ? "Starting…" : "Start stream"}
          </button>
          <button className="btn-danger" disabled={!!busy || status?.state === "idle"} onClick={stop}>
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button className="btn-ghost" disabled={!!busy} onClick={restart}>
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Scene URL</h2></div>
        <div className="row">
          <input className="input mono" value={sceneUrlInput} onChange={(e) => setSceneUrlInput(e.target.value)} placeholder="https://..." />
          <button className="btn-primary" disabled={!!busy} onClick={setSceneNow}>
            {busy === "scene" ? "Switching…" : "Switch live"}
          </button>
        </div>
        <p className="hint">Any URL the streamer container can reach. Inside compose, the bundled scene is <code>http://web:7788/scene</code>.</p>
      </section>

      <section className="card">
        <div className="card-head"><h2>Scene presets</h2></div>
        <ul className="list">
          {scenes.length === 0 && <li className="muted">No presets yet — add one below.</li>}
          {scenes.map((s) => (
            <li key={s.id} className="list-row">
              <div className="grow">
                <div className="row-title">{s.name}</div>
                <div className="row-sub mono">{s.url}</div>
              </div>
              <button className="btn-primary sm" disabled={!!busy} onClick={() => activateScene(s.id)}>Activate</button>
              <button className="btn-ghost sm"   disabled={!!busy} onClick={() => removeScene(s.id)}>×</button>
            </li>
          ))}
        </ul>
        <div className="row gap">
          <input className="input"      placeholder="Name (e.g. Grafana)" value={newSceneName} onChange={(e) => setNewSceneName(e.target.value)} />
          <input className="input mono" placeholder="https://..."          value={newSceneUrl}  onChange={(e) => setNewSceneUrl(e.target.value)} />
          <button className="btn-primary" disabled={!!busy || !newSceneUrl} onClick={addScene}>Add preset</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Overlays</h2>
          <button className="btn-ghost sm" disabled={!!busy} onClick={clearOverlays}>Clear live</button>
        </div>

        <h3 className="subhead">Saved sets</h3>
        <ul className="list">
          {overlaySets.length === 0 && <li className="muted">No saved overlay sets yet.</li>}
          {overlaySets.map((o) => (
            <li key={o.id} className="list-row">
              <div className="grow">
                <div className="row-title">
                  {o.name}
                  {activeOverlayId === o.id && <span className="tag ok">ACTIVE</span>}
                </div>
                <div className="row-sub">{o.overlays.length} layer{o.overlays.length === 1 ? "" : "s"}</div>
              </div>
              <button className="btn-primary sm" disabled={!!busy} onClick={() => activateOverlaySet(o.id)}>Activate</button>
              <button className="btn-ghost sm"   disabled={!!busy} onClick={() => removeOverlaySet(o.id)}>×</button>
            </li>
          ))}
        </ul>

        <h3 className="subhead">Builder</h3>
        <p className="hint">Layers are injected into the live page's DOM, so they render at the full configured framerate with no extra CPU cost. Tip: use <code>chat</code> or <code>alert</code> type and an HTML body to render live chat / alert widgets inside the stream.</p>

        {overlays.length === 0 && <div className="muted">No layers in this draft.</div>}
        {overlays.map((o) => (
          <div key={o.id} className="overlay-row">
            <select className="input sm" value={o.type} onChange={(e) => updateOverlay(o.id, { type: e.target.value as Overlay["type"] })}>
              <option value="text">text</option>
              <option value="html">html</option>
              <option value="image">image</option>
              <option value="chat">chat</option>
              <option value="alert">alert</option>
            </select>
            {o.type === "text" && (
              <input className="input grow" placeholder="Text"  value={o.text || ""} onChange={(e) => updateOverlay(o.id, { text: e.target.value })} />
            )}
            {o.type === "html" && (
              <input className="input grow mono" placeholder="<div>...</div>" value={o.html || ""} onChange={(e) => updateOverlay(o.id, { html: e.target.value })} />
            )}
            {(o.type === "image" || o.type === "chat" || o.type === "alert") && (
              <input
                className="input grow mono"
                placeholder={
                  o.type === "chat"  ? "http://web:7788/widgets/chat" :
                  o.type === "alert" ? "http://web:7788/widgets/alert" :
                  "https://...image.png"
                }
                value={o.src || ""}
                onChange={(e) => updateOverlay(o.id, { src: e.target.value })}
              />
            )}
            <input className="input xs" placeholder="top"    value={o.top    || ""} onChange={(e) => updateOverlay(o.id, { top:    e.target.value || undefined })} />
            <input className="input xs" placeholder="right"  value={o.right  || ""} onChange={(e) => updateOverlay(o.id, { right:  e.target.value || undefined })} />
            <input className="input xs" placeholder="bottom" value={o.bottom || ""} onChange={(e) => updateOverlay(o.id, { bottom: e.target.value || undefined })} />
            <input className="input xs" placeholder="left"   value={o.left   || ""} onChange={(e) => updateOverlay(o.id, { left:   e.target.value || undefined })} />
            <button className="btn-ghost sm" onClick={() => removeOverlay(o.id)}>×</button>
          </div>
        ))}

        <div className="row gap">
          <button className="btn-ghost"   onClick={addOverlayRow}>+ layer</button>
          <input className="input" placeholder="Set name" value={overlaySetName} onChange={(e) => setOverlaySetName(e.target.value)} />
          <button className="btn-primary" disabled={!!busy || overlays.length === 0} onClick={saveOverlaySet}>Save set</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Scene scheduler</h2></div>
        <p className="hint">Rotation entries fire on the server-local clock with minute resolution. Empty <em>days</em> = every day.</p>

        <ul className="list">
          {schedule.length === 0 && <li className="muted">No schedule entries yet.</li>}
          {schedule.map((s) => {
            const scene = scenes.find((x) => x.id === s.scenePresetId);
            const overlay = overlaySets.find((x) => x.id === s.overlaySetId);
            return (
              <li key={s.id} className="list-row">
                <div className="grow">
                  <div className="row-title">
                    {s.at} — {scene?.name || <em className="muted">(deleted scene)</em>}
                    {overlay && <span className="tag">+ {overlay.name}</span>}
                    {!s.enabled && <span className="tag warn">disabled</span>}
                  </div>
                  <div className="row-sub">{s.days.length === 0 ? "every day" : s.days.map((d) => "SMTWTFS"[d]).join(" ")}</div>
                </div>
                <button className="btn-ghost sm" disabled={!!busy} onClick={() => toggleSchedule(s)}>{s.enabled ? "Disable" : "Enable"}</button>
                <button className="btn-ghost sm" disabled={!!busy} onClick={() => removeSchedule(s.id)}>×</button>
              </li>
            );
          })}
        </ul>

        <div className="row gap">
          <select className="input" value={sched.scenePresetId} onChange={(e) => setSched({ ...sched, scenePresetId: e.target.value })}>
            <option value="">— pick scene —</option>
            {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="input" value={sched.overlaySetId} onChange={(e) => setSched({ ...sched, overlaySetId: e.target.value })}>
            <option value="">(no overlay)</option>
            {overlaySets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <input type="time" className="input sm" value={sched.at} onChange={(e) => setSched({ ...sched, at: e.target.value })} />
          <DayPicker days={sched.days} onChange={(days) => setSched({ ...sched, days })} />
          <button className="btn-primary" disabled={!!busy || !sched.scenePresetId} onClick={addSchedule}>Add</button>
        </div>
      </section>

      <SystemUpdateCard />
    </>
  );
}

function Metric({ label, value, mono, tone }: { label: string; value: string | number; mono?: boolean; tone?: "ok" | "err" }) {
  return (
    <div className={`metric tone-${tone || "default"}`}>
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

function DayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  const letters = ["S", "M", "T", "W", "T", "F", "S"];
  const toggle = (d: number) => onChange(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());
  return (
    <div className="day-picker" role="group" aria-label="Days of week">
      {letters.map((l, i) => (
        <button
          key={i}
          type="button"
          className={`day ${days.includes(i) ? "on" : ""}`}
          onClick={() => toggle(i)}
          aria-pressed={days.includes(i)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
