import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type CustomCommand } from "@/lib/store";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

export const PATCH = ownerRoute(async (req, ctx: Ctx) => {
  const patch = await readJson<Partial<CustomCommand>>(req);
  const cmd = getStore().updateCommand(ctx.params.id, patch);
  if (!cmd) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ command: cmd });
});

export const DELETE = ownerRoute(async (_req, ctx: Ctx) => {
  const ok = getStore().removeCommand(ctx.params.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
