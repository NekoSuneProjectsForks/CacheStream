/**
 * Twitch chat — Helix transport (v1.8.0+).
 *
 * Receiving messages: handled by `lib/twitch/eventsub.ts` via the
 * `channel.chat.message` subscription. That client converts each
 * EventSub payload into the same `{ type, login, name, message,
 * isMod, isSub, id }` shape the games / commands / automod
 * already consume on the `chat` bus topic.
 *
 * Sending messages: this module. Wraps Helix `POST /chat/messages`.
 * Async + rate-limited by Twitch (100 msgs / 30s per bot acting
 * for a broadcaster).
 *
 * Why we migrated off IRC over WebSocket:
 *   1. Twitch is steering everyone toward Helix for chat. The IRC
 *      bridge still exists but is no longer the recommended path.
 *   2. Removes the hand-rolled IRC parser + a ~250-line WS client.
 *   3. Reuses the EventSub WS we already keep alive for follows /
 *      subs / cheers / raids — one less long-lived TCP connection.
 *   4. Easier to add multi-channel / external-bot support later
 *      (per-broadcaster send tokens, etc.).
 */

import { config } from "../config";
import { getStore } from "../store";
import { getAccessToken, isRefreshTokenDead } from "./tokens";
import { eventSubStatus } from "./eventsub";

const SEND_URL = "https://api.twitch.tv/helix/chat/messages";

interface Status {
  state: "idle" | "connecting" | "connected" | "closed";
  channel: string | null;
  connectedAt: number | null;
  lastError: string | null;
}

// Module-level state. Tiny — `state` mirrors EventSub since
// EventSub is the actual transport now; `lastError` records send
// failures so the panel can surface them.
let lastError: string | null = null;
let connectedAt: number | null = null;
let lastEventSubConnected = false;

function status(): Status {
  // Receive is implicit via EventSub. We expose "connected" when
  // the EventSub session is up AND we have a broadcaster login to
  // report — i.e. all the inputs to actually do anything are in
  // place. This keeps the existing /api/chat/status response shape.
  const es = eventSubStatus();
  const owner = getStore().getOwner();
  const channel = owner?.twitchLogin?.toLowerCase() || null;

  if (isRefreshTokenDead()) {
    return { state: "closed", channel, connectedAt: null,
             lastError: "refresh token rejected by Twitch — re-login required" };
  }

  if (!channel) {
    return { state: "idle", channel: null, connectedAt: null,
             lastError: "no owner set" };
  }

  if (es.state === "connected") {
    if (!lastEventSubConnected) { connectedAt = Date.now(); lastEventSubConnected = true; }
    return { state: "connected", channel, connectedAt, lastError };
  }

  lastEventSubConnected = false;
  if (es.state === "connecting") {
    return { state: "connecting", channel, connectedAt: null, lastError };
  }
  return { state: es.state === "idle" ? "idle" : "closed",
           channel, connectedAt: null,
           lastError: lastError || es.lastError };
}

/**
 * Send a chat message via Helix. Throws on auth / API error so
 * the command-engine + ad-hoc /api/chat/send route can surface
 * the failure to the operator.
 */
async function sendImpl(text: string): Promise<void> {
  const tokens = getStore().getTokens();
  if (!tokens) throw new Error("no broadcaster tokens");

  let token: string;
  try { token = await getAccessToken(); }
  catch (err: any) {
    lastError = err?.message || String(err);
    throw err;
  }

  // Twitch's chat-send hard limit is 500 chars. We truncate at
  // 480 + ellipsis to leave room for the unicode … (3 bytes UTF-8)
  // and keep symmetry with the old IRC client's behaviour.
  const message = text.length > 480 ? text.slice(0, 480) + "…" : text;

  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      "Client-Id": config.oauth.clientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: tokens.twitchUserId,
      sender_id:      tokens.twitchUserId,
      message,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    lastError = `helix chat send ${res.status}: ${body}`;
    throw new Error(lastError);
  }
  lastError = null;
}

// ---- Stable exports (unchanged signatures so callers don't need to know) --

/**
 * No-op for backwards compat. Receive is handled by EventSub's
 * `start()`. Kept so existing callers (boot, /api/chat/status,
 * OAuth callback) don't need to learn a new API.
 */
export async function startChat(): Promise<void> {
  // Intentionally empty. EventSub is what we need to be running;
  // boot.ts calls startEventSub() already.
}

/** No-op for backwards compat — stop the EventSub client to stop chat. */
export function stopChat(): void {
  // Intentionally empty for the same reason.
}

export function chatStatus(): Status { return status(); }

/**
 * Send via Helix. The signature stays synchronous-throwing so
 * existing call sites (which use it inside fire-and-forget
 * Promise.resolve wrappers) don't need to change — we kick off
 * the async work and bubble errors through to console as the
 * old client did on a closed WebSocket.
 */
export function sendChat(text: string): void {
  sendImpl(text).catch((err) => {
    console.warn("[chat] send failed:", err?.message || err);
  });
}

export async function reconnectChatIfRunning(): Promise<void> {
  // Receive is via EventSub; its own reconnectEventSubIfRunning
  // handles token refresh. Nothing to do here.
}
