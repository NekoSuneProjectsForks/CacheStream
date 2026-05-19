import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { kvSet } from "@/lib/db";
import { getOverlayConfig, OverlayConfig } from "@/lib/overlays";

export const dynamic = "force-dynamic";

/**
 * Scene overlay toggles + their default corners.
 *
 * Public GET (the scene pages running in headless Chromium need
 * it without an OAuth cookie). Mutations are owner-only.
 *
 * Per-scene overrides via SceneFrame props still win over these
 * global defaults.
 */

export async function GET() {
  return NextResponse.json(getOverlayConfig());
}

export const POST = staffRoute(async (req) => {
  const patch = await readJson<Partial<OverlayConfig>>(req);
  const current = getOverlayConfig();
  const next: OverlayConfig = JSON.parse(JSON.stringify(current));

  for (const k of Object.keys(next) as (keyof OverlayConfig)[]) {
    const incoming = (patch as any)[k];
    if (!incoming) continue;
    if (typeof incoming.enabled === "boolean") (next as any)[k].enabled = incoming.enabled;
    if (incoming.corner && ["br","bl","tr","tl"].includes(incoming.corner)) {
      (next as any)[k].corner = incoming.corner;
    }
  }

  kvSet("overlay_config", JSON.stringify(next));
  return NextResponse.json(next);
});
