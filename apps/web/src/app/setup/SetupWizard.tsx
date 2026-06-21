"use client";

import { useCallback, useEffect, useState } from "react";

interface Requirements {
  hasPublicUrl: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasSessionSecret: boolean;
  hasOwnerLogin: boolean;
}

interface Props {
  requirements: Requirements;
  publicUrl: string;
  redirectUri: string;
}

type Step = "welcome" | "devapp" | "login" | "done";

/**
 * Multi-step setup wizard.
 *
 * Each step is gated by its own "is this satisfied?" check derived
 * from the server-rendered `requirements` snapshot. We persist the
 * client's choices via the /api/setup/* routes which write to kv.
 *
 * UX rules:
 *   - Never block the user from going back to a previous step.
 *   - The "next" button is only enabled when the current step's
 *     requirement is satisfied.
 *   - Sensitive values (client secret) are write-only in the form;
 *     we never read them back, only show "configured / not yet".
 */
export function SetupWizard(props: Props) {
  // Initial step = first unsatisfied requirement.
  const initial: Step = !props.requirements.hasPublicUrl
    ? "welcome"
    : (!props.requirements.hasClientId || !props.requirements.hasClientSecret)
    ? "devapp"
    : "login";
  const [step, setStep] = useState<Step>(initial);
  const [reqs, setReqs] = useState<Requirements>(props.requirements);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch requirements after any step save so the gate state
  // stays in sync without a full page reload.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/setup/requirements", { cache: "no-store" });
      if (r.ok) setReqs(await r.json());
    } catch {}
  }, []);

  return (
    <main className="admin-shell">
      <header className="admin-head">
        <div className="brand-row">
          <div className="brand">CacheStream</div>
          <div className="brand-sub">first-run setup</div>
        </div>
      </header>

      <div className="wizard">
        <StepperBar current={step} reqs={reqs} onSelect={(s) => setStep(s)} />

        {error && <div className="banner err">⚠ {error}</div>}

        {step === "welcome" && (
          <WelcomeStep
            publicUrl={props.publicUrl}
            ok={reqs.hasPublicUrl}
            onNext={() => setStep("devapp")}
          />
        )}
        {step === "devapp" && (
          <DevAppStep
            redirectUri={props.redirectUri}
            reqs={reqs}
            setError={setError}
            refresh={refresh}
            onNext={() => setStep("login")}
          />
        )}
        {step === "login" && (
          <LoginStep
            redirectUri={props.redirectUri}
            reqs={reqs}
          />
        )}
      </div>

      <style jsx>{`
        .wizard {
          max-width: 760px;
          margin: 2rem auto 4rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }
      `}</style>
    </main>
  );
}

// ---- Stepper bar -------------------------------------------------

function StepperBar({
  current, reqs, onSelect,
}: { current: Step; reqs: Requirements; onSelect: (s: Step) => void }) {
  const steps: Array<{ key: Step; label: string; done: boolean }> = [
    { key: "welcome", label: "Preflight",     done: reqs.hasPublicUrl },
    { key: "devapp",  label: "Twitch app",    done: reqs.hasClientId && reqs.hasClientSecret },
    { key: "login",   label: "Login & finish",done: false }, // sealed by the OAuth redirect
  ];
  return (
    <div className="stepper">
      {steps.map((s, i) => {
        const active = s.key === current;
        return (
          <button
            key={s.key}
            type="button"
            className={`step ${active ? "active" : ""} ${s.done ? "done" : ""}`}
            onClick={() => onSelect(s.key)}
          >
            <span className="num">{i + 1}</span>
            <span className="lbl">{s.label}</span>
          </button>
        );
      })}
      <style jsx>{`
        .stepper {
          display: flex;
          gap: 8px;
          padding: 14px;
          background: rgba(5, 6, 10, 0.55);
          border: 1px solid var(--line);
          border-radius: 6px;
        }
        .step {
          flex: 1;
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          background: transparent;
          color: var(--text-dim);
          border: 1px solid transparent;
          border-radius: 4px;
          font-family: inherit;
          font-size: 0.85rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          text-align: left;
          cursor: pointer;
        }
        .step:hover { color: var(--text); }
        .step.active {
          color: var(--neon-cyan);
          border-color: rgba(0,240,255,0.5);
          background: rgba(0,240,255,0.07);
          box-shadow: 0 0 18px rgba(0,240,255,0.18);
        }
        .step.done .num {
          background: var(--ok);
          color: var(--bg-0);
        }
        .num {
          width: 26px; height: 26px;
          border-radius: 50%;
          background: rgba(255,255,255,0.08);
          color: var(--text-dim);
          display: inline-flex; align-items: center; justify-content: center;
          font-weight: 800;
          font-size: 0.95rem;
        }
        .step.active .num {
          background: var(--neon-cyan);
          color: var(--bg-0);
        }
      `}</style>
    </div>
  );
}

