import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { listUserVideos, parseTwitchDuration } from "@/lib/twitch/helix";

export const dynamic = "force-dynamic";

/**
 * GET /api/twitch/vods
 *
 * List the broadcaster's recent past Twitch broadcasts (archive
 * type). Used by the Sources tab's VOD picker — operator picks
 * one and turns it into a "rerun" scene.
 *
 * Owner-only because it surfaces the broadcaster's full archive
 * including private/sub-only VODs the public channel page
 * wouldn't necessarily expose to anonymous visitors.
 */
export const GET = ownerRoute(async () => {
  const tokens = getStore().getTokens();
  if (!tokens) {
    return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const vids = await listUserVideos(tokens.twitchUserId, { first: 20, type: "archive" });
    return NextResponse.json(
      vids.map((v) => ({
        id:           v.id,
        title:        v.title,
        durationS:    parseTwitchDuration(v.duration),
        publishedAt:  v.published_at,
        thumbnailUrl: v.thumbnail_url || null,
        url:          v.url,
      })),
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "helix_error" },
      { status: err?.status || 502 },
    );
  }
});
