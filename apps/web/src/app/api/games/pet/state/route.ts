import { NextResponse } from "next/server";
import { pet } from "@/lib/games/pet";

export const dynamic = "force-dynamic";

/** Public GET — scene page subscribes via SSE; this is an HTTP snapshot. */
export async function GET() {
  return NextResponse.json({ state: pet().state() });
}