// ---- Step 1: Preflight -------------------------------------------

function WelcomeStep({
  publicUrl, ok, onNext,
}: { publicUrl: string; ok: boolean; onNext: () => void }) {
  return (
    <section className="card">
      <div className="card-head"><h2>Welcome</h2></div>
      <p>
        Six-step first-run setup. After this you'll never need to
        edit <code>.env</code> again for Twitch — everything else is
        managed from the control panel.
      </p>

      <h3 className="subhead">Preflight</h3>
      <p className="hint">
        CacheStream needs to know its own public hostname so OAuth
        redirects work. This <strong>must</strong> be set in your
        <code>.env</code> before the wizard can continue.
      </p>

      <div className="metrics" style={{ marginTop: "1rem" }}>
        <Metric label="PUBLIC_URL" value={publicUrl} tone={ok ? "ok" : "err"} mono />
      </div>

      {!ok && (
        <div className="banner err" style={{ marginTop: "1rem" }}>
          <strong>PUBLIC_URL is not set.</strong> Add it to your
          <code>.env</code> (e.g. <code>PUBLIC_URL=https://stream.example.com</code>),
          then restart the web container: <code>docker compose restart web</code>.
        </div>
      )}

      <div className="actions" style={{ marginTop: "1rem" }}>
        <button className="btn-primary" disabled={!ok} onClick={onNext}>
          Continue
        </button>
      </div>
    </section>
  );
}

// ---- Step 2: Twitch developer app --------------------------------

function DevAppStep({
  redirectUri, reqs, setError, refresh, onNext,
}: {
  redirectUri: string;
  reqs: Requirements;
  setError: (s: string | null) => void;
  refresh: () => Promise<void>;
  onNext: () => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/setup/oauth-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setClientSecret(""); // don't keep the secret in browser memory
      await refresh();
      onNext();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Twitch developer application</h2>
        {reqs.hasClientId && reqs.hasClientSecret && (
          <span className="tag ok">configured</span>
        )}
      </div>

      <p>
        CacheStream needs its own Twitch developer application so
        users can log in with Twitch OAuth. This is a one-time setup
        at <a href="https://dev.twitch.tv/console/apps/create" target="_blank" rel="noreferrer">
          dev.twitch.tv/console/apps/create
        </a>.
      </p>

      <ol className="setup-list">
        <li>Open the link above and click <strong>Register Your Application</strong>.</li>
        <li><strong>Name:</strong> anything (e.g. "CacheStream").</li>
        <li>
          <strong>OAuth Redirect URL:</strong> paste this exact value:
          <CopyBox value={redirectUri} />
        </li>
        <li><strong>Category:</strong> Application Integration.</li>
        <li><strong>Client Type:</strong> Confidential.</li>
        <li>Click <strong>Create</strong>.</li>
        <li>Copy the <strong>Client ID</strong> into the box below.</li>
        <li>Click <strong>New Secret</strong>, then paste it below too.</li>
      </ol>

      <div className="row gap" style={{ marginTop: "1rem", alignItems: "center" }}>
        <div className="label">Client ID</div>
        <input
          className="input grow mono"
          value={clientId}
          onChange={(e) => setClientId(e.target.value.trim())}
          placeholder={reqs.hasClientId ? "(stored — leave blank to keep)" : "abc123…"}
          autoComplete="off"
        />
      </div>

      <div className="row gap" style={{ marginTop: ".75rem", alignItems: "center" }}>
        <div className="label">Client Secret</div>
        <input
          className="input grow mono"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value.trim())}
          placeholder={reqs.hasClientSecret ? "(stored — leave blank to keep)" : "xyz789…"}
          autoComplete="off"
        />
      </div>

      <div className="actions" style={{ marginTop: "1rem" }}>
        <button
          className="btn-primary"
          disabled={
            busy ||
            // Allow continue if both already stored AND user hasn't typed anything
            (!clientId && !clientSecret && reqs.hasClientId && reqs.hasClientSecret)
              ? false
              : (!clientId || !clientSecret)
          }
          onClick={
            !clientId && !clientSecret && reqs.hasClientId && reqs.hasClientSecret
              ? onNext
              : save
          }
        >
          {busy ? "Saving…" : ((reqs.hasClientId && reqs.hasClientSecret && !clientId && !clientSecret) ? "Continue" : "Save & continue")}
        </button>
      </div>

      <style jsx>{`
        .setup-list {
          margin: 1rem 0;
          padding-left: 1.4rem;
          line-height: 1.65;
          color: var(--text);
        }
        .setup-list li { margin-bottom: 0.35rem; }
        .label {
          min-width: 130px;
          color: var(--text-dim);
          text-transform: uppercase;
          font-size: 0.7rem;
          letter-spacing: 0.22em;
        }
      `}</style>
    </section>
  );
}

