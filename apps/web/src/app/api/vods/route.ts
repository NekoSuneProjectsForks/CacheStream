import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { getStore, type VodSource } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/vods — list saved sources. */
export const GET = staffRoute(async () => {
  return NextResponse.json({ vods: getStore().listVods() });
});

/**
 * POST /api/vods
 *   { name, kind: 'file'|'url', pathOrUrl, loop? }
 *
 * For kind=file the pathOrUrl is a filename inside MEDIA/vods.
 * For kind=url it's an http(s) URL.
 */
export const POST = staffRoute(async (req) => {
  const body = await readJson<Partial<VodSource>>(req);
  if (!body.name?.trim() || !body.kind || !body.pathOrUrl?.trim()) {
    return NextResponse.json({ error: "name, kind, pathOrUrl required" }, { status: 400 });
  }
  if (body.kind !== "file" && body.kind !== "url") {
    return NextResponse.json({ error: "kind must be file|url" }, { status: 400 });
  }
  if (body.kind === "url" && !/^https?:\/\//.test(body.pathOrUrl)) {
    return NextResponse.json({ error: "pathOrUrl must be http(s)" }, { status: 400 });
  }
  const v = getStore().addVod({
    name: body.name.trim(),
    kind: body.kind,
    pathOrUrl: body.pathOrUrl.trim(),
    durationS: body.durationS ?? null,
    sizeBytes: body.sizeBytes ?? null,
    loop: !!body.loop,
  });
  return NextResponse.json({ vod: v });
});
