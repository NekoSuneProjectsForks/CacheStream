import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type ScheduleEntry } from "@/lib/store";
import { ensureSchedulerStarted } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/** GET /api/schedule — list entries. Also boots the scheduler tick. */
export const GET = ownerRoute(async () => {
  ensureSchedulerStarted();
  return NextResponse.json({ schedule: getStore().listSchedule() });
});

/** POST /api/schedule { enabled, scenePresetId, overlaySetId?, at, days } */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<Omit<ScheduleEntry, "id">>(req);
  if (!body.scenePresetId) {
    return NextResponse.json({ error: "scenePresetId required" }, { status: 400 });
  }
  if (!/^\d{2}:\d{2}$/.test(body.at || "")) {
    return NextResponse.json({ error: "at must be HH:MM" }, { status: 400 });
  }
  if (!Array.isArray(body.days)) {
    return NextResponse.json({ error: "days must be an array" }, { status: 400 });
  }

  const entry = getStore().addSchedule({
    enabled: body.enabled !== false,
    scenePresetId: body.scenePresetId,
    overlaySetId: body.overlaySetId || null,
    at: body.at,
    days: body.days.filter((d) => d >= 0 && d <= 6),
  });
  ensureSchedulerStarted();
  return NextResponse.json({ entry });
});
