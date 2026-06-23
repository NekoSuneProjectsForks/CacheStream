/**
 * Disconnect-safety watcher.
 *
 * When enabled, polls the RTMP ingest. If a publisher that WAS live drops
 * out, it auto-switches the program scene to a configured "safety" scene
 * (e.g. a "be right back / reconnecting" screen) so viewers never see a
 * frozen/black game capture. When the publisher reconnects, it restores
 * the scene that was live before the drop.
 *
 * Config (kv):
 *   safety_enabled    "1" | "0"
 *   safety_scene_url  the scene URL to switch to on disconnect
 *
 * Deliberately conservative:
 *   - Only engages after the ingest has been live at least once this
 *     session (so it never yanks an intro/just-chatting scene to safety
 *     just because no one is pushing RTMP).
 *   - Requires a short offline streak before switching (ignores blips).
 *   - On reconnect it only restores if the program is STILL on the safety
 *     scene (so a manual scene change by the operator is respected).
 */

import { config } from "./config";
import { kvGet } from "./db";
import { streamer, tryStatus } from "./streamer-client";

const POLL_MS = 3000;
const OFFLINE_GRACE = 2;        // consecutive offline polls before acting (~6s)
const MIN_ACTION_GAP_MS = 4000; // don't switch scenes more than this often

let started = false;
let everLive = false;
let offlineStreak = 0;
let onSafety = false;
let savedSceneUrl: string | null = null;
let lastActionAt = 0;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Is a publisher currently pushing to the configured ingest key? */
async function isIngestLive(): Promise<boolean> {
  if ((kvGet("ingest_enabled") ?? "1") !== "1") return false;
  const key = kvGet("ingest_stream_key") || "cache";
  try {
    const r = await fetch(`${config.ingest.httpUrl}/stat`, { cache: "no-store" });
    if (!r.ok) return false;
    const xml = await r.text();
    const m = xml.match(
      new RegExp(`<stream>[\\s\\S]*?<name>${escapeRegex(key)}</name>[\\s\\S]*?</stream>`),
    );
    return !!(m && /<publishing/.test(m[0]));
  } catch {
    return false;
  }
}

function resetState() {
  everLive = false;
  offlineStreak = 0;
  onSafety = false;
  savedSceneUrl = null;
}

async function tick() {
  const enabled = kvGet("safety_enabled") === "1";
  const safetyUrl = (kvGet("safety_scene_url") || "").trim();
  if (!enabled || !safetyUrl) { resetState(); return; }

  const live = await isIngestLive();
  const now = Date.now();

  if (live) {
    everLive = true;
    offlineStreak = 0;
    // Reconnected — restore the pre-drop scene, but only if we're still
    // sitting on the safety scene (respect a manual change).
    if (onSafety && savedSceneUrl && now - lastActionAt > MIN_ACTION_GAP_MS) {
      const st = await tryStatus();
      if (st?.sceneUrl === safetyUrl) {
        try { await streamer.setScene(savedSceneUrl); } catch {}
      }
      onSafety = false;
      savedSceneUrl = null;
      lastActionAt = now;
    }
    return;
  }

  // Offline.
  offlineStreak++;
  if (!everLive) return;                       // never had a feed → nothing to protect
  if (onSafety || offlineStreak < OFFLINE_GRACE) return;
  if (now - lastActionAt < MIN_ACTION_GAP_MS) return;

  const st = await tryStatus();
  const cur = st?.sceneUrl || null;
  if (cur && cur !== safetyUrl) savedSceneUrl = cur;  // remember where to return
  try {
    await streamer.setScene(safetyUrl);
    onSafety = true;
    lastActionAt = now;
  } catch { /* streamer not ready / idle — try again next tick */ }
}

/** Start the watcher once (idempotent). Safe to call from boot. */
export function ensureIngestWatcher() {
  if (started) return;
  started = true;
  const t = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  if (typeof t.unref === "function") t.unref();
}
