/**
 * Twitch Helix API client.
 *
 * Thin wrapper over fetch() that:
 *   - injects Client-Id + bearer token
 *   - refreshes the token on 401 and retries once
 *   - returns parsed JSON or throws { status, message }
 *
 * Only the endpoints the panel actually uses are exposed; add
 * more as features land.
 */

import { config } from "../config";
import { getStore } from "../store";
import { getAccessToken } from "./tokens";

const HELIX = "https://api.twitch.tv/helix";

async function helix<T = any>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  init?: { query?: Record<string, string | undefined>; body?: unknown }
): Promise<T> {
  const doFetch = async (token: string) => {
    const url = new URL(`${HELIX}${path}`);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v != null) url.searchParams.set(k, v);
      }
    }
    return fetch(url, {
      method,
      headers: {
        "Client-Id": config.oauth.clientId,
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  };

  let token = await getAccessToken();
  let res = await doFetch(token);

  // If the token was revoked or rotated server-side, one retry
  // after a forced refresh.
  if (res.status === 401) {
    // getAccessToken refresh check uses expiry — force it by
    // zeroing expiry then asking again.
    const store = getStore();
    const stored = store.getTokens();
    if (stored) store.saveTokens({ ...stored, expiresAt: 0 });
    token = await getAccessToken();
    res = await doFetch(token);
  }

  const text = await res.text();
  let payload: any = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }

  if (!res.ok) {
    const msg = payload?.message || `helix ${method} ${path} → ${res.status}`;
    const err = new Error(msg) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  return payload as T;
}

// ---- Channel info ----------------------------------------------

export interface ChannelInfo {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  game_id: string;
  game_name: string;
  title: string;
  broadcaster_language: string;
  tags: string[];
  content_classification_labels: string[];
  is_branded_content: boolean;
}

export async function getChannelInfo(broadcasterId: string): Promise<ChannelInfo | null> {
  const res = await helix<{ data: ChannelInfo[] }>("GET", "/channels", {
    query: { broadcaster_id: broadcasterId },
  });
  return res.data?.[0] ?? null;
}

export async function updateChannelInfo(
  broadcasterId: string,
  patch: { title?: string; game_id?: string; broadcaster_language?: string; tags?: string[] }
): Promise<void> {
  await helix("PATCH", "/channels", {
    query: { broadcaster_id: broadcasterId },
    body: patch,
  });
}

// ---- Game / category search ------------------------------------

export interface Game {
  id: string;
  name: string;
  box_art_url: string;
}

export async function searchCategories(name: string): Promise<Game[]> {
  if (!name.trim()) return [];
  const res = await helix<{ data: Game[] }>("GET", "/search/categories", {
    query: { query: name, first: "10" },
  });
  return res.data || [];
}

// ---- Stream + viewer state -------------------------------------

export interface StreamInfo {
  id: string;
  user_id: string;
  user_login: string;
  game_name: string;
  type: string; // "live" | ""
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
}

export async function getStreamByUserId(userId: string): Promise<StreamInfo | null> {
  const res = await helix<{ data: StreamInfo[] }>("GET", "/streams", {
    query: { user_id: userId },
  });
  return res.data?.[0] ?? null;
}

/**
 * Fetch the broadcaster's primary stream key from Helix.
 *
 *   GET https://api.twitch.tv/helix/streams/key?broadcaster_id=<id>
 *
 * Requires the `channel:read:stream_key` OAuth scope. Returns the
 * raw key (e.g. `live_1499808986_…`) — handle carefully and never
 * return it to the browser directly.
 *
 * Twitch rotates this key whenever the broadcaster clicks "Reset"
 * in their dashboard, so callers should re-fetch on demand rather
 * than caching indefinitely.
 */
export async function fetchStreamKey(broadcasterId: string): Promise<string | null> {
  const res = await helix<{ data: Array<{ stream_key: string }> }>("GET", "/streams/key", {
    query: { broadcaster_id: broadcasterId },
  });
  return res.data?.[0]?.stream_key || null;
}

/**
 * List the broadcaster's recent past videos (archive type =
 * regular broadcasts). Used by the Sources tab's VOD archive
 * picker.
 *
 *   GET /helix/videos?user_id=…&type=archive&first=N
 */
export interface TwitchVideo {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  description: string;
  created_at: string;
  published_at: string;
  url: string;
  thumbnail_url: string;
  viewable: "public" | "private";
  view_count: number;
  language: string;
  type: "upload" | "archive" | "highlight";
  /** Twitch returns "1h2m3s" — caller can parse if needed. */
  duration: string;
}

export async function listUserVideos(userId: string, opts?: {
  first?: number;
  type?: "archive" | "highlight" | "upload" | "all";
}): Promise<TwitchVideo[]> {
  const res = await helix<{ data: TwitchVideo[] }>("GET", "/videos", {
    query: {
      user_id: userId,
      first:   String(opts?.first ?? 20),
      type:    opts?.type ?? "archive",
    },
  });
  return res.data || [];
}

/** Parse Twitch's "1h2m3s" duration → total seconds. */
export function parseTwitchDuration(d: string): number {
  const m = d.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return (parseInt(m[1] || "0", 10) * 3600)
       + (parseInt(m[2] || "0", 10) * 60)
       + (parseInt(m[3] || "0", 10));
}

// ---- Chat moderation -------------------------------------------

/** Delete a single chat message by id. */
export async function deleteChatMessage(
  broadcasterId: string,
  moderatorId: string,
  messageId: string
): Promise<void> {
  await helix("DELETE", "/moderation/chat", {
    query: {
      broadcaster_id: broadcasterId,
      moderator_id: moderatorId,
      message_id: messageId,
    },
  });
}

/** Time out (or ban, if duration omitted) a user. */
export async function banUser(
  broadcasterId: string,
  moderatorId: string,
  targetUserId: string,
  reason: string | null,
  durationSeconds: number | null
): Promise<void> {
  await helix("POST", "/moderation/bans", {
    query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
    body: {
      data: {
        user_id: targetUserId,
        ...(durationSeconds ? { duration: durationSeconds } : {}),
        ...(reason ? { reason } : {}),
      },
    },
  });
}

/** Resolve login → user id; used by AutoMod when we only know the chatter login. */
export async function getUserByLogin(login: string): Promise<{ id: string; login: string; display_name: string } | null> {
  const res = await helix<{ data: any[] }>("GET", "/users", { query: { login } });
  return res.data?.[0] ?? null;
}
