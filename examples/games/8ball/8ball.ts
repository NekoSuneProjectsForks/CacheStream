/**
 * Example game · !8ball
 *
 * The smallest possible chat-driven game template for
 * CacheStream. Listens for "!8ball <question>" and replies with
 * a random answer from a fixed list.
 *
 * Copy this file to: apps/web/src/lib/games/8ball.ts
 *
 * Wire it into apps/web/src/instrumentation.ts:
 *
 *   const { eightball } = await import("./lib/games/8ball");
 *   try { eightball(); } catch (err) { console.warn("[boot] 8ball init:", err); }
 *
 * That's the whole integration. No DB tables, no API routes, no
 * scene route, no SSE — just chat in, chat out.
 */

import { subscribe } from "../bus";
import { sendChat } from "../twitch/chat";

// Classic Magic 8-Ball answers. Replace / extend with your own.
const ANSWERS = [
  "It is certain.",
  "Without a doubt.",
  "Yes, definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

// Per-user cooldown so one chatter can't spam !8ball forever.
const COOLDOWN_MS = 3_000;

interface ChatEvent {
  type?: string;
  login?: string | null;
  name?: string | null;
  message?: string;
}

/**
 * Boot the game. Idempotent — safe to call multiple times,
 * subscribers are tracked by an in-module flag.
 */
let booted = false;
const lastFiredByUser = new Map<string, number>();

export function eightball(): void {
  if (booted) return;
  booted = true;

  subscribe("chat", (raw) => {
    const msg = raw as ChatEvent;
    if (msg?.type !== "msg" || !msg.message || !msg.login) return;

    // Match `!8ball <anything>` (case-insensitive). The space
    // requirement is intentional — bare "!8ball" without a
    // question shouldn't fire.
    const m = msg.message.trim().match(/^!8ball\b\s*(.*)$/i);
    if (!m) return;

    // Cooldown — per-user, so one spammy chatter doesn't lock
    // out the rest of the channel.
    const now = Date.now();
    const last = lastFiredByUser.get(msg.login) || 0;
    if (now - last < COOLDOWN_MS) return;
    lastFiredByUser.set(msg.login, now);

    const answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    const displayName = msg.name || msg.login;

    try {
      sendChat(`@${displayName} 🎱 ${answer}`);
    } catch (err) {
      // sendChat throws if the IRC client isn't connected yet —
      // fine, we just skip this round.
      console.warn("[8ball] sendChat failed:", err);
    }
  });

  console.log("[8ball] ready — chatters can ask !8ball <question>");
}
