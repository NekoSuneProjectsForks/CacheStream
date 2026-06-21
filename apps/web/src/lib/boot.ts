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

import { config } from "./config";
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
    // Seed against the streamer-reachable base (config.scene.baseUrl):
    // `http://web:7788` under Docker, `http://localhost:<port>` in the
    // desktop app. Either way the activation path re-normalises the URL
    // (toStreamerUrl), so a DB seeded under one still works under the
    // other.
    const base = config.scene.baseUrl;

    // Hosts that mean "this web app". Presets pointing at any of these
    // get migrated to the current base — so a DB seeded under Docker
    // (`web:7788`) shows clean localhost URLs in the desktop app and
    // vice-versa, instead of accumulating duplicates when the base
    // changes between runs.
    const selfHosts = new Set(["web", "localhost", "127.0.0.1", "0.0.0.0"]);
    try { selfHosts.add(new URL(config.web.publicUrl).hostname); } catch { /* ignore */ }
    const isSelf = (u: string): boolean => {
      try { return selfHosts.has(new URL(u).hostname); } catch { return false; }
    };
    const pathOf = (u: string): string => {
      try { const x = new URL(u); return x.pathname + x.search; } catch { return u; }
    };
    const rebase = (u: string): string => {
      try {
        const x = new URL(u);
        if (!selfHosts.has(x.hostname)) return u;
        const b = new URL(base);
        x.protocol = b.protocol; x.hostname = b.hostname; x.port = b.port;
        return x.toString();
      } catch { return u; }
    };

    // 1. Migrate existing self-host presets to the current base, and
    //    collapse the duplicates that creates. Foreign URLs (custom
    //    external scenes) are never rewritten or removed.
    const seenPaths = new Set<string>();
    let migrated = 0, removedDups = 0;
    for (const s of store.listScenes()) {
      if (!isSelf(s.url)) continue;             // leave external presets alone
      const rebased = rebase(s.url);
      const p = pathOf(rebased);
      if (seenPaths.has(p)) { store.removeScene(s.id); removedDups++; continue; }  // dedupe by path
      if (rebased !== s.url) { store.updateSceneUrl(s.id, rebased); migrated++; }
      seenPaths.add(p);
    }
    if (migrated > 0 || removedDups > 0) {
      console.log(`[boot] scene presets: migrated ${migrated} to current base, removed ${removedDups} duplicate(s)`);
    }

    // 2. Seed any missing built-ins, deduped by path so a base change
    //    never re-adds an existing scene.
    const builtins: Array<{ name: string; url: string }> = [
      { name: "Hello World",   url: `${base}/scene` },
      { name: "Starting Soon", url: `${base}/scene/starting-soon` },
      { name: "BRB",           url: `${base}/scene/brb` },
      { name: "Ending",        url: `${base}/scene/ending` },
      { name: "Offline",       url: `${base}/scene/offline` },
      { name: "Music / Radio", url: `${base}/scene/music` },
      { name: "AI Pet",        url: `${base}/scene/pet` },
      { name: "Datacenter",    url: `${base}/scene/datacenter` },
      { name: "RTMP Ingest",   url: `${base}/scene/ingest` },
    ];
    let added = 0;
    for (const b of builtins) {
      if (!seenPaths.has(pathOf(b.url))) {
        store.addScene(b.name, b.url);
        seenPaths.add(pathOf(b.url));
        added++;
      }
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
