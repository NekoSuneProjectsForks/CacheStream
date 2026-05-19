import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/staff/moderators — list current moderators. */
export const GET = ownerRoute(async () => {
  return NextResponse.json(getStore().listModerators());
});
