/**
 * SSE stream helper.
 *
 * Builds a ReadableStream with hard lifecycle management:
 *
 *   - Cleanup runs at most once, on the FIRST of:
 *       (a) req.signal abort fires
 *       (b) controller.enqueue throws (socket dead but abort
 *           hasn't propagated — common behind nginx / Cloudflare
 *           Tunnel)
 *       (c) keepalive enqueue fails for the same reason
 *
 *   - All callbacks (the bus subscription handler, the keepalive
 *     interval) check `closed` before doing work so stale
 *     handlers can't fire writes against a torn-down controller.
 *
 * Without these guards, SSE routes leaked bus subscriptions on
 * every scene reload (the streamer reloads scenes frequently),
 * eventually hitting EventEmitter's setMaxListeners(100) and
 * ballooning the web container's memory over a long stream.
 *
 * Pattern usage:
 *
 *     return sseStream(req, ({ write, onClose }) => {
 *       write({ type: "snapshot", state: ... });
 *       const unsub = subscribe("topic", write);
 *       onClose(unsub);
 *     });
 */

import type { NextRequest } from "next/server";

interface SseContext {
  write: (data: unknown) => void;
  /** Register a teardown callback. Invoked exactly once. */
  onClose: (fn: () => void) => void;
}

const KEEPALIVE_MS = 25_000;

export function sseStream(
  req: NextRequest,
  setup: (ctx: SseContext) => void,
): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const teardown: Array<() => void> = [];

      const close = () => {
        if (closed) return;
        closed = true;
        for (const fn of teardown) { try { fn(); } catch {} }
        try { controller.close(); } catch {}
      };

      const write = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };

      const keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`: keepalive\n\n`)); }
        catch { close(); }
      }, KEEPALIVE_MS);
      teardown.push(() => clearInterval(keepalive));

      req.signal.addEventListener("abort", close);

      setup({
        write,
        onClose: (fn) => { teardown.push(fn); },
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
