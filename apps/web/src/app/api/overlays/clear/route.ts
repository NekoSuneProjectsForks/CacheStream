import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

/** POST /api/overlays/clear — remove all overlays from the live render. */
export const POST = ownerRoute(async () => {
  const status = await streamer.setOverlays([]);
  getStore().setActiveOverlaySet(null);
  return NextResponse.json({ status });
});
