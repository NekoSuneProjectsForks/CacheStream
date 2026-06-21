import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/ingest/playlist/[file]
 *
 * Same-origin proxy in front of the nginx-rtmp HLS server. Exists
 * so the headless Chromium <video> + hls.js can load both the
 * .m3u8 playlist and the .ts segments without crossing origins
 * (the scene loads from the web container; nginx-rtmp lives on a
 * different compose service / port).
 *
 * Streams the upstream response body straight through — no body
 * buffering — so live HLS chunks land in the browser as soon as
 * nginx writes them.
 */
export async function GET(_: Request, { params }: { params: { file: string } }) {
  const file = params.file;
  // Defensive: only allow .m3u8 + .ts inside /hls/.
  if (!/^[A-Za-z0-9_\-.]+\.(m3u8|ts)$/.test(file)) {
    return new NextResponse("bad path", { status: 400 });
  }
  const upstream = `${config.ingest.httpUrl}/hls/${file}`;
  const r = await fetch(upstream, { cache: "no-store" });
  if (!r.ok) return new NextResponse("upstream " + r.status, { status: r.status });
  const ct = file.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : "video/mp2t";
  return new NextResponse(r.body, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "no-store",
    },
  });
}
