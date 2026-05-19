import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { chatStatus, startChat, stopChat } from "@/lib/twitch/chat";
import { eventSubStatus, startEventSub, stopEventSub } from "@/lib/twitch/eventsub";
import { getStore } from "@/lib/store";
import { missingScopes } from "@/lib/oauth";
import { pet } from "@/lib/games/pet";
import { datacenter } from "@/lib/games/datacenter";

export const dynamic = "force-dynamic";

/** GET /api/chat/status — chat + eventsub connection state + scope check. */
export const GET = staffRoute(async () => {
  const tokens = getStore().getTokens();
  return NextResponse.json({
    tokensPresent: !!tokens,
    missingScopes: tokens ? missingScopes(tokens.scopes) : [],
    chat: chatStatus(),
    eventsub: eventSubStatus(),
  });
});

/** POST /api/chat/status { action: "start"|"stop" } — start/stop chat + eventsub. */
export const POST = staffRoute(async (req) => {
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action === "start") {
    // Games subscribe to the chat bus on first call — make sure
    // they're alive BEFORE chat connects, otherwise the first
    // batch of chat commands lands on a bus with no listeners.
    try { pet(); datacenter(); } catch {}
    await Promise.allSettled([startChat(), startEventSub()]);
  } else if (action === "stop") {
    stopChat(); stopEventSub();
  } else {
    return NextResponse.json({ error: "action must be start|stop" }, { status: 400 });
  }
  return NextResponse.json({ chat: chatStatus(), eventsub: eventSubStatus() });
});
