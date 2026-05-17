import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";
import { datacenter } from "@/lib/games/datacenter";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "snapshot", state: datacenter().state() })}\n\n`));
      const unsub = subscribe("datacenter", (state) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "update", state })}\n\n`));
      });
      const keepalive = setInterval(() => { try { controller.enqueue(enc.encode(`: keepalive\n\n`)); } catch {} }, 25_000);
      req.signal.addEventListener("abort", () => { clearInterval(keepalive); unsub(); try { controller.close(); } catch {} });
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
