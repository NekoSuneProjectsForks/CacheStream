import { NextResponse } from "next/server";
import { getStreamByUserId } from "@/lib/twitch/helix";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/twitch/live-public
 *
 * Same data as /api/twitch/live but without the ownerRoute gate.
 * Exists so scene overlays running inside the streamer's headless
 * Chromium can read uptime + viewer count without an auth
 * session. Returns only the broadcast-public fields (no token
 * leakage; viewer count + title are already public on the channel
 * page anyway).
 *
 * If the panel is exposed to the open internet, an attacker could
 * poll this to see whether you're live + your viewer count — but
 * both are public data on twitch.tv/<channel> already, so this is
 * not a meaningful exposure.
 */
export async function GET() {
  const tokens = getStore().getTokens();
  if (!tokens) {
    return NextResponse.json({
      liveOnTwitch: false,
      reason: "no_oauth",
      stream: null,
    });
  }

  try {
    const stream = await getStreamByUserId(tokens.twitchUserId);
    const live = !!stream && stream.type === "live";
    return NextResponse.json({
      liveOnTwitch: live,
      reason: live ? "live" : (stream ? "type_not_live" : "no_stream_record"),
      stream: stream
        ? {
            startedAt: stream.started_at,
            viewerCount: stream.viewer_count,
            title:       stream.title,
            game:        stream.game_name,
          }
        : null,
    });
  } catch (err: any) {
    return NextResponse.json({
      liveOnTwitch: false,
      reason: "helix_error",
      stream: null,
    }, { status: 502 });
  }
}
