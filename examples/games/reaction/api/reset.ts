/**
 * POST /api/games/reaction/reset
 *
 * Copy to: apps/web/src/app/api/games/reaction/reset/route.ts
 *
 * Owner-only. Wipes the scoreboard + cancels any active round.
 * Exposed in the Games admin tab so the operator can clear state
 * between streams.
 */
import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { reaction } from "@/lib/games/reaction";

export const dynamic = "force-dynamic";

export const POST = ownerRoute(async () => {
  reaction().reset();
  return NextResponse.json({ state: reaction().state() });
});
