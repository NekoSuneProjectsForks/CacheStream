import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { sendChat } from "@/lib/twitch/chat";
import { getStore } from "@/lib/store";
import { sendKickChat } from "@/lib/platform/kick";

export const dynamic = "force-dynamic";

/** POST /api/chat/send { text } — fans out to every linked platform. */
export const POST = staffRoute(async (req) => {
  const { text } = await readJson<{ text?: string }>(req);
  if (!text || !text.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  sendChat(text);
  // Also send to Kick if a channel is linked (best-effort, fire-and-forget).
  if (getStore().getPlatformLink("kick")) {
    sendKickChat(text).catch((e) => console.warn("[chat/send] kick:", e?.message || e));
  }
  return NextResponse.json({ ok: true });
});
