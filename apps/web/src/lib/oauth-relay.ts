/**
 * OAuth relay (broker) client — server side.
 *
 * Two login modes (config + `oauth_relay_mode` setting):
 *   - "public" — broker the login through the hosted relay
 *     (config.oauthRelay.url, default https://nekostreamappoauth2.nekosunevr.co.uk).
 *     No per-user client id/secret needed; the relay holds them.
 *   - "local"  — direct OAuth with the user's OWN client id + secret
 *     (the existing per-provider flow). This module isn't used in that mode.
 *
 * The relay does the whole handshake (incl. PKCE) and hands us tokens via a
 * single-use `pickup` redeemed server-to-server, so no secret ever lives in
 * this app. See the `oauth-relay` branch for the server.
 */

import { config } from "./config";
import { getSetting } from "./settings";

export type RelayMode = "public" | "local";

/** Current login method. Defaults to public. */
export function relayMode(): RelayMode {
  return getSetting("oauth_relay_mode") === "local" ? "local" : "public";
}

/** Base URL of the relay (public hosted instance). */
export function relayBaseUrl(): string {
  return config.oauthRelay.url;
}

/** Where the relay sends the browser back to (this app's loopback/own origin). */
export function relayRedirectUri(provider: string): string {
  return `${config.web.publicUrl}/api/auth/relay/${provider}/callback`;
}

/** Browser URL that starts a relay-brokered login. */
export function buildRelayLoginUrl(provider: string, state: string, scope?: string): string {
  const u = new URL(`${relayBaseUrl()}/oauth/${encodeURIComponent(provider)}/start`);
  u.searchParams.set("redirect_uri", relayRedirectUri(provider));
  u.searchParams.set("state", state);
  if (scope) u.searchParams.set("scope", scope);
  return u.toString();
}

export interface RelayTokens {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_in: number | null;
  scope: string | null;
  obtained_at: number;
}

async function relayPost(provider: string, action: string, body: unknown): Promise<RelayTokens> {
  const r = await fetch(`${relayBaseUrl()}/oauth/${encodeURIComponent(provider)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error_description || j?.error || `relay ${action} ${r.status}`);
  return j.tokens as RelayTokens;
}

/** Redeem the one-time pickup for tokens (single-use). */
export function exchangePickup(provider: string, pickup: string): Promise<RelayTokens> {
  return relayPost(provider, "exchange", { pickup });
}

/** Refresh tokens via the relay (it holds the secret). */
export function refreshViaRelay(provider: string, refreshToken: string): Promise<RelayTokens> {
  return relayPost(provider, "refresh", { refresh_token: refreshToken });
}
