import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

/** POST /api/music/play { trackId } — enqueue + (auto-start if idle). */
export const POST = staffRoute(async (req) => {
  const { trackId } = await readJson<{ trackId?: string }>(req);
  if (!trackId) return NextResponse.json({ error: "trackId required" }, { status: 400 });
  try { musicEngine().enqueue(trackId); }
  catch (err: any) { return NextResponse.json({ error: err.message }, { status: 400 }); }
  return NextResponse.json({ status: musicEngine().status() });
});
