import { NextResponse } from "next/server";
import { ownerRoute, staffRoute, readJson } from "@/lib/api-helpers";
import {
  getTargets,
  saveTargets,
  pushTargetsToStreamer,
  maskKey,
  isMasked,
  newTargetId,
  type StreamTarget,
} from "@/lib/multistream";

export const dynamic = "force-dynamic";

/** Targets with keys masked for display. */
function masked() {
  return {
    targets: getTargets().map((t) => ({ ...t, streamKey: maskKey(t.streamKey), hasKey: !!t.streamKey })),
  };
}

/** GET /api/stream/targets — list (masked keys). */
export const GET = staffRoute(async () => NextResponse.json(masked()));

/**
 * POST /api/stream/targets { targets } — replace the target list. A target
 * whose streamKey arrives empty or masked keeps its stored key (so the UI
 * never has to round-trip the real key). Saves + pushes to the streamer.
 */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ targets?: Partial<StreamTarget>[] }>(req);
  const incoming = Array.isArray(body.targets) ? body.targets : [];
  const prevById = new Map(getTargets().map((t) => [t.id, t]));

  const merged: StreamTarget[] = [];
  for (const t of incoming) {
    const id = t.id || newTargetId();
    const prev = prevById.get(id);
    let streamKey = (t.streamKey || "").trim();
    if ((!streamKey || isMasked(streamKey)) && prev) streamKey = prev.streamKey;

    const ingestUrl = (t.ingestUrl || "").trim();
    if (!ingestUrl) continue;
    if (!/^rtmps?:\/\/.+/.test(ingestUrl)) {
      return NextResponse.json({ error: `ingest URL must start with rtmp:// or rtmps:// (${t.label || ingestUrl})` }, { status: 400 });
    }

    merged.push({
      id,
      label: (t.label || "").trim() || "Target",
      platform: t.platform || "custom",
      ingestUrl,
      streamKey,
      enabled: t.enabled !== false,
    });
  }

  saveTargets(merged);
  try { await pushTargetsToStreamer(); }
  catch (e: any) { return NextResponse.json({ error: `saved, but streamer push failed: ${e.message}`, ...masked() }, { status: 200 }); }
  return NextResponse.json(masked());
});
