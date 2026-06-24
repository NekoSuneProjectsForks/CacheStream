import { NextResponse } from "next/server";
import { ownerRoute, staffRoute, readJson } from "@/lib/api-helpers";
import { tryStatus } from "@/lib/streamer-client";
import {
  getTargets,
  saveTargets,
  ensureSeedTargets,
  pushTargetsToStreamer,
  syncTwitchTargetToKv,
  maskKey,
  isMasked,
  newTargetId,
  STREAM_PROTOCOLS,
  type StreamTarget,
} from "@/lib/multistream";

export const dynamic = "force-dynamic";

/** Build the masked target list + per-target live state for the dots. */
async function shape() {
  const targets = getTargets();
  const stateById: Record<string, string> = {};
  try {
    const st = await tryStatus();
    for (const t of (st as any)?.multistream?.targets || []) stateById[t.id] = t.state;
  } catch { /* streamer unreachable */ }
  return {
    protocols: STREAM_PROTOCOLS,
    targets: targets.map((t) => ({
      ...t,
      streamKey: maskKey(t.streamKey),
      hasKey: !!t.streamKey,
      // red=disconnected/failed, orange=connecting, green=connected,
      // off=disabled/no-dest, idle=stream not running.
      state: stateById[t.id] || (!t.enabled || !t.ingestUrl ? "off" : "idle"),
    })),
  };
}

/** GET /api/stream/targets — seeds Twitch + linked platforms, returns
 *  masked keys + live per-target status. */
export const GET = staffRoute(async () => {
  ensureSeedTargets();
  return NextResponse.json(await shape());
});

/** POST /api/stream/targets { targets } — replace the list (masked/blank
 *  keys keep their stored value), save + push. Toggling a target's
 *  `enabled` here applies live (the streamer adds/removes just that relay). */
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

    const protocol = STREAM_PROTOCOLS.includes(t.protocol as any) ? (t.protocol as StreamTarget["protocol"]) : "rtmp";
    const ingestUrl = (t.ingestUrl || "").trim();
    if (ingestUrl && (protocol === "rtmp" || protocol === "rtmps") && !/^rtmps?:\/\/.+/.test(ingestUrl)) {
      return NextResponse.json({ error: `${t.label || "Target"}: RTMP URL must start with rtmp:// or rtmps://` }, { status: 400 });
    }

    merged.push({
      id,
      label: (t.label || "Target").trim() || "Target",
      platform: t.platform || "custom",
      protocol,
      ingestUrl,
      streamKey,
      format: (t.format || "").trim(),
      enabled: t.enabled !== false,
    });
  }

  saveTargets(merged);
  syncTwitchTargetToKv();
  try { await pushTargetsToStreamer(); }
  catch (e: any) {
    return NextResponse.json({ error: `saved, but streamer push failed: ${e.message}`, ...(await shape()) }, { status: 200 });
  }
  return NextResponse.json(await shape());
});
