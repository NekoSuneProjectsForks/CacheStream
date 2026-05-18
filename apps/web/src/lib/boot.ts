/**
 * One-shot server boot.
 *
 * We can't reliably use Next 14's `instrumentation.ts` hook because:
 *   1. It's opt-in (experimental.instrumentationHook).
 *   2. Even with the flag, the instrumentation bundle is built for
 *      the Edge runtime by default, so `node:fs` / better-sqlite3 /
 *      ws imports crash webpack with "Unhandled scheme" / "Can't
 *      resolve fs".
 *   3. With standalone output, the file is sometimes dropped from
 *      the bundle entirely.
 *
 * Instead we import this module from `api-helpers.ts` — every
 * `/api/*` route imports `ownerRoute` from there, so the FIRST
 * API request the panel makes (on page load) will pull this in
 * and trigger `bootOnce()` exactly once via the module-level
 * guard. By the time the user clicks anything, chat is connecting,
 * games have subscribed to the bus, and scene presets are seeded.
 */

import { getStore } from "./store";
import { startChat } from "./twitch/chat";
import { startEventSub } from "./twitch/eventsub";
import { pet } from "./games/pet";
import { datacenter } from "./games/datacenter";
import { pushIngestToStreamer } from "./twitchIngest";
import { musicEngine } from "./music";

let booted = false;
let servicesStarted = false;

export function bootOnce(): void {
  if (booted) return;
  booted = true;
  console.log("[boot] bootOnce() running — initialising games, music, chat, eventsub");

  // Boot game engines unconditionally — they subscribe to the chat
  // bus during init(), so they must be alive BEFORE chat connects.
  try { pet(); } catch (err) { console.warn("[boot] pet init:", err); }
  try { datacenter(); } catch (err) { console.warn("[boot] datacenter init:", err); }

  // CRITICAL: the music engine's constructor spawns the always-on
  // "silence filler" FFmpeg that writes silent PCM into the
  // silence FIFO. The streamer's main FFmpeg blocks on FIFO open
  // until something is writing to it — without the filler, the
  // streamer hangs after parsing its inputs and never reaches
  // the RTMP handshake. Calling musicEngine() here forces the
  // singleton to construct + start the filler at server boot,
  // not lazily on the first /api/music/* request.
  try { musicEngine(); } catch (err) { console.warn("[boot] music engine init:", err); }

  // Kick services. If tokens aren't there yet (fresh deploy,
  // pre-wizard), the helper turns into a no-op + the OAuth
  // callback will retry once tokens land. See `startServicesIfReady`.
  startServicesIfReady();

  // Seed scene presets for built-in scenes on first boot. Runs
  // regardless of tokens so a fresh install has presets to pick
  // from before the operator logs in.
  const store = getStore();
  try {
    const existing = new Set(store.listScenes().map((s) => s.url));
    const builtins: Array<{ name: string; url: string }> = [
      { name: "Hello World",   url: "http://web:7788/scene" },
      { name: "Starting Soon", url: "http://web:7788/scene/starting-soon" },
      { name: "BRB",           url: "http://web:7788/scene/brb" },
      { name: "Ending",        url: "http://web:7788/scene/ending" },
      { name: "Offline",       url: "http://web:7788/scene/offline" },
      { name: "Music / Radio", url: "http://web:7788/scene/music" },
      { name: "AI Pet",        url: "http://web:7788/scene/pet" },
      { name: "Datacenter",    url: "http://web:7788/scene/datacenter" },
      { name: "RTMP Ingest",   url: "http://web:7788/scene/ingest" },
    ];
    let added = 0;
    for (const b of builtins) {
      if (!existing.has(b.url)) { store.addScene(b.name, b.url); added++; }
    }
    if (added > 0) console.log(`[boot] seeded ${added} built-in scene presets`);
  } catch (err) {
    console.warn("[boot] preset seed failed:", err);
  }
}

/**
 * Try to start chat + eventsub. Idempotent — safe to call from
 * both `bootOnce()` (at first API hit) and the OAuth callback
 * (after a fresh login). The first call where tokens are present
 * actually starts the services; subsequent calls are no-ops
 * because the underlying clients have their own "already
 * connecting/connected" guards.
 *
 * Why this exists as a separate function from bootOnce:
 *   bootOnce uses a one-shot `booted` flag so it never re-runs
 *   the games + music + scene-seed work. But chat/eventsub need
 *   to be (re)startable after a fresh login, since on a clean
 *   install bootOnce runs BEFORE the user logs in (no tokens →
 *   skipped). The OAuth callback then calls this directly to
 *   bring them up.
 */
export function startServicesIfReady(): void {
  if (servicesStarted) return;
  const tokens = getStore().getTokens();
  if (!tokens) {
    console.log("[boot] no broadcaster tokens yet — chat/eventsub deferred until login");
    return;
  }
  servicesStarted = true;
  console.log("[boot] tokens present — starting chat + eventsub");

  Promise.allSettled([startChat(), startEventSub()]).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") console.warn("[boot] worker start error:", r.reason);
    }
  });

  setTimeout(() => {
    pushIngestToStreamer().catch((err) =>
      console.warn("[boot] ingest push failed:", err)
    );
  }, 3_000);
}
