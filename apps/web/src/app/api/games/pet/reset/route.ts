import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { pet } from "@/lib/games/pet";

export const dynamic = "force-dynamic";

export const POST = staffRoute(async (req) => {
  const { name } = await readJson<{ name?: string }>(req);
  pet().reset(name || "Cache");
  return NextResponse.json({ state: pet().state() });
});
