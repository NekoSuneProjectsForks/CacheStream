import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/stream — Server-Sent Events stream of chat events.
 *
 * Public-ish: this is intentionally not behind ownerRoute() because
 * the chat overlay (running inside the headless browser as part of
 * the streamed scene) needs to subscribe without an OAuth session.
 * Content is just chat (which is already public on the channel).
 */
export async function GET(req: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const write = (data: unknown) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      write({ type: "hello", at: Date.now() });

      const unsub = subscribe("chat", (payload) => write(payload));

      // 25s keepalive — beats most proxy idle timeouts (including
      // Cloudflare's 100s WebSocket idle limit).
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
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
