import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

export const GET = staffRoute(async () => {
  return NextResponse.json({ status: musicEngine().status() });
});
