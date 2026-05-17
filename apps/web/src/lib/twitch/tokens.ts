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
import { reconnectChatIfRunning } from "./chat";
import { reconnectEventSubIfRunning } from "./eventsub";

const REFRESH_SAFETY_MS = 60 * 1000; // refresh 60s before expiry
let inflight: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
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
      const next = await refreshTokens(tokens.refreshToken!);
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
