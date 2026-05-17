import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/** POST /api/overlays/:id/activate — apply this overlay set to the live render. */
export const POST = ownerRoute(async (_req, ctx: Ctx) => {
  const store = getStore();
  const set = store.getOverlaySet(ctx.params.id);
  if (!set) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const status = await streamer.setOverlays(set.overlays);
  store.setActiveOverlaySet(set.id);
  return NextResponse.json({ overlaySet: set, status });
});
