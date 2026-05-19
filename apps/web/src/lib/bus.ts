/**
 * Tiny in-process pub/sub.
 *
 * Used by:
 *   - chat client → SSE endpoint (/api/chat/stream) + UI poll fallback
 *   - eventsub client → alerts SSE (/api/alerts/stream)
 *
 * In-process is fine because the web container is a single
 * Node process. If we ever scaled out we'd swap this for Redis
 * pub/sub; for now plain EventEmitter is the right call.
 */

import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(100); // SSE clients + scene-page subscribers

// Soft-alarm threshold: if the listener count climbs above this on
// any topic, log it. The bus *should* hover around 4-8 listeners on
// a normal stream (one per active scene page × number of subscribed
// overlays). A persistent >30 means the SSE cleanup path isn't
// firing — historically the headline cause of the v1.10.0 web-
// container memory leak.
const LEAK_WARN_THRESHOLD = 30;
let lastWarnedAt: Record<string, number> = {};

export function publish(topic: string, payload: unknown): void {
  emitter.emit(topic, payload);
}

export function subscribe(
  topic: string,
  handler: (payload: unknown) => void
): () => void {
  emitter.on(topic, handler);
  const count = emitter.listenerCount(topic);
  if (count >= LEAK_WARN_THRESHOLD) {
    const now = Date.now();
    // Throttle to one warning per topic per minute so we don't spam.
    if (!lastWarnedAt[topic] || now - lastWarnedAt[topic] > 60_000) {
      lastWarnedAt[topic] = now;
      console.warn(`[bus] high listener count on "${topic}": ${count} — possible SSE leak?`);
    }
  }
  return () => emitter.off(topic, handler);
}

/** Diagnostic: current listener counts by topic. */
export function busListenerCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of emitter.eventNames()) {
    if (typeof name === "string") out[name] = emitter.listenerCount(name);
  }
  return out;
}
