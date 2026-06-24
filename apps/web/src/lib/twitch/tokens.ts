/**
 * Broadcaster token broker.
 *
 *   getAccessToken()     → always returns a valid access token,
 *                          refreshing transparently if the
 *                          stored one is near expiry.
 *   onTokensRefreshed()  → hook called after successful refresh
 *                          (or after a fresh login) so chat +
 *                          EventSub can reconnect with new auth.
 *
 * Concurrent calls coalesce into one in-flight refresh so we
 * don't hammer Twitch with parallel POSTs during a token expiry.
 */

import { getStore } from "../store";
import { refreshTokens } from "../oauth";
import { relayMode, refreshViaRelay } from "../oauth-relay";
import { reconnectChatIfRunning } from "./chat";
import { reconnectEventSubIfRunning } from "./eventsub";

const REFRESH_SAFETY_MS = 60 * 1000; // refresh 60s before expiry
let inflight: Promise<string> | null = null;

/**
 * Sticky flag for "the stored refresh token is permanently dead."
 * Set when Twitch returns 400/401 on a refresh call. While set,
 * every `getAccessToken()` rejects immediately without hitting
 * Twitch — otherwise EventSub + chat would retry-spam thousands
 * of refresh attempts per minute against the same dead token.
 * Cleared on a successful fresh login (see oauth callback).
 */
let refreshTokenDead = false;

export function markRefreshTokenDead(): void { refreshTokenDead = true; }
export function markRefreshTokenAlive(): void { refreshTokenDead = false; }
export function isRefreshTokenDead(): boolean { return refreshTokenDead; }

export async function getAccessToken(): Promise<string> {
  if (refreshTokenDead) {
    throw new Error("refresh token rejected by Twitch — re-login required");
  }
  const tokens = getStore().getTokens();
  if (!tokens) throw new Error("no broadcaster tokens stored (log in first)");
  if (tokens.expiresAt - Date.now() > REFRESH_SAFETY_MS) return tokens.accessToken;
  return refresh();
}

async function refresh(): Promise<string> {
  if (inflight) return inflight;
  const store = getStore();
  const tokens = store.getTokens();
  if (!tokens?.refreshToken) throw new Error("no refresh token; re-login required");

  inflight = (async () => {
    try {
      // PUBLIC mode: refresh through the relay (it holds the secret). LOCAL
      // mode: refresh directly with the owner's own client id + secret.
      const next = relayMode() === "public"
        ? await (async () => {
            const t = await refreshViaRelay("twitch", tokens.refreshToken!);
            return {
              access_token: t.access_token,
              refresh_token: t.refresh_token,
              expires_in: t.expires_in ?? 3600,
              scope: (t.scope || "").split(" ").filter(Boolean),
            };
          })()
        : await refreshTokens(tokens.refreshToken!);
      store.saveTokens({
        accessToken: next.access_token,
        refreshToken: next.refresh_token || tokens.refreshToken,
        expiresAt: Date.now() + (next.expires_in - 60) * 1000,
        scopes: next.scope || tokens.scopes,
        twitchUserId: tokens.twitchUserId,
        updatedAt: Date.now(),
      });
      await onTokensRefreshed();
      return next.access_token;
    } catch (err: any) {
      // 400/401 from Twitch on a refresh = token is permanently dead
      // (revoked, expired beyond grace, or secret rotated). Sticky-flag
      // it so the retry loops back off and the operator gets a clear
      // "re-login" signal in the panel instead of log spam.
      const msg = String(err?.message || err);
      if (/\b40[01]\b/.test(msg)) {
        refreshTokenDead = true;
        console.warn("[tokens] refresh token rejected by Twitch — re-login required");
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Called after a fresh login or a successful refresh so the
 * long-lived clients (chat IRC, EventSub WS) pick up the new
 * token without waiting for their next reconnect cycle.
 */
export async function onTokensRefreshed(): Promise<void> {
  await Promise.allSettled([
    reconnectChatIfRunning(),
    reconnectEventSubIfRunning(),
  ]);
}
