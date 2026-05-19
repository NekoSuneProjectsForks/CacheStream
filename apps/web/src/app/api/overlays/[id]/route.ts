import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/** DELETE /api/overlays/:id */
export const DELETE = staffRoute(async (_req, ctx: Ctx) => {
  const store = getStore();
  const wasActive = store.getActiveOverlaySet()?.id === ctx.params.id;
  const removed = store.removeOverlaySet(ctx.params.id);
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (wasActive) {
    try { await streamer.setOverlays([]); } catch {}
  }
  return NextResponse.json({ ok: true });
});
