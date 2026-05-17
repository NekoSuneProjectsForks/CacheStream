import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getIngest, setIngest } from "@/lib/twitchIngest";
import { tryStatus } from "@/lib/streamer-client";

export const dynamic = "force-dynamic";

/**
 * GET /api/twitch/ingest
 *
 * Returns:
 *   - the dashboard-stored key (masked) + url
 *   - what the streamer currently has loaded (its in-memory
 *     config.twitch — possibly different if env defaults are
 *     in play and the dashboard kv is empty)
 *
 * We never return the FULL key to the browser — only a prefix +
 * length so the UI can render "live_…1234 (32 chars)".
 */
export const GET = ownerRoute(async () => {
  const snap = getIngest();
  const status = await tryStatus().catch(() => null);

  return NextResponse.json({
    // What the dashboard has stored (kv).
    streamKey: maskKey(snap.streamKey),
    streamKeyLength: snap.streamKey.length,
    ingestUrl: snap.ingestUrl,
    source: snap.source,
    // Cross-check: what the streamer thinks it's using.
    streamerKeyConfigured: !!status?.twitch?.keyConfigured,
    streamerIngestUrl: status?.twitch?.ingestUrl || "",
  });
});

/**
 * PATCH /api/twitch/ingest
 *
 *   { streamKey?: string | null, ingestUrl?: string | null }
 *
 * Empty string / null clears the dashboard override. The streamer
 * keeps whatever was loaded at boot (typically from .env), so
 * clearing is a "fall back to env" action.
 *
 * On success the streamer hot-restarts (if running) and the
 * broadcast reconnects within ~5s.
 */
export const PATCH = ownerRoute(async (req) => {
  const body = await readJson<{ streamKey?: string | null; ingestUrl?: string | null }>(req);

  if (body.ingestUrl !== undefined && body.ingestUrl) {
    if (!/^rtmps?:\/\/.+/.test(body.ingestUrl)) {
      return NextResponse.json(
        { error: "ingestUrl must start with rtmp:// or rtmps://" },
        { status: 400 }
      );
    }
  }
  if (body.streamKey !== undefined && body.streamKey) {
    if (/\s/.test(body.streamKey)) {
      return NextResponse.json({ error: "stream key cannot contain whitespace" }, { status: 400 });
    }
  }

  const snap = await setIngest({
    streamKey: body.streamKey,
    ingestUrl: body.ingestUrl,
  });
  const status = await tryStatus().catch(() => null);

  return NextResponse.json({
    streamKey: maskKey(snap.streamKey),
    streamKeyLength: snap.streamKey.length,
    ingestUrl: snap.ingestUrl,
    source: snap.source,
    streamerKeyConfigured: !!status?.twitch?.keyConfigured,
    streamerIngestUrl: status?.twitch?.ingestUrl || "",
  });
});

function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 5)}…${"•".repeat(Math.min(k.length - 9, 6))}…${k.slice(-4)}`;
}
