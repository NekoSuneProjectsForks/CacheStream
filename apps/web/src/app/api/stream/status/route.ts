import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { tryStatus } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

export const GET = ownerRoute(async () => {
  const status = await tryStatus();
  return NextResponse.json({ status });
});
