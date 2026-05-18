"use client";

/**
 * Version + update card for the Status tab.
 *
 * Polls `/api/system/version` every 60s to learn the current
 * + latest CacheStream releases. When ahead, shows an "Update"
 * button that POSTs the marker file the host-side updater
 * script watches for. While an update is in flight (marker
 * still exists on disk) the button is replaced with a live
 * tail of the updater's last log lines.
 *
 * The updater watcher has to be installed on the host first
 * (`scripts/install-updater.sh`). When it isn't, the card
 * shows manual update instructions instead of a button.
 */

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./util";

interface VersionInfo {
  current: string;
  latest: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
  updaterInstalled: boolean;
  lastCheckedAt: number;
}

interface UpdateStatus {
  inFlight: boolean;
  requestedAt: number | null;
  lastLog: string | null;
}

const POLL_IDLE_MS = 60_000;
const POLL_BUSY_MS = 3_000;

export function SystemUpdateCard() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [v, s] = await Promise.all([
        apiJson("/api/system/version") as Promise<VersionInfo>,
        apiJson("/api/system/update") as Promise<UpdateStatus>,
      ]);
      setInfo(v);
      setStatus(s);
      setError(null);
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    // While an update is happening we poll fast so the user sees
    // the new version + the spinner clearing within a few seconds
    // of the watcher restarting the container. Idle, 60s is fine.
    const cadence = status?.inFlight ? POLL_BUSY_MS : POLL_IDLE_MS;
    const id = setInterval(refresh, cadence);
    return () => clearInterval(id);
  }, [refresh, status?.inFlight]);

  const triggerUpdate = useCallback(async () => {
    if (busy) return;
    if (!window.confirm("Update CacheStream now? The panel will be briefly unreachable while the new image rebuilds.")) {
      return;
    }
    setBusy(true);
    try {
      await apiJson("/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "latest" }),
      });
      await refresh();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  if (!info) return null;

  const tone = status?.inFlight
    ? "busy"
    : info.updateAvailable
      ? "warn"
      : "ok";

  return (
    <section className={`panel system-update-card tone-${tone}`}>
      <header className="row gap" style={{ alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>System</h2>
        <span className="muted" style={{ fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase" }}>
          version
        </span>
      </header>

      <div className="row gap" style={{ marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div className="muted" style={{ fontSize: 11, letterSpacing: ".22em", textTransform: "uppercase" }}>Running</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono, monospace)" }}>v{info.current}</div>
        </div>

        <div>
          <div className="muted" style={{ fontSize: 11, letterSpacing: ".22em", textTransform: "uppercase" }}>Latest</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono, monospace)" }}>
            {info.latest ? <>v{info.latest}</> : <span className="muted">unknown</span>}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 200, textAlign: "right" }}>
          {status?.inFlight ? (
            <span className="badge badge-info">UPDATING…</span>
          ) : info.updateAvailable ? (
            <span className="badge badge-warn">UPDATE AVAILABLE</span>
          ) : info.latest ? (
            <span className="badge badge-ok">UP TO DATE</span>
          ) : (
            <span className="badge">OFFLINE CHECK</span>
          )}
        </div>
      </div>

      {info.updateAvailable && info.latestUrl && (
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Release notes: <a href={info.latestUrl} target="_blank" rel="noreferrer">{info.latestUrl}</a>
        </div>
      )}

      <div className="row gap" style={{ marginTop: 14 }}>
        {info.updaterInstalled ? (
          <button
            className="btn-primary"
            onClick={triggerUpdate}
            disabled={busy || !info.updateAvailable || status?.inFlight}
          >
            {status?.inFlight ? "Updating…" : info.updateAvailable ? "Update now" : "Up to date"}
          </button>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            Updater not installed on host. Run on the Pi once:
            <pre style={{ marginTop: 6, padding: "8px 10px", background: "rgba(0,0,0,.3)",
                         borderRadius: 4, fontSize: 11, overflowX: "auto" }}>
{`cd ~/CacheStream
sudo bash scripts/install-updater.sh`}
            </pre>
          </div>
        )}
        <button className="btn-ghost" onClick={refresh}>Refresh</button>
      </div>

      {status?.lastLog && (
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>Updater log</summary>
          <pre style={{ marginTop: 6, padding: "8px 10px", background: "rgba(0,0,0,.3)",
                       borderRadius: 4, fontSize: 11, lineHeight: 1.5,
                       maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap" }}>
            {status.lastLog}
          </pre>
        </details>
      )}

      {error && <div className="error" style={{ marginTop: 10, fontSize: 12 }}>{error}</div>}
    </section>
  );
}
