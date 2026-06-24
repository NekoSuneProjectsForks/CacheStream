"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./util";

/**
 * Connections tab — link the owner account to streaming platforms.
 * Twitch is the existing single-provider login (shown as linked). Kick
 * is the first added provider (OAuth2 PKCE). YouTube + VPzone are
 * placeholders ("coming soon"). See docs/design/multi-platform-accounts.md.
 */

interface Conn {
  platform: string;
  label: string;
  linked: boolean;
  login: string | null;
  configured: boolean;
  comingSoon: boolean;
  canLink: boolean;
}
interface Summary {
  connections: Conn[];
  kick: { clientId: string; hasSecret: boolean; redirectUri: string };
  oauthRelay: { mode: "public" | "local"; url: string; relayRedirectUri: string };
}

export function ConnectionsTab() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kickId, setKickId] = useState("");
  const [kickSecret, setKickSecret] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await apiJson("/api/platforms");
      setData(d);
      setKickId(d.kick?.clientId || "");
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveKickCreds = async () => {
    setBusy("kick-save"); setError(null);
    try {
      const d = await apiJson("/api/platforms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kickClientId: kickId, kickClientSecret: kickSecret || undefined }),
      });
      setData(d); setKickSecret("");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const setMode = async (mode: "public" | "local") => {
    setBusy("mode"); setError(null);
    try {
      const d = await apiJson("/api/platforms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relayMode: mode }),
      });
      setData(d);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const unlink = async (platform: string) => {
    if (!confirm(`Unlink ${platform}?`)) return;
    setBusy(`unlink-${platform}`); setError(null);
    try {
      const d = await apiJson("/api/platforms", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      setData(d);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  if (!data) return <div className="muted">Loading…</div>;
  const kick = data.connections.find((c) => c.platform === "kick");

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}

      <section className="card">
        <div className="card-head"><h2>Login method</h2><span className="muted">how platforms authenticate</span></div>
        <div className="mode-row">
          <button className={`mode-btn ${data.oauthRelay.mode === "public" ? "on" : ""}`}
                  disabled={!!busy} onClick={() => setMode("public")}>
            <span className="mode-title">Public relay</span>
            <span className="mode-sub">No setup — uses the hosted server</span>
          </button>
          <button className={`mode-btn ${data.oauthRelay.mode === "local" ? "on" : ""}`}
                  disabled={!!busy} onClick={() => setMode("local")}>
            <span className="mode-title">Local · own keys</span>
            <span className="mode-sub">Direct OAuth with your own app keys</span>
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {data.oauthRelay.mode === "public"
            ? <>Brokered through <code>{data.oauthRelay.url}</code> — no client id/secret to register.
                The relay never exposes its keys; tokens come back over a one-time code.</>
            : <>You register each platform's OAuth app yourself and paste the client id + secret below.
                Nothing leaves your server.</>}
        </p>
      </section>

      <section className="card">
        <div className="card-head"><h2>Connections</h2><span className="muted">link your platforms</span></div>
        <p className="hint">
          Link the platforms you stream to. Chat + alerts from each linked
          platform feed the same overlays. YouTube &amp; VPzone are coming soon.
        </p>

        <div className="conn-grid">
          {data.connections.map((c) => (
            <div key={c.platform} className={`conn-row ${c.linked ? "on" : ""}`}>
              <div className="conn-meta">
                <div className="conn-name">{c.label}</div>
                <div className="conn-state">
                  {c.comingSoon ? <span className="muted">Coming soon</span>
                    : c.linked ? <span className="ok">Linked{c.login ? ` · ${c.login}` : ""}</span>
                    : c.platform === "twitch" ? <span className="muted">Sign in via the login screen</span>
                    : <span className="muted">Not linked</span>}
                </div>
              </div>
              <div className="conn-actions">
                {c.comingSoon && <button className="btn-ghost sm" disabled>Soon</button>}
                {!c.comingSoon && c.canLink && !c.linked && c.configured && (
                  <a className="btn-primary sm" href="/api/auth/kick/login">Link {c.label}</a>
                )}
                {!c.comingSoon && c.canLink && c.linked && (
                  <button className="btn-danger sm" disabled={busy === `unlink-${c.platform}`}
                          onClick={() => unlink(c.platform)}>Unlink</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Kick app credentials — required before linking. */}
      {kick && !kick.configured && (
        <section className="card">
          <div className="card-head"><h2>Kick app</h2></div>
          <p className="hint">
            Create an app in your Kick developer settings, set its redirect URL to
            the value below, then paste the Client ID + Secret here.
          </p>
          <div className="row gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <input className="input mono grow" placeholder="Kick Client ID"
                   value={kickId} onChange={(e) => setKickId(e.target.value)} />
            <input className="input mono grow" type="password" placeholder="Kick Client Secret"
                   value={kickSecret} onChange={(e) => setKickSecret(e.target.value)} />
            <button className="btn-primary" disabled={!!busy || !kickId} onClick={saveKickCreds}>
              {busy === "kick-save" ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Redirect URL: <code>{data.kick.redirectUri}</code>
          </p>
        </section>
      )}

      <style jsx>{`
        .conn-grid { display: grid; gap: 8px; margin-top: 6px; }
        .conn-row {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; padding: 12px 14px;
          background: rgba(0,0,0,.18);
          border: 1px solid var(--line); border-radius: 6px;
        }
        .conn-row.on { border-color: rgba(0,240,255,.35); background: rgba(0,240,255,.05); }
        .conn-name { font-weight: 700; }
        .conn-state { font-size: .82rem; margin-top: 2px; }
        .conn-state :global(.ok) { color: var(--ok, #4ade80); }

        .mode-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
        .mode-btn {
          display: flex; flex-direction: column; gap: 2px; text-align: left;
          padding: 12px 14px; border-radius: 6px; cursor: pointer;
          background: rgba(0,0,0,.18); border: 1px solid var(--line); color: inherit;
          transition: border-color .15s ease, background .15s ease;
        }
        .mode-btn:hover { border-color: rgba(0,240,255,.3); }
        .mode-btn.on { border-color: var(--neon-cyan, #00f0ff); background: rgba(0,240,255,.08); box-shadow: 0 0 14px rgba(0,240,255,.2); }
        .mode-btn:disabled { opacity: .6; cursor: default; }
        .mode-title { font-weight: 700; }
        .mode-sub { font-size: .76rem; color: var(--text-dim, #8b95a7); }
        @media (max-width: 560px) { .mode-row { grid-template-columns: 1fr; } }
      `}</style>
    </>
  );
}
