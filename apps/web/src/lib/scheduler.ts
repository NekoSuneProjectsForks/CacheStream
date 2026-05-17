/**
 * Scene rotation scheduler.
 *
 * Runs entirely inside the web container. Every 60s it scans
 * stored ScheduleEntry rows and, if the current minute matches
 * one's `at` time (and today is in its `days` list), it asks
 * the streamer to switch scene (and optionally overlay set).
 *
 * Why minute resolution?
 *   - sub-minute scheduling for a live broadcast is rarely
 *     useful, and a coarser check protects against jitter +
 *     duplicate triggers across container restarts.
 *   - we de-dupe by stamping the last fired minute per entry
 *     in memory; a restart at the same minute won't double-fire
 *     because the streamer is already on the target scene.
 *
 * NOTE: the scheduler is not currently auto-started by Next.js.
 * The /api/schedule routes call ensureSchedulerStarted() so it
 * boots on first admin interaction. A future improvement is a
 * dedicated `instrumentation.ts` hook for boot-time start.
 */

import { getStore } from "./store";
import { streamer } from "./streamer-client";

const TICK_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let lastFiredKey = new Map<string, string>(); // entryId → "YYYY-MM-DD HH:MM"

function minuteKey(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function tick() {
  const now = new Date();
  const hhmm = minuteKey(now).slice(-5);
  const dow = now.getDay();
  const key = minuteKey(now);

  const store = getStore();
  const entries = store.listSchedule().filter((e) => e.enabled);

  for (const entry of entries) {
    if (entry.at !== hhmm) continue;
    if (entry.days.length > 0 && !entry.days.includes(dow)) continue;
    if (lastFiredKey.get(entry.id) === key) continue;

    const scene = store.getScene(entry.scenePresetId);
    if (!scene) continue;

    try {
      await streamer.setScene(scene.url);
      if (entry.overlaySetId) {
        const set = store.getOverlaySet(entry.overlaySetId);
        if (set) await streamer.setOverlays(set.overlays);
        store.setActiveOverlaySet(entry.overlaySetId);
      }
      lastFiredKey.set(entry.id, key);
    } catch (err) {
      // Don't crash the scheduler if the streamer is down — it
      // will catch up on the next matching tick.
      console.warn("[scheduler] tick failed for entry", entry.id, err);
    }
  }
}

export function ensureSchedulerStarted(): void {
  if (timer) return;
  // Initial run after a short delay so the streamer has time
  // to come up after a cold boot.
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