// ---- Step 3: Login & finish --------------------------------------

function LoginStep({
  redirectUri, reqs,
}: { redirectUri: string; reqs: Requirements }) {
  const canStart = reqs.hasClientId && reqs.hasClientSecret;
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => { setIsDesktop(/electron/i.test(navigator.userAgent)); }, []);
  return (
    <section className="card">
      <div className="card-head"><h2>Log in with Twitch</h2></div>
      <p>
        The final step. Click below to log in as the streamer.
        First login claims permanent ownership of this CacheStream
        install — make sure it's the right account before clicking.
      </p>

      <p className="hint" style={{ marginTop: "1rem" }}>
        CacheStream will request permission to read your stream key,
        manage broadcast metadata, read chat + write chat, moderate,
        and subscribe to alerts (follows / subs / cheers / raids).
        Approve to continue.
      </p>

      <p className="hint">
        Redirect URL it's expecting: <code>{redirectUri}</code>
      </p>

      <div className="actions" style={{ marginTop: "1rem", flexWrap: "wrap", gap: ".5rem" }}>
        <a
          className="btn-primary"
          href={canStart ? "/api/auth/twitch/login?from=setup" : "#"}
          aria-disabled={!canStart}
          style={canStart ? {} : { opacity: 0.5, pointerEvents: "none" }}
        >
          Log in with Twitch{isDesktop ? " (popup window)" : ""}
        </a>
        {isDesktop && (
          <a
            className="btn-ghost"
            href={canStart ? "/api/auth/twitch/login?from=setup&desktop=external" : "#"}
            aria-disabled={!canStart}
            style={canStart ? {} : { opacity: 0.5, pointerEvents: "none" }}
          >
            Open in your browser instead
          </a>
        )}
      </div>
    </section>
  );
}

// ---- Bits -------------------------------------------------------

function Metric({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: "ok" | "err" }) {
  return (
    <div className={`metric tone-${tone || "default"}`}>
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copybox">
      <code className="mono">{value}</code>
      <button
        type="button"
        className="btn-ghost sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {}
        }}
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
      <style jsx>{`
        .copybox {
          display: flex; align-items: center; gap: 8px;
          margin-top: 6px;
          padding: 8px 12px;
          background: rgba(0,240,255,0.06);
          border: 1px solid rgba(0,240,255,0.25);
          border-radius: 4px;
        }
        .copybox code { flex: 1; word-break: break-all; font-size: 0.85rem; }
      `}</style>
    </div>
  );
}
