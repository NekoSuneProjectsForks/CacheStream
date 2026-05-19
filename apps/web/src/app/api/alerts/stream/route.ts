import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";
import { sseStream } from "@/lib/sse";

export const dynamic = "force-dynamic";

/** GET /api/alerts/stream — SSE feed of EventSub notifications. */
export async function GET(req: NextRequest) {
  return sseStream(req, ({ write, onClose }) => {
    write({ type: "hello", at: Date.now() });
    onClose(subscribe("alerts", (payload) => write(payload)));
  });
}
