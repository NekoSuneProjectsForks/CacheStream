import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { pet } from "@/lib/games/pet";

export const dynamic = "force-dynamic";

export const POST = ownerRoute(async (req) => {
  const { name } = await readJson<{ name?: string }>(req);
  pet().reset(name || "Cache");
  return NextResponse.json({ state: pet().state() });
});
