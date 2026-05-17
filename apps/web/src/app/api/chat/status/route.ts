import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { chatStatus, startChat, stopChat } from "@/lib/twitch/chat";
import { eventSubStatus, startEventSub, stopEventSub } from "@/lib/twitch/eventsub";
import { getStore } from "@/lib/store";
import { missingScopes } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/** GET /api/chat/status — chat + eventsub connection state + scope check. */
export const GET = ownerRoute(async () => {
  const tokens = getStore().getTokens();
  return NextResponse.json({
    tokensPresent: !!tokens,
    missingScopes: tokens ? missingScopes(tokens.scopes) : [],
    chat: chatStatus(),
    eventsub: eventSubStatus(),
  });
});

/** POST /api/chat/status { action: "start"|"stop" } — start/stop chat + eventsub. */
export const POST = ownerRoute(async (req) => {
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action === "start") {
    await Promise.allSettled([startChat(), startEventSub()]);
  } else if (action === "stop") {
    stopChat(); stopEventSub();
  } else {
    return NextResponse.json({ error: "action must be start|stop" }, { status: 400 });
  }
  return NextResponse.json({ chat: chatStatus(), eventsub: eventSubStatus() });
});
