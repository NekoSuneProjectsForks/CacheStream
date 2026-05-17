import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

export const DELETE = ownerRoute(async (_req, ctx: Ctx) => {
  const ok = getStore().removeRadioPreset(ctx.params.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
