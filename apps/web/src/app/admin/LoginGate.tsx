import type { OwnerRecord } from "@/lib/store";

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
              <div className="hint">Only this Twitch account can sign in.</div>
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

        <a href={loginUrl} className="btn-primary login-btn">
          <TwitchGlyph />
          <span>Login with Twitch</span>
        </a>

        <a href="/" className="btn-ghost-link">← back to public page</a>
      </div>
    </main>
  );
}

function TwitchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M4.265 0L1.5 5.526v17.105h5.79V26h3.156l3.158-3.369h4.737L24 16.95V0H4.265zm17.473 15.79l-3.158 3.368h-5.789l-3.157 3.368v-3.368H4.79V2.105h16.948V15.79zM18.581 6.317h-2.105v6.317h2.105V6.317zm-5.262 0H11.21v6.317h2.105V6.317z"
      />
    </svg>
  );
}
