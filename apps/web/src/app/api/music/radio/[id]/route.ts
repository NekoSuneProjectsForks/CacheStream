import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

export const DELETE = staffRoute(async (_req, ctx: Ctx) => {
  const ok = getStore().removeRadioPreset(ctx.params.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
