import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** DELETE /api/staff/invites/<code> — revoke a pending invite. */
export const DELETE = ownerRoute(async (_req, { params }: { params: { code: string } }) => {
  const ok = getStore().revokeInvite(params.code);
  return NextResponse.json({ ok });
});
