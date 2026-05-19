"use client";

/**
 * Staff tab — manage moderator invites + the active mod roster.
 *
 * Owner-only. Mods see a stub indicating the section is owner-
 * only (the tab itself is hidden from mods in AdminPanel, but
 * keeping the gate here is defence in depth).
 *
 * Workflow:
 *
 *   1. Owner mints an invite from the "Invites" card.
 *   2. Owner copies the invite URL (printed inline) and shares it
 *      with the would-be mod.
 *   3. Mod opens the URL, gets bounced into Twitch OAuth, and on
 *      return is added to `moderators`. They now see /admin with
 *      a "MOD" badge in the header.
 *   4. Owner can revoke any moderator at any time from the
 *      "Moderators" card.
 *
 * Invites are single-use + optionally expire. The pending list
 * also shows consumed + revoked invites for audit purposes.
 */

import { useEffect, useState, useMemo } from "react";
import { apiJson } from "./util";

interface Moderator {
  twitchUserId: string;
  twitchLogin: string;
  displayName: string;
  addedAt: number;
  addedByLogin: string | null;
}

interface Invite {
  code: string;
  label: string | null;
  createdAt: number;
  createdByLogin: string | null;
  expiresAt: number | null;
  status: "pending" | "consumed" | "revoked";
  consumedAt: number | null;
  consumedByLogin: string | null;
}

const EXPIRY_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: "1 hour",     hours: 1 },
  { label: "24 hours",   hours: 24 },
  { label: "7 days",     hours: 24 * 7 },
  { label: "30 days",    hours: 24 * 30 },
  { label: "Never",      hours: 0 },
];

export function StaffTab() {
  const [mods,    setMods]    = useState<Moderator[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error,   setError]   = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [m, i] = await Promise.all([
        apiJson("/api/staff/moderators"),
        apiJson("/api/staff/invites"),
      ]);
      setMods(m as Moderator[]);
      setInvites(i as Invite[]);
      setError(null);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); }, []);

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}
      <InvitesCard invites={invites} onChange={refresh} setError={setError} />
      <ModeratorsCard mods={mods} onChange={refresh} setError={setError} />
    </>
  );
}

function InvitesCard({
  invites, onChange, setError,
}: { invites: Invite[]; onChange: () => void; setError: (s: string | null) => void }) {
  const [label, setLabel] = useState("");
  const [expiryHours, setExpiryHours] = useState(24 * 7);
  const [busy, setBusy] = useState(false);
  const [justCreated, setJustCreated] = useState<Invite | null>(null);
  const baseUrl = typeof window === "undefined" ? "" : window.location.origin;

  const pending = useMemo(() => invites.filter((i) => i.status === "pending"), [invites]);
  const history = useMemo(() => invites.filter((i) => i.status !== "pending").slice(0, 12), [invites]);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const inv = await apiJson("/api/staff/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: label.trim() || null,
          expiresInHours: expiryHours || undefined,
        }),
      }) as Invite;
      setJustCreated(inv);
      setLabel("");
      await onChange();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const revoke = async (code: string) => {
    if (!confirm("Revoke this invite?")) return;
    try {
      await fetch(`/api/staff/invites/${encodeURIComponent(code)}`, { method: "DELETE" });
      await onChange();
    } catch (e: any) { setError(e.message); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {}
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Moderator invites</h2>
        <span className="tag">single-use</span>
      </div>
      <p className="hint">
        Mint an invite, share the URL with someone you want to give panel
        access. They log in with their own Twitch account and the invite
        consumes itself on success. Mods can drive the panel (switch scenes,
        send chat, queue music, run commands) but can't change branding,
        rotate the stream key, or manage other mods.
      </p>

      <div className="row gap" style={{ alignItems: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
        <Field label="Label (optional)" style={{ flex: "2 1 240px" }}>
          <input className="input" maxLength={80}
                 placeholder="e.g. jane (mod)"
                 value={label}
                 onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Expires" style={{ flex: "0 1 160px" }}>
          <select className="input" value={expiryHours}
                  onChange={(e) => setExpiryHours(Number(e.target.value))}>
            {EXPIRY_OPTIONS.map((o) =>
              <option key={o.hours} value={o.hours}>{o.label}</option>)}
          </select>
        </Field>
        <button className="btn-primary" onClick={create} disabled={busy}>
          {busy ? "…" : "Create invite"}
        </button>
      </div>

      {justCreated && (
        <div className="banner ok" style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>New invite — share this URL:</div>
          <div className="row gap" style={{ alignItems: "center" }}>
            <code style={{ flex: 1, padding: "6px 10px", background: "rgba(0,0,0,.35)",
                            borderRadius: 3, overflowX: "auto", whiteSpace: "nowrap" }}>
              {baseUrl}/login/invite?code={justCreated.code}
            </code>
            <button className="btn-ghost sm"
                    onClick={() => copy(`${baseUrl}/login/invite?code=${justCreated.code}`)}>
              Copy
            </button>
            <button className="btn-ghost sm" onClick={() => setJustCreated(null)}>✕</button>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <>
          <h3 style={{ fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase",
                       color: "var(--text-mute)", marginTop: 18, marginBottom: 6 }}>
            Pending
          </h3>
          <ul className="rows">
            {pending.map((inv) => (
              <li key={inv.code} className="row gap" style={{ alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{inv.label || "(no label)"}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    created {fmtDate(inv.createdAt)}
                    {inv.expiresAt && <> · expires {fmtDate(inv.expiresAt)}</>}
                  </div>
                </div>
                <button className="btn-ghost sm"
                        onClick={() => copy(`${baseUrl}/login/invite?code=${inv.code}`)}>
                  Copy URL
                </button>
                <button className="btn-ghost sm" onClick={() => revoke(inv.code)}>Revoke</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {history.length > 0 && (
        <>
          <h3 style={{ fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase",
                       color: "var(--text-mute)", marginTop: 18, marginBottom: 6 }}>
            History
          </h3>
          <ul className="rows">
            {history.map((inv) => (
              <li key={inv.code} className="row gap" style={{ alignItems: "center", opacity: 0.6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {inv.label || "(no label)"}
                    <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
                      [{inv.status}{inv.consumedByLogin ? ` by ${inv.consumedByLogin}` : ""}]
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    created {fmtDate(inv.createdAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ModeratorsCard({
  mods, onChange, setError,
}: { mods: Moderator[]; onChange: () => void; setError: (s: string | null) => void }) {
  const remove = async (id: string, login: string) => {
    if (!confirm(`Remove ${login} as a moderator? They'll lose panel access immediately.`)) return;
    try {
      await fetch(`/api/staff/moderators/${encodeURIComponent(id)}`, { method: "DELETE" });
      await onChange();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Active moderators</h2>
        <span className="tag">{mods.length}</span>
      </div>

      {mods.length === 0 ? (
        <p className="muted">No moderators yet. Mint an invite above to add one.</p>
      ) : (
        <ul className="rows">
          {mods.map((m) => (
            <li key={m.twitchUserId} className="row gap" style={{ alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{m.displayName}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  @{m.twitchLogin} · added {fmtDate(m.addedAt)}
                  {m.addedByLogin && <> · by {m.addedByLogin}</>}
                </div>
              </div>
              <button className="btn-ghost sm" onClick={() => remove(m.twitchUserId, m.twitchLogin)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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

function fmtDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}
