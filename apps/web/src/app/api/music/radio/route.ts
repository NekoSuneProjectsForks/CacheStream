import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

/** GET /api/music/radio — list saved radio presets. */
export const GET = staffRoute(async () => {
  return NextResponse.json({ presets: getStore().listRadioPresets() });
});

/**
 * POST /api/music/radio
 *   { url, name? }         → start playing immediately
 *   { saveAs, url }        → save preset only (don't play)
 *   { presetId }           → play a saved preset
 */
export const POST = staffRoute(async (req) => {
  const body = await readJson<{ url?: string; name?: string; saveAs?: string; presetId?: string }>(req);
  const store = getStore();

  if (body.presetId) {
    const preset = store.listRadioPresets().find((p) => p.id === body.presetId);
    if (!preset) return NextResponse.json({ error: "preset not found" }, { status: 404 });
    musicEngine().playRadio(preset.url);
    return NextResponse.json({ status: musicEngine().status() });
  }

  if (body.saveAs && body.url) {
    const preset = store.addRadioPreset(body.saveAs, body.url);
    return NextResponse.json({ preset });
  }

  if (body.url) {
    musicEngine().playRadio(body.url);
    if (body.name) store.addRadioPreset(body.name, body.url);
    return NextResponse.json({ status: musicEngine().status() });
  }

  return NextResponse.json({ error: "url or presetId required" }, { status: 400 });
});
