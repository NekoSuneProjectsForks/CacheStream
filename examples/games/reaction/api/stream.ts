/**
 * GET /api/games/reaction/stream
 *
 * Copy to: apps/web/src/app/api/games/reaction/stream/route.ts
 *
 * Server-Sent Events. Pushes the full state on every change
 * (round start, win, round timeout, reset). Public — the scene
 * page subscribes without an owner cookie.
 *
 * 25 s keepalive comments beat Cloudflare's 100 s idle timeout
 * on a tunnel without forcing reconnects.
 */
import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";
import { reaction } from "@/lib/games/reaction";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      // Push a snapshot immediately so the scene doesn't need to
      // also fetch /state on first paint.
      controller.enqueue(enc.encode(
        `data: ${JSON.stringify({ type: "snapshot", state: reaction().state() })}\n\n`
      ));

      const unsub = subscribe("reaction", (state) => {
        controller.enqueue(enc.encode(
          `data: ${JSON.stringify({ type: "update", state })}\n\n`
        ));
      });

      const keepalive = setInterval(() => {
        try { controller.enqueue(enc.encode(`: keepalive\n\n`)); } catch {}
      }, 25_000);

      req.signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        unsub();
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
