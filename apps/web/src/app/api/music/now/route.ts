import { NextResponse } from "next/server";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

/**
 * GET /api/music/now — public now-playing snapshot for the
 * /scene/music visualizer. NOT auth-gated — the headless browser
 * needs to poll this without an owner cookie.
 */
export async function GET() {
  const status = musicEngine().status();
  return NextResponse.json({
    mode: status.mode,
    nowPlaying: status.nowPlaying,
    volume: status.volume,
  });
}
