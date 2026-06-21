import type { OwnerRecord } from "@/lib/store";
import { LoginButtons } from "./LoginButtons";

interface Props {
  owner: OwnerRecord | null;
  loginUrl: string;
}

/**
 * Pre-authentication screen. Shows whether ownership is still
 * vacant (first-login-wins) or already claimed by someone, so
 * a passer-by knows what will happen when they click Login.
 */
export function LoginGate({ owner, loginUrl }: Props) {
  return (
    <main className="admin-shell auth-gate">
      <div className="auth-card">
        <h1 className="brand">CacheStream</h1>
        <p className="tagline">Headless Twitch streamer · control panel</p>

        {owner ? (
          <div className="owner-block claimed">
            <span className="dot warn" />
            <div>
              <div className="label">Claimed by</div>
              <div className="value">{owner.displayName}</div>
              <div className="hint">
                Owner — or anyone invited via a staff link — can sign in here.
              </div>
            </div>
          </div>
        ) : (
          <div className="owner-block vacant">
            <span className="dot ok" />
            <div>
              <div className="label">Ownership vacant</div>
              <div className="value">First Twitch login claims this instance</div>
              <div className="hint warn">Log in now to prevent someone else from taking it.</div>
            </div>
          </div>
        )}

        <LoginButtons loginUrl={loginUrl} />

        <a href="/" className="btn-ghost-link">← back to public page</a>
      </div>
    </main>
  );
}
