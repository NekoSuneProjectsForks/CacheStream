import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

export const POST = ownerRoute(async () => {
  const status = await streamer.stop();
  return NextResponse.json({ status });
});
