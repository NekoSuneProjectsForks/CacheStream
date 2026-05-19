import { NextResponse } from "next/server";
import { staffRoute } from "@/lib/api-helpers";
import { datacenter } from "@/lib/games/datacenter";

export const dynamic = "force-dynamic";

export const POST = staffRoute(async () => {
  datacenter().reset();
  return NextResponse.json({ state: datacenter().state() });
});
