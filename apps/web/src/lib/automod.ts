/**
 * AutoMod engine.
 *
 * Walks the stored automod_rules table for each incoming chat
 * message. First match wins. Action is one of:
 *   delete   → moderation API DELETE /chat
 *   timeout  → moderation API POST /bans with duration
 *   ban      → moderation API POST /bans without duration
 *
 * The moderation API requires a moderator_user_id; we use the
 * broadcaster's own id (the broadcaster is implicitly a moderator
 * of their own channel).
 */

import { getStore } from "./store";
import { banUser, deleteChatMessage, getUserByLogin } from "./twitch/helix";

interface ChatMsgEvent {
  id?: string;
  login: string | null;
  name: string | null;
  message: string;
}

function matches(rule: ReturnType<typeof getStore>["listAutoModRules"] extends () => infer T ? T extends Array<infer R> ? R : never : never, text: string): boolean {
  if (!rule.enabled) return false;
  const t = text.toLowerCase();
  switch (rule.matchType) {
    case "contains":   return t.includes(rule.pattern.toLowerCase());
    case "startswith": return t.startsWith(rule.pattern.toLowerCase());
    case "regex":
      try { return new RegExp(rule.pattern, "i").test(text); }
      catch { return false; }
  }
}

export async function evaluateAutoMod(event: ChatMsgEvent): Promise<void> {
  if (!event.message || !event.login || !event.id) return;
  const store = getStore();
  const tokens = store.getTokens();
  if (!tokens) return;

  const rules = store.listAutoModRules();
  const rule = rules.find((r) => matches(r, event.message));
  if (!rule) return;

  const broadcasterId = tokens.twitchUserId;
  try {
    if (rule.action === "delete") {
      await deleteChatMessage(broadcasterId, broadcasterId, event.id);
      return;
    }

    // For timeout/ban we need the chatter's user id.
    const target = await getUserByLogin(event.login);
    if (!target) return;
    if (rule.action === "timeout") {
      await banUser(broadcasterId, broadcasterId, target.id, rule.reason, rule.durationS || 60);
    } else if (rule.action === "ban") {
      await banUser(broadcasterId, broadcasterId, target.id, rule.reason, null);
    }
  } catch (err) {
    console.warn("[automod] action failed:", err);
  }
}
