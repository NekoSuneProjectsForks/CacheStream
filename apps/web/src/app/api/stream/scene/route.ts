import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { streamer } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

/** POST /api/stream/scene  { url: string } */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ url?: string }>(req);
  const url = (body.url || "").trim();
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: "url must be http(s)" }, { status: 400 });
  }
  const status = await streamer.setScene(url);
  return NextResponse.json({ status });
});
