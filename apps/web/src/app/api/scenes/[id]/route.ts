import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/** DELETE /api/scenes/:id */
export const DELETE = ownerRoute(async (_req, ctx: Ctx) => {
  const removed = getStore().removeScene(ctx.params.id);
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
