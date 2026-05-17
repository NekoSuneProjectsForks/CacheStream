import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/scenes — list saved scene presets. */
export const GET = ownerRoute(async () => {
  return NextResponse.json({ scenes: getStore().listScenes() });
});

/** POST /api/scenes { name, url } — add a preset. */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ name?: string; url?: string }>(req);
  const url = (body.url || "").trim();
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "url must be http(s)" }, { status: 400 });
  }
  const preset = getStore().addScene(body.name || "Untitled", url);
  return NextResponse.json({ scene: preset });
});
