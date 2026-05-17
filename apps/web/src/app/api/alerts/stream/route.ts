import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";

export const dynamic = "force-dynamic";

/** GET /api/alerts/stream — SSE feed of EventSub notifications. */
export async function GET(req: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const unsub = subscribe("alerts", (payload) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
      });
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "hello", at: Date.now() })}\n\n`));
      const keepalive = setInterval(() => {
        try { controller.enqueue(enc.encode(`: keepalive\n\n`)); } catch {}
      }, 25_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(keepalive); unsub();
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
