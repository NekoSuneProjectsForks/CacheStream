import { NextResponse } from "next/server";
import { datacenter } from "@/lib/games/datacenter";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ state: datacenter().state() });
}
