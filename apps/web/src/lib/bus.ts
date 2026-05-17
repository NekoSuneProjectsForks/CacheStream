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

export function publish(topic: string, payload: unknown): void {
  emitter.emit(topic, payload);
}

export function subscribe(
  topic: string,
  handler: (payload: unknown) => void
): () => void {
  emitter.on(topic, handler);
  return () => emitter.off(topic, handler);
}
