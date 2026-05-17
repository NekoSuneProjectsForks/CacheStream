import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

export const GET = ownerRoute(async () => {
  return NextResponse.json({ status: musicEngine().status() });
});
