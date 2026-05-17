/**
 * GET /api/games/reaction/state
 *
 * Copy to: apps/web/src/app/api/games/reaction/state/route.ts
 *
 * Public — the scene route fetches this without an owner cookie
 * for its first paint. Subsequent updates arrive via the SSE
 * stream (see ./stream.ts).
 */
import { NextResponse } from "next/server";
import { reaction } from "@/lib/games/reaction";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ state: reaction().state() });
}
