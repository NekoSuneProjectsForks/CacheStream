import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { pet } from "@/lib/games/pet";

export const dynamic = "force-dynamic";

export const POST = ownerRoute(async (req) => {
  const { name } = await readJson<{ name?: string }>(req);
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  pet().rename(name.trim());
  return NextResponse.json({ state: pet().state() });
});
