import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** DELETE /api/staff/moderators/<twitchUserId> — revoke a moderator. */
export const DELETE = ownerRoute(async (_req, { params }: { params: { id: string } }) => {
  const ok = getStore().removeModerator(params.id);
  return NextResponse.json({ ok });
});
