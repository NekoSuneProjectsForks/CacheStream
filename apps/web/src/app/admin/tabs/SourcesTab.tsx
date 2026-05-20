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

/**
 * v1.13.7 — proper secret-handling UX for stream keys.
 *
 * Stream keys are credentials: anyone who has one can publish to
 * your CacheStream broadcast. Previously they were always
 * visible in the panel as plain text, which is risky if you
 * ever screen-share or stream the panel for a tutorial.
 *
 * New behaviour:
 *   - Keys are masked (•••• + last 4 chars) by default.
 *   - "Reveal" toggle exposes a key briefly; auto-hides after
 *     REVEAL_HIDE_MS so a forgotten reveal can't sit on-screen.
 *   - "Copy" puts the raw value on the clipboard without ever
 *     revealing it in the DOM. This is the safe default action.
 *   - On Add / Regenerate, the new key is shown ONCE in a
 *     prominent banner — the operator copies it, then it's
 *     masked like the others (still retrievable via Reveal,
 *     but the banner is the only place it gets emphasised).
 *   - Regenerate rotates a key in place: same row, same label,
 *     new value. Invalidates any encoder using the old key.
 *
 * Masking is purely a display convenience — anyone with panel
 * access (owner or mod) can still retrieve the raw value with
 * Reveal or Copy. The real fix for cred-on-display-leak is
 * having two-factor / shorter sessions / mod role, all of which
 * already exist (v1.13.0).
 */
const REVEAL_HIDE_MS = 10_000;

