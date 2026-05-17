/**
 * Twitch OAuth2 helpers.
 *
 *   buildAuthorizeUrl(state)  → URL to send the user to
 *   exchangeCode(code)        → access_token, refresh_token, ...
 *   refreshToken(refreshToken) → new tokens
 *   fetchHelixUser(token)     → Twitch user record (id/login/email/...)
 *
 * Pure functions — the route handlers compose them with the
 * session store and cookies layer.
 */

import { URL, URLSearchParams } from "node:url";
import { config } from "./config";

const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const USERS_URL = "https://api.twitch.tv/helix/users";

export interface TwitchUser {
  id: string;
  login: string;
  display_name?: string;
  email?: string;
  profile_image_url?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string[];
}

export function buildAuthorizeUrl(state: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.search = new URLSearchParams({
    client_id: config.oauth.clientId,
    redirect_uri: config.oauth.redirectUri,
    response_type: "code",
    scope: config.oauth.scopes.join(" "),
    state,
    // Always show consent so re-login works even if already
    // authenticated upstream.
    force_verify: "true",
  }).toString();
  return u.toString();
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: config.oauth.clientId,
    client_secret: config.oauth.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.oauth.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token exchange failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<TokenResponse>;
}

/** Trade an existing refresh token for a fresh access + refresh pair. */
export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: config.oauth.clientId,
    client_secret: config.oauth.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token refresh failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<TokenResponse>;
}

export async function fetchHelixUser(accessToken: string): Promise<TwitchUser> {
  const res = await fetch(USERS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": config.oauth.clientId,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`helix /users failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { data?: TwitchUser[] };
  const user = json.data?.[0];
  if (!user) throw new Error("helix /users returned no records");
  return user;
}

/**
 * Compare currently-stored token scopes against config.oauth.scopes.
 * Returns the list of scopes that are required by this build of
 * CacheStream but missing from the saved token. If non-empty, the
 * panel should prompt the user to re-authenticate.
 */
export function missingScopes(grantedScopes: string[]): string[] {
  const have = new Set(grantedScopes.map((s) => s.toLowerCase()));
  return config.oauth.scopes.filter((s) => !have.has(s.toLowerCase()));
}
