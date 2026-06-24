import { NextResponse } from "next/server";
import { ownerRoute, staffRoute, readJson } from "@/lib/api-helpers";
import { streamer, tryStatus } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

/** GET /api/stream/bandwidth — current uplink/auto-protect snapshot. */
export const GET = staffRoute(async () => {
  const st = await tryStatus();
  return NextResponse.json({ bandwidth: st?.bandwidth ?? null });
});

/** POST /api/stream/bandwidth { autoProtect?, retest? } — toggle
 *  multistream auto-protect or trigger an immediate re-test. */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ autoProtect?: boolean; retest?: boolean }>(req);
  try {
    const bandwidth = await streamer.setBandwidthOptions({
      autoProtect: body.autoProtect,
      retest: body.retest,
    });
    return NextResponse.json({ bandwidth });
  } catch (e: any) {
    // Docker streamer (no auto-protect) → 404; report gently.
    return NextResponse.json({ error: e.message, bandwidth: null }, { status: e.status === 404 ? 200 : 502 });
  }
});
