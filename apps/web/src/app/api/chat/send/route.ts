import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { sendChat } from "@/lib/twitch/chat";

export const dynamic = "force-dynamic";

/** POST /api/chat/send { text } */
export const POST = ownerRoute(async (req) => {
  const { text } = await readJson<{ text?: string }>(req);
  if (!text || !text.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  sendChat(text);
  return NextResponse.json({ ok: true });
});
