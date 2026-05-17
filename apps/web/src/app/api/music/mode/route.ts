import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

/** POST /api/music/mode { loop?: boolean, shuffle?: boolean } */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ loop?: boolean; shuffle?: boolean }>(req);
  const engine = musicEngine();
  if (typeof body.loop === "boolean")    engine.setLoop(body.loop);
  if (typeof body.shuffle === "boolean") engine.setShuffle(body.shuffle);
  return NextResponse.json({ status: engine.status() });
});
