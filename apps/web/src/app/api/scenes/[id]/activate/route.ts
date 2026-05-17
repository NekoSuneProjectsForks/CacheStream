import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/** POST /api/scenes/:id/activate — switch the live stream to this preset. */
export const POST = ownerRoute(async (_req, ctx: Ctx) => {
  const scene = getStore().getScene(ctx.params.id);
  if (!scene) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const status = await streamer.setScene(scene.url);
  return NextResponse.json({ scene, status });
});
