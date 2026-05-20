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

// Map each user-supplied handler to its safe-wrapped counterpart
// so unsubscribe() can find and remove the right listener.
const safeHandlers = new WeakMap<(payload: unknown) => void, (payload: unknown) => void>();

export function subscribe(
  topic: string,
  handler: (payload: unknown) => void
): () => void {
  // v1.13.4: wrap every subscriber in try/catch.
  //
  // Why this matters: Node's EventEmitter rethrows synchronous
  // listener errors out of `emit()`. That means a single buggy
  // subscriber (e.g. one of the games hitting a stray DB row or
  // a malformed payload) takes down whoever called `publish` —
  // historically EventSub's chat dispatch. The whole chat→games
  // pipeline would then look "broken" because one subscriber
  // poisoned the bus for everyone else.
  //
  // Wrapping at the bus layer is the right place: every
  // subscriber gets the protection automatically, regardless of
  // how careful (or not) they are inside their handler. Errors
  // are logged once per minute per topic so we still notice them.
  const safe = (payload: unknown) => {
    try {
      handler(payload);
    } catch (err: any) {
      const now = Date.now();
      const key = `err:${topic}`;
      if (!lastWarnedAt[key] || now - lastWarnedAt[key] > 60_000) {
        lastWarnedAt[key] = now;
        console.warn(`[bus] subscriber error on "${topic}":`, err?.stack || err);
      }
    }
  };
  safeHandlers.set(handler, safe);

  emitter.on(topic, safe);
  const count = emitter.listenerCount(topic);
  if (count >= LEAK_WARN_THRESHOLD) {
    const now = Date.now();
    // Throttle to one warning per topic per minute so we don't spam.
    if (!lastWarnedAt[topic] || now - lastWarnedAt[topic] > 60_000) {
      lastWarnedAt[topic] = now;
      console.warn(`[bus] high listener count on "${topic}": ${count} — possible SSE leak?`);
    }
  }
  return () => {
    const s = safeHandlers.get(handler);
    if (s) {
      emitter.off(topic, s);
      safeHandlers.delete(handler);
    } else {
      // Defensive: if the WeakMap entry was GC'd because the
      // original handler reference was lost, fall back to a no-op.
      // The bus would have already gc'd the listener too in that case.
    }
  };
}

/** Diagnostic: current listener counts by topic. */
export function busListenerCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of emitter.eventNames()) {
    if (typeof name === "string") out[name] = emitter.listenerCount(name);
  }
  return out;
}
