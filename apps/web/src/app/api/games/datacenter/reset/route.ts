import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { datacenter } from "@/lib/games/datacenter";

export const dynamic = "force-dynamic";

export const POST = ownerRoute(async () => {
  datacenter().reset();
  return NextResponse.json({ state: datacenter().state() });
});
