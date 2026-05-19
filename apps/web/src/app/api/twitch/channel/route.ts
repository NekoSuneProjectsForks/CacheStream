import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { getChannelInfo, updateChannelInfo, getStreamByUserId } from "@/lib/twitch/helix";

export const dynamic = "force-dynamic";

/** GET /api/twitch/channel — current title, category, tags, live state. */
export const GET = staffRoute(async () => {
  const tokens = getStore().getTokens();
  if (!tokens) return NextResponse.json({ error: "no tokens; log in first" }, { status: 412 });
  const [channel, stream] = await Promise.all([
    getChannelInfo(tokens.twitchUserId),
    getStreamByUserId(tokens.twitchUserId),
  ]);
  return NextResponse.json({ channel, stream });
});

/** PATCH /api/twitch/channel { title?, game_id?, tags?, broadcaster_language? } */
export const PATCH = staffRoute(async (req) => {
  const tokens = getStore().getTokens();
  if (!tokens) return NextResponse.json({ error: "no tokens" }, { status: 412 });
  const body = await readJson<{ title?: string; game_id?: string; tags?: string[]; broadcaster_language?: string }>(req);

  const patch: any = {};
  if (typeof body.title === "string") patch.title = body.title.slice(0, 140);
  if (typeof body.game_id === "string") patch.game_id = body.game_id;
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags
      .map((t) => String(t).trim())
      .filter((t) => /^[A-Za-z0-9]{1,25}$/.test(t))
      .slice(0, 10);
  }
  if (typeof body.broadcaster_language === "string") patch.broadcaster_language = body.broadcaster_language;

  await updateChannelInfo(tokens.twitchUserId, patch);
  const channel = await getChannelInfo(tokens.twitchUserId);
  return NextResponse.json({ channel });
});
