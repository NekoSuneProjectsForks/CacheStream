import path from "node:path";
import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/**
 * POST /api/vods/:id/play — switch the broadcast to this VOD.
 *
 * For kind='file' we translate the filename into an absolute
 * path inside the streamer container (which mounts the same
 * ./media/vods volume at /app/media/vods).
 */
export const POST = staffRoute(async (_req, ctx: Ctx) => {
  const v = getStore().getVod(ctx.params.id);
  if (!v) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // The streamer container mounts the same dir at /app/media/vods.
  const resolvedPath = v.kind === "file"
    ? path.posix.join("/app/media/vods", v.pathOrUrl)
    : v.pathOrUrl;

  const status = await streamer.playVod({
    id: v.id,
    name: v.name,
    kind: v.kind,
    pathOrUrl: resolvedPath,
    loop: v.loop,
  });
  return NextResponse.json({ status });
});
