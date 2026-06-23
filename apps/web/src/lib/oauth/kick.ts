/**
 * Kick OAuth2 (Authorization Code + PKCE) helpers.
 *
 * Endpoints + flow verified against docs.kick.com and the StreamBOT
 * implementation. App credentials are wizard/kv-managed
 * (kick_client_id / kick_client_secret); the redirect is derived from
 * PUBLIC_URL. See docs/design/multi-platform-accounts.md (Appendix A).
 */

import crypto from "node:crypto";
import { config } from "../config";
import { getSetting } from "../settings";

const AUTHORIZE_URL = "https://id.kick.com/oauth/authorize";
const TOKEN_URL = "https://id.kick.com/oauth/token";
const API_BASE = "https://api.kick.com/public/v1";

export const KICK_SCOPES = [
  "user:read",
  "channel:read",
  "channel:write",
  "streamkey:read",
  "chat:write",
  "events:subscribe",
  "moderation:ban",
];

export interface KickTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export function kickConfigured(): boolean {
  return !!getSetting("kick_client_id") && !!getSetting("kick_client_secret");
}

export function kickCreds() {
  return {
    clientId: getSetting("kick_client_id"),
    clientSecret: getSetting("kick_client_secret"),
    redirectUri: `${config.web.publicUrl}/api/auth/kick/callback`,
  };
}

/** PKCE pair: random verifier + its S256 challenge (base64url). */
export function genPkce() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildKickAuthorizeUrl(state: string, challenge: string): string {
  const { clientId, redirectUri } = kickCreds();
  const u = new URL(AUTHORIZE_URL);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: KICK_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

async function tokenRequest(body: URLSearchParams): Promise<KickTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`kick token ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json() as Promise<KickTokenResponse>;
}

export function exchangeKickCode(code: string, verifier: string): Promise<KickTokenResponse> {
  const { clientId, clientSecret, redirectUri } = kickCreds();
  return tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    code,
  }));
}

export function refreshKickToken(refreshToken: string): Promise<KickTokenResponse> {
  const { clientId, clientSecret } = kickCreds();
  return tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }));
}

/** App token (client_credentials) — used to send chat as the bot. */
export function kickAppToken(): Promise<KickTokenResponse> {
  const { clientId, clientSecret } = kickCreds();
  return tokenRequest(new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }));
}

export interface KickChannel {
  slug?: string;
  username?: string;
  name?: string;
  broadcaster_user_id?: string | number;
  id?: string | number;
  chatroom?: { id?: string | number };
  chatroom_id?: string | number;
}

/** GET /channels for the linked user — resolves chatroom id + identity. */
export async function fetchKickChannels(accessToken: string): Promise<KickChannel[]> {
  const res = await fetch(`${API_BASE}/channels`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kick /channels ${res.status}`);
  const json = (await res.json()) as { data?: KickChannel[] };
  return json.data || [];
}

export const KICK_API_BASE = API_BASE;
