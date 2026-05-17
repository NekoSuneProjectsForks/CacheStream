"use client";

import { useEffect, useRef, useState } from "react";
import { apiJson } from "./util";

interface BrandingSnapshot {
  displayName: string;
  tagline: string | null;
  accent: string | null;
  logoUrl: string | null;
  logoFile: string | null;
}

/**
 * Branding tab — single source of truth for the streamer's
 * display name, tagline, accent colour, and logo. Everything
 * else (scenes, landing page, admin header) reads from
 * /api/branding, so changes show up everywhere on the next
 * render without a restart.
 *
 * Note: scene pages are rendered server-side by headless
 * Chromium; existing scenes pick up updates the next time
 * the streamer reloads the scene URL (e.g. on Take or scene
 * switch). For an immediate refresh hit Restart on Status.
 */
export function BrandingTab({ initial }: { initial: BrandingSnapshot }) {
  const [branding, setBranding] = useState<BrandingSnapshot>(initial);
  const [draft, setDraft] = useState<{ displayName: string; tagline: string; accent: string }>({
    displayName: initial.displayName,
    tagline: initial.tagline || "",
    accent: initial.accent || "#00f0ff",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Auto-clear "info" toast after a few seconds.
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 2500);
    return () => clearTimeout(t);
  }, [info]);

  const save = async () => {
    setBusy("save"); setError(null);
    try {
      const next: BrandingSnapshot = await apiJson("/api/branding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: draft.displayName.trim() || "CacheStream",
          tagline: draft.tagline.trim() || null,
          accent: /^#[0-9a-fA-F]{3,8}$/.test(draft.accent) ? draft.accent : null,
        }),
      });
      setBranding(next);
      setInfo("Saved. Scenes refresh on next scene load.");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const uploadLogo = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy("logo"); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", files[0]);
      const r = await fetch("/api/branding/logo", { method: "POST", body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setBranding(body);
      setInfo("Logo uploaded.");
    } catch (e: any) { setError(e.message); }
    finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeLogo = async () => {
    if (!confirm("Remove the current logo?")) return;
    setBusy("logo-del"); setError(null);
    try {
      const r = await fetch("/api/branding/logo", { method: "DELETE" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setBranding(body);
      setInfo("Logo removed.");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <>
      {error && <div className="banner err">⚠ {error}</div>}
      {info  && <div className="banner ok">✓ {info}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Identity</h2>
          <span className="tag">used everywhere</span>
        </div>
        <p className="hint">
          Display name, tagline and accent colour are surfaced on every built-in
          and custom scene, the public landing page, and the admin header.
        </p>

        <div className="row gap" style={{ marginTop: ".75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 240px" }}>
            <Field label="Display name">
              <input
                className="input"
                maxLength={40}
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
              />
            </Field>
          </div>
          <div style={{ flex: "2 1 360px" }}>
            <Field label="Tagline (optional)">
              <input
                className="input"
                maxLength={120}
                value={draft.tagline}
                onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                placeholder="e.g. Coding live on Twitch · ambient streams 24/7"
              />
            </Field>
          </div>
          <div style={{ flex: "0 1 200px" }}>
            <Field label="Accent colour">
              <div className="row" style={{ gap: 6 }}>
                <input
                  type="color"
                  value={draft.accent}
                  onChange={(e) => setDraft({ ...draft, accent: e.target.value })}
                />
                <input
                  className="input mono"
                  value={draft.accent}
                  onChange={(e) => setDraft({ ...draft, accent: e.target.value })}
                />
              </div>
            </Field>
          </div>
        </div>

        <div className="actions" style={{ marginTop: ".75rem" }}>
          <button className="btn-primary" disabled={!!busy} onClick={save}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Logo</h2>
          {branding.logoFile && <span className="tag ok">uploaded</span>}
        </div>
        <p className="hint">
          PNG / JPG / WEBP / SVG / GIF up to 4 MB. Transparent backgrounds
          look best — the scene puts the logo on a dark backdrop and applies a
          subtle accent glow underneath.
        </p>

        <div className="logo-preview">
          <div className="logo-tile">
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt="current logo" />
            ) : (
              <span className="muted">No logo uploaded</span>
            )}
          </div>
          <div className="logo-actions">
            <button className="btn-primary" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              {busy === "logo" ? "Uploading…" : (branding.logoFile ? "Replace logo" : "Upload logo")}
            </button>
            {branding.logoFile && (
              <button className="btn-danger" disabled={!!busy} onClick={removeLogo}>
                {busy === "logo-del" ? "Removing…" : "Remove"}
              </button>
            )}
          </div>
          <input
            type="file"
            ref={fileRef}
            accept=".png,.jpg,.jpeg,.webp,.svg,.gif"
            style={{ display: "none" }}
            onChange={(e) => uploadLogo(e.target.files)}
          />
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Preview</h2></div>
        <p className="hint">
          Live preview of the branding inside a scene frame. Reflects unsaved
          accent / display name from above — save before going live to push it
          to the broadcast.
        </p>
        <div className="brand-preview" style={{
          background: `radial-gradient(ellipse at 50% 35%, ${draft.accent}30 0%, transparent 60%), #05060a`,
        }}>
          <div className="brand-preview-ribbon">
            {branding.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt="" />
            )}
            <span>{draft.displayName || "CacheStream"}</span>
          </div>
          <div className="brand-preview-title" style={{
            textShadow: `0 0 12px ${draft.accent}b0, 0 0 32px ${draft.accent}55`,
          }}>
            STARTING SOON
          </div>
          <div className="brand-preview-sub">{draft.tagline || "Stream begins shortly · stand by"}</div>
        </div>
      </section>

      <style jsx>{`
        .logo-preview {
          display: grid;
          grid-template-columns: 220px 1fr;
          gap: 16px;
          align-items: center;
          margin-top: .25rem;
        }
        @media (max-width: 700px) {
          .logo-preview { grid-template-columns: 1fr; }
        }
        .logo-tile {
          width: 220px;
          height: 140px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 12px;
          background:
            repeating-conic-gradient(rgba(255,255,255,0.02) 0% 25%, transparent 0% 50%) 0 0 / 18px 18px,
            #05060a;
          border: 1px solid var(--line);
          border-radius: 4px;
        }
        .logo-tile img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
        .logo-actions { display: flex; gap: 8px; }

        .brand-preview {
          margin-top: .5rem;
          padding: 36px;
          border-radius: 6px;
          border: 1px solid var(--line);
          aspect-ratio: 16/9;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          text-align: center;
          position: relative;
          overflow: hidden;
        }
        .brand-preview-ribbon {
          position: absolute;
          top: 16px;
          left: 18px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: rgba(230,247,255,0.6);
          font-size: 0.7rem;
          letter-spacing: 0.35em;
          text-transform: uppercase;
        }
        .brand-preview-ribbon img {
          height: 26px;
          width: auto;
          max-width: 100px;
          object-fit: contain;
        }
        .brand-preview-title {
          font-size: clamp(2.2rem, 5vw, 4.2rem);
          font-weight: 800;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .brand-preview-sub {
          color: var(--text-dim);
          letter-spacing: 0.18em;
          text-transform: uppercase;
          font-size: 0.85rem;
        }

        :global(.banner.ok) {
          color: var(--ok);
          background: rgba(74,222,128,0.08);
        }
      `}</style>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase",
        color: "var(--text-mute)", marginBottom: 4,
      }}>{label}</div>
      {children}
    </div>
  );
}
