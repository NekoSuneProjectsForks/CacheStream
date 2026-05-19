import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";
import { sseStream } from "@/lib/sse";
import { datacenter } from "@/lib/games/datacenter";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return sseStream(req, ({ write, onClose }) => {
    write({ type: "snapshot", state: datacenter().state() });
    onClose(subscribe("datacenter", (state) => write({ type: "update", state })));
  });
}