function MultiKeySection() {
  const [keys, setKeys] = useState<IngestKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [pushUrl, setPushUrl] = useState<string>("");
  const [revealed, setRevealed] = useState<Record<string, number>>({}); // key → hide deadline ms
  const [newKey, setNewKey] = useState<{ key: string; label: string; reason: "added" | "regenerated"; oldKey?: string } | null>(null);

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

  // Tick to expire reveal countdowns. Keeps the visual state
  // honest without needing a per-key timeout.
  useEffect(() => {
    if (Object.keys(revealed).length === 0) return;
    const id = setInterval(() => {
      const now = Date.now();
      let changed = false;
      const next: Record<string, number> = {};
      for (const [k, deadline] of Object.entries(revealed)) {
        if (deadline > now) next[k] = deadline;
        else changed = true;
      }
      if (changed) setRevealed(next);
    }, 500);
    return () => clearInterval(id);
  }, [revealed]);

  const add = async () => {
    if (!draftLabel.trim()) return;
    setError(null);
    try {
      const created = await apiJson("/api/ingest/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: draftLabel }),
      }) as { key: string; label: string };
      setDraftLabel("");
      setNewKey({ key: created.key, label: created.label, reason: "added" });
      await refresh();
    } catch (e: any) { setError(e.message); }
  };

  const remove = async (k: string) => {
    if (k === "cache") {
      alert("The 'cache' key is the default fallback; it can't be deleted. Use Regenerate to rotate it.");
      return;
    }
    if (!confirm(`Delete this stream key? Any encoder using it will lose access.`)) return;
    await fetch(`/api/ingest/keys/${encodeURIComponent(k)}`, { method: "DELETE" });
    await refresh();
  };

  const regenerate = async (k: IngestKey) => {
    if (!confirm(
      `Rotate this stream key?\n\n` +
      `The old value (${maskKey(k.key)}) will stop working immediately. ` +
      `Any encoder currently publishing with it must be updated to the ` +
      `new value before it can reconnect.`,
    )) return;
    setError(null);
    try {
      const res = await apiJson(`/api/ingest/keys/${encodeURIComponent(k.key)}/regenerate`, {
        method: "POST",
      }) as { oldKey: string; newKey: string; label: string };
      setNewKey({ key: res.newKey, label: res.label, reason: "regenerated", oldKey: res.oldKey });
      await refresh();
    } catch (e: any) { setError(e.message); }
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

  const reveal = (key: string) => {
    setRevealed((r) => ({ ...r, [key]: Date.now() + REVEAL_HIDE_MS }));
  };
  const hide = (key: string) => {
    setRevealed((r) => {
      const n = { ...r };
      delete n[key];
      return n;
    });
  };
  const isRevealed = (key: string) => (revealed[key] || 0) > Date.now();
  const revealSecondsLeft = (key: string) => Math.max(0, Math.ceil((revealed[key] - Date.now()) / 1000));

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
      <p className="hint" style={{ fontSize: 11, opacity: .7 }}>
        🔒 Keys are masked by default. Use <strong>Copy</strong> to copy a
        key into your clipboard without revealing it on-screen; use
        <strong> Reveal</strong> (auto-hides after 10s) only when you need
        to see the value, e.g. to type it on a phone.
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

      {/* New-key banner — only place a freshly-minted key is shown
          in plain text on the page. After dismiss, the key is still
          retrievable via Reveal, but the banner emphasis says
          "save it now" to encourage operators to copy + paste. */}
      {newKey && (
        <NewKeyBanner
          newKey={newKey}
          onDismiss={() => setNewKey(null)}
          onCopy={() => copy(newKey.key)}
        />
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
        {keys.map((k) => {
          const shown = isRevealed(k.key);
          return (
            <li key={k.key} className="row gap" style={{ alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{k.label || "(no label)"}</div>
                <div className="muted mono" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
                  key:&nbsp;
                  <span style={{ fontFamily: "monospace" }}>
                    {shown ? k.key : maskKey(k.key)}
                  </span>
                  {shown && (
                    <span style={{ fontSize: 9, color: "var(--text-mute)", letterSpacing: ".18em" }}>
                      HIDES IN {revealSecondsLeft(k.key)}s
                    </span>
                  )}
                </div>
                {k.live && (
                  <div className="muted" style={{ fontSize: 11, color: "#4ade80", marginTop: 2 }}>
                    {k.bitrateKbps ? `${k.bitrateKbps} kbps` : "publishing"}
                    {k.clientAddr ? ` · from ${k.clientAddr}` : ""}
                  </div>
                )}
              </div>
              <button className="btn-ghost sm" onClick={() => copy(k.key)} title="Copy stream key to clipboard">
                Copy
              </button>
              <button className="btn-ghost sm"
                      onClick={() => shown ? hide(k.key) : reveal(k.key)}
                      title={shown ? "Hide key" : "Reveal key (auto-hides after 10s)"}>
                {shown ? "Hide" : "Reveal"}
              </button>
              <span className={`badge ${k.live ? "badge-ok" : ""}`}>
                {k.live ? "LIVE" : "idle"}
              </span>
              <button className="btn-ghost sm" onClick={() => addAsScene(k)}>Use as scene</button>
              <button className="btn-ghost sm" onClick={() => regenerate(k)} title="Rotate to a new random value">
                Rotate
              </button>
              <button className="btn-ghost sm" onClick={() => remove(k.key)} title="Delete this key">×</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Last-chance banner shown above the keys list when a new key is
 * created or an existing one is regenerated. Encourages the
 * operator to copy + paste it into their encoder right now,
 * while it's prominent. After dismiss the key reverts to the
 * masked default like every other entry.
 */
function NewKeyBanner({
  newKey, onCopy, onDismiss,
}: {
  newKey: { key: string; label: string; reason: "added" | "regenerated"; oldKey?: string };
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="banner ok" style={{ marginBottom: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 12, marginBottom: 6, fontWeight: 700, letterSpacing: ".15em", textTransform: "uppercase" }}>
        {newKey.reason === "added" ? "Stream key created" : "Stream key rotated"}
        <span style={{ marginLeft: 8, color: "var(--text-mute)", fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>
          — copy it now; it&apos;ll be masked once you dismiss this banner.
        </span>
      </div>
      <div className="row gap" style={{ alignItems: "center" }}>
        <code style={{
          flex: 1, padding: "8px 10px", background: "rgba(0,0,0,.35)",
          borderRadius: 3, fontFamily: "monospace", fontSize: 13,
          overflowX: "auto", whiteSpace: "nowrap",
        }}>
          {newKey.key}
        </code>
        <button className="btn-primary sm" onClick={onCopy}>Copy</button>
        <button className="btn-ghost sm" onClick={onDismiss}>Dismiss</button>
      </div>
      {newKey.reason === "regenerated" && newKey.oldKey && (
        <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>
          Old value <code>{maskKey(newKey.oldKey)}</code> has been invalidated.
          Update your encoder before reconnecting.
        </div>
      )}
    </div>
  );
}

/**
 * Mask a key for display:
 *   `abc123def4567890` → `••••••••••••7890`
 * Keeps the last 4 characters as a recognisability hint so the
 * operator can tell two masked keys apart at a glance. Anything
 * shorter than 8 chars is fully masked.
 */
function maskKey(k: string): string {
  if (!k) return "";
  if (k.length < 8) return "•".repeat(k.length);
  return "•".repeat(Math.max(8, k.length - 4)) + k.slice(-4);
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
