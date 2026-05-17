import { NextRequest, NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { searchCategories } from "@/lib/twitch/helix";

export const dynamic = "force-dynamic";

/** GET /api/twitch/categories/search?q=valorant */
export const GET = ownerRoute(async (req: NextRequest) => {
  const q = new URL(req.url).searchParams.get("q") || "";
  const games = await searchCategories(q);
  return NextResponse.json({ games });
});
