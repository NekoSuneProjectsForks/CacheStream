import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type Overlay } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/overlays — list saved overlay sets + which is active. */
export const GET = ownerRoute(async () => {
  const store = getStore();
  return NextResponse.json({
    overlaySets: store.listOverlaySets(),
    activeOverlaySetId: store.getActiveOverlaySet()?.id || null,
  });
});

/** POST /api/overlays { name, overlays:[...] } */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ name?: string; overlays?: Overlay[] }>(req);
  if (!Array.isArray(body.overlays)) {
    return NextResponse.json({ error: "overlays must be an array" }, { status: 400 });
  }
  const set = getStore().saveOverlaySet(body.name || "Untitled", body.overlays);
  return NextResponse.json({ overlaySet: set });
});
