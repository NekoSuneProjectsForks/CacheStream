import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

/** GET /api/music/library — list known tracks (from DB). */
export const GET = ownerRoute(async () => {
  return NextResponse.json({ tracks: getStore().listMusicTracks() });
});

/** POST /api/music/library — rescan MUSIC_LIBRARY_DIR. */
export const POST = ownerRoute(async () => {
  const tracks = await musicEngine().scanLibrary();
  return NextResponse.json({ tracks });
});
