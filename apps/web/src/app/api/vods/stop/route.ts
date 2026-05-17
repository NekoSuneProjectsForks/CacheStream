import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

/** POST /api/vods/stop — end VOD broadcast (returns to idle). */
export const POST = ownerRoute(async () => {
  const status = await streamer.stopVod();
  return NextResponse.json({ status });
});
