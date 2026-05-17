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
 *   {user}   → chatter display name
 *   {arg1..} → words after the trigger
 *   {channel}→ broadcaster login
 */

import { getStore } from "./store";

interface ChatMsgEvent {
  type: string;
  login: string | null;
  name: string | null;
  message: string;
  isMod: boolean;
  isSub: boolean;
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
  const reply = cmd.response
    .replace(/\{user\}/g,    event.name || event.login || "viewer")
    .replace(/\{channel\}/g, owner?.twitchLogin || "")
    .replace(/\{arg(\d+)\}/g, (_, n) => args[Number(n) - 1] ?? "")
    .replace(/\{args\}/g,    args.join(" "));

  try {
    send(reply);
    store.markCommandFired(cmd.id, now);
    return true;
  } catch (err) {
    console.warn("[commands] send failed:", err);
    return false;
  }
}
