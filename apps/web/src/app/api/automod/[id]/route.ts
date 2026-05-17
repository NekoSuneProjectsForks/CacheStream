import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type AutoModRule } from "@/lib/store";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

export const PATCH = ownerRoute(async (req, ctx: Ctx) => {
  const patch = await readJson<Partial<AutoModRule>>(req);
  const rule = getStore().updateAutoModRule(ctx.params.id, patch);
  if (!rule) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ rule });
});

export const DELETE = ownerRoute(async (_req, ctx: Ctx) => {
  const ok = getStore().removeAutoModRule(ctx.params.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
