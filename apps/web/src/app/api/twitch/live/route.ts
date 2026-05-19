import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { getStreamByUserId } from "@/lib/twitch/helix";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/twitch/live
 *
 * Cross-checks the streamer's "I'm broadcasting" with Twitch's
 * "yes I see you broadcasting" via Helix `GET /streams?user_id=`.
 *
 * Streams that return data with `type === "live"` are publicly
 * visible on Twitch (the dashboard says LIVE). Anything else
 * (empty `data` array, or `type === ""`) means Twitch is not
 * actually showing the channel as live — useful for catching
 * the cases where FFmpeg is happily pushing bytes but Twitch
 * has silently rejected the connection (wrong key, duplicate
 * session, geo block, account flag, etc.).
 *
 * Cheap to call — Helix caches /streams for ~10 seconds upstream,
 * so polling at 5-10 s is fine.
 */
export const GET = staffRoute(async () => {
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
      error: err?.message || String(err),
      stream: null,
    }, { status: 502 });
  }
});
