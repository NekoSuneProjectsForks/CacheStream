import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/chat/log?limit=200 — recent chat log entries. */
export const GET = staffRoute(async (req) => {
  const limit = Math.min(
    1000,
    Number.parseInt(new URL(req.url).searchParams.get("limit") || "200", 10) || 200
  );
  return NextResponse.json({ entries: getStore().listChatLog(limit) });
});
