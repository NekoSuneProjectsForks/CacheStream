import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";
import { sseStream } from "@/lib/sse";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/stream — Server-Sent Events stream of chat events.
 *
 * Public-ish: not behind ownerRoute() because the chat overlay
 * (running inside the headless browser as part of the streamed
 * scene) needs to subscribe without an OAuth session. Content is
 * just chat — already public on the channel.
 *
 * Lifecycle (cleanup correctness, fixes the bus-subscription leak
 * that ballooned the web container's memory over a long stream):
 * see `lib/sse.ts` for the close-on-first-of pattern.
 */
export async function GET(req: NextRequest) {
  return sseStream(req, ({ write, onClose }) => {
    write({ type: "hello", at: Date.now() });
    onClose(subscribe("chat", (payload) => write(payload)));
  });
}
