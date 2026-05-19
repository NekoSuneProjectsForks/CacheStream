import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

/** POST /api/music/volume { value: 0..1 } */
export const POST = staffRoute(async (req) => {
  const { value } = await readJson<{ value?: number }>(req);
  if (typeof value !== "number") return NextResponse.json({ error: "value required" }, { status: 400 });
  musicEngine().setVolume(value);
  return NextResponse.json({ status: musicEngine().status() });
});
