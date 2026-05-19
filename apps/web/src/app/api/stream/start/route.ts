import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

export const POST = staffRoute(async () => {
  const status = await streamer.start();
  return NextResponse.json({ status });
});
