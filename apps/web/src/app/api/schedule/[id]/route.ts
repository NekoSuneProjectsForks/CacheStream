import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { getStore, type ScheduleEntry } from "@/lib/store";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/** PATCH /api/schedule/:id — partial update. */
export const PATCH = staffRoute(async (req, ctx: Ctx) => {
  const patch = await readJson<Partial<ScheduleEntry>>(req);
  if (patch.at && !/^\d{2}:\d{2}$/.test(patch.at)) {
    return NextResponse.json({ error: "at must be HH:MM" }, { status: 400 });
  }
  const updated = getStore().updateSchedule(ctx.params.id, patch);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ entry: updated });
});

/** DELETE /api/schedule/:id */
export const DELETE = staffRoute(async (_req, ctx: Ctx) => {
  const ok = getStore().removeSchedule(ctx.params.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
