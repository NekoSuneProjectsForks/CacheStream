import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import {
  getVisualizerConfig,
  setVisualizerConfig,
  type VisualizerConfig,
} from "@/lib/visualizer";

export const dynamic = "force-dynamic";

/**
 * GET /api/music/visualizer — public spectrum config for the
 * /scene/music page. NOT auth-gated: the headless browser polls
 * this without an owner cookie, same as /api/music/now.
 */
export async function GET() {
  return NextResponse.json({ visualizer: getVisualizerConfig() });
}

/**
 * POST /api/music/visualizer — update the spectrum config from the
 * Music tab. Accepts a partial; unknown/invalid fields fall back to
 * the current value (see normalizeVisualizer).
 */
export const POST = staffRoute(async (req) => {
  const body = await readJson<Partial<VisualizerConfig>>(req);
  const visualizer = setVisualizerConfig(body || {});
  return NextResponse.json({ visualizer });
});
