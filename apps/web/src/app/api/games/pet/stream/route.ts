import { NextRequest } from "next/server";
import { subscribe } from "@/lib/bus";
import { sseStream } from "@/lib/sse";
import { pet } from "@/lib/games/pet";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return sseStream(req, ({ write, onClose }) => {
    write({ type: "snapshot", state: pet().state() });
    onClose(subscribe("pet", (state) => write({ type: "update", state })));
  });
}
