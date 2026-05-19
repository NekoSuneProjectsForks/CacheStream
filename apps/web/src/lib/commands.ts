/**
 * Custom chat command engine.
 *
 * Pure logic — given a chat message and a send-callback, decides
 * whether to fire a stored CustomCommand reply.
 *
 * Rules:
 *   - Trigger matches if the message starts with `!<trigger>` (case-insensitive)
 *     OR if the message exactly equals `<trigger>`.
 *   - Cooldowns are per-command (not per-user) and stored in the DB
 *     so they survive restarts.
 *   - modOnly / subOnly checked against the chatter's IRC tags.
 *
 * Response templating supports:
 *   {user}        → chatter display name
 *   {arg1}…{argN} → individual words after the trigger
 *   {args}        → all remaining words joined
 *   {channel}     → broadcaster login
 *
 * Live-stat variables (v1.12.0). All resolve to a sensible
 * fallback when the stream isn't live or the Helix call fails,
 * so chat never sees a literal "{viewers}" leak through.
 *
 *   {uptime}      → "1h 23m" since the stream started, "offline" if not live
 *   {viewers}     → current viewer count, "0" if offline
 *   {game}        → current category title, "—" if unset
 *   {title}       → broadcast title, "—" if unset
 *   {followers}   → total follower count
 *
 * The live-stat substitutions are async because they hit Helix.
 * A 5s snapshot cache keeps a busy chat from firing one HTTP
 * request per command invocation.
 */

import { getStore } from "./store";
import { getStreamByUserId } from "./twitch/helix";
import { config } from "./config";
import { getAccessToken } from "./twitch/tokens";

interface ChatMsgEvent {
  type: string;
  login: string | null;
  name: string | null;
  message: string;
  isMod: boolean;
  isSub: boolean;
}

interface LiveSnapshot {
  live: boolean;
  startedAt: string | null;
  viewerCount: number;
  game: string;
  title: string;
  followers: number;
}

// 5s cache on the live snapshot. A custom command fires at most
// once per `cooldownS` (default 30s) so even with one command per
// chatter on a busy 100-msg/min channel we'd hit Helix every 5s
// at most. Way under the 800-req/min global Helix limit.
const SNAPSHOT_TTL_MS = 5_000;
let snapshotCache: { at: number; snap: LiveSnapshot } | null = null;

async function getLiveSnapshot(): Promise<LiveSnapshot> {
  if (snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return snapshotCache.snap;
  }

  const empty: LiveSnapshot = {
    live: false, startedAt: null, viewerCount: 0,
    game: "—", title: "—", followers: 0,
  };

  const tokens = getStore().getTokens();
  if (!tokens) {
    snapshotCache = { at: Date.now(), snap: empty };
    return empty;
  }

  try {
    const stream = await getStreamByUserId(tokens.twitchUserId);
    // Followers count comes from a separate Helix call — keep it
    // optional + best-effort so a missing scope or transient
    // failure doesn't break the {viewers}/{game}/{uptime}
    // substitutions.
    let followers = 0;
    try { followers = await fetchFollowerCount(tokens.twitchUserId); }
    catch { /* ignore — {followers} substitutes to 0 */ }

    const snap: LiveSnapshot = stream ? {
      live: stream.type === "live",
      startedAt: stream.started_at,
      viewerCount: stream.viewer_count || 0,
      game: stream.game_name || "—",
      title: stream.title || "—",
      followers,
    } : { ...empty, followers };

    snapshotCache = { at: Date.now(), snap };
    return snap;
  } catch {
    snapshotCache = { at: Date.now(), snap: empty };
    return empty;
  }
}

async function fetchFollowerCount(broadcasterId: string): Promise<number> {
  // Inlined rather than added to helix.ts since this is the only
  // caller. Uses GET /channels/followers which returns a `total`
  // field at the top level — much cheaper than paginating users.
  // Needs moderator:read:followers scope (already in OAUTH_SCOPES).
  const token = await getAccessToken();
  const url = new URL("https://api.twitch.tv/helix/channels/followers");
  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("first", "1");
  const r = await fetch(url, {
    headers: {
      "Client-Id": config.oauth.clientId,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  if (!r.ok) return 0;
  const body = await r.json().catch(() => ({}));
  return Number(body?.total) || 0;
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return "offline";
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "offline";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Substitute live-stat variables in a response template.
 * Fetches a snapshot (cached 5s) only when the template
 * actually contains one of the dynamic tokens — avoids a
 * Helix hit for vanilla {user}/{args}-only commands.
 */
async function resolveLiveVariables(template: string): Promise<string> {
  const dynamic = /\{(uptime|viewers|game|title|followers)\}/.test(template);
  if (!dynamic) return template;
  const snap = await getLiveSnapshot();
  return template
    .replace(/\{uptime\}/g,    formatUptime(snap.startedAt))
    .replace(/\{viewers\}/g,   String(snap.viewerCount))
    .replace(/\{game\}/g,      snap.game)
    .replace(/\{title\}/g,     snap.title)
    .replace(/\{followers\}/g, String(snap.followers));
}

export async function runCommandIfMatch(
  event: ChatMsgEvent,
  send: (text: string) => void
): Promise<boolean> {
  if (event.type !== "msg" || !event.message) return false;
  const trimmed = event.message.trim();
  if (!trimmed) return false;

  // Strip leading ! if present.
  const head = (trimmed.startsWith("!") ? trimmed.slice(1) : trimmed).split(/\s+/);
  const trigger = head[0]?.toLowerCase();
  if (!trigger) return false;

  const store = getStore();
  const cmd = store.getCommandByTrigger(trigger);
  if (!cmd || !cmd.enabled) return false;

  if (cmd.modOnly && !event.isMod) return false;
  if (cmd.subOnly && !event.isSub && !event.isMod) return false;

  const now = Date.now();
  if (now - cmd.lastFired < cmd.cooldownS * 1000) return false;

  const args = head.slice(1);
  const owner = store.getOwner();

  // Step 1: cheap synchronous substitutions.
  const synced = cmd.response
    .replace(/\{user\}/g,    event.name || event.login || "viewer")
    .replace(/\{channel\}/g, owner?.twitchLogin || "")
    .replace(/\{arg(\d+)\}/g, (_, n) => args[Number(n) - 1] ?? "")
    .replace(/\{args\}/g,    args.join(" "));

  // Step 2: async live-stat substitutions (only if the template
  // mentions them; otherwise no Helix hit).
  let reply: string;
  try { reply = await resolveLiveVariables(synced); }
  catch (err) {
    console.warn("[commands] live-var resolve failed:", err);
    reply = synced; // fall back to the partially-resolved template
  }

  try {
    send(reply);
    store.markCommandFired(cmd.id, now);
    return true;
  } catch (err) {
    console.warn("[commands] send failed:", err);
    return false;
  }
}
