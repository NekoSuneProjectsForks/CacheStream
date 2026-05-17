import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type Overlay } from "@/lib/store";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/**
 * PATCH /api/overlays/:id/update — replace the overlay list inside
 * an existing set. Used by the moveable-overlays editor to save
 * drag/resize positions without creating a new preset.
 *
 * If the set is currently active on the streamer, the live render
 * is updated in the same call.
 */
export const PATCH = ownerRoute(async (req, ctx: Ctx) => {
  const { overlays } = await readJson<{ overlays?: Overlay[] }>(req);
  if (!Array.isArray(overlays)) {
    return NextResponse.json({ error: "overlays must be an array" }, { status: 400 });
  }
  const store = getStore();
  const updated = store.updateOverlaySet(ctx.params.id, overlays);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (store.getActiveOverlaySetId() === ctx.params.id) {
    try { await streamer.setOverlays(overlays); } catch {}
  }
  return NextResponse.json({ overlaySet: updated });
});
