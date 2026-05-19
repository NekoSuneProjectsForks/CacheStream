import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/ingest/status[?k=<key>]
 *
 * Returns the configured RTMP ingest key + whether a live HLS
 * playlist is being produced by the nginx-rtmp sidecar for that
 * key. When `?k=` is omitted, falls back to the legacy default
 * key (kv `ingest_stream_key`, typically "cache").
 *
 * Liveness check is a cheap HEAD against the playlist on the
 * sidecar's internal HTTP port. Coalesces well — even if the
 * scene + the panel poll this every couple of seconds, the
 * nginx side is basically free.
 *
 * Public route (the scene needs it without an auth cookie).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requested = (url.searchParams.get("k") || "").trim();

  // Validate to avoid path traversal into the playlist filesystem.
  const sanitized = requested && /^[A-Za-z0-9_-]{1,64}$/.test(requested)
    ? requested
    : null;
  const key = sanitized || (kvGet("ingest_stream_key") || "cache");
  const enabled = (kvGet("ingest_enabled") ?? "1") === "1";

  // Per-key started-at tracking. Each multi-key key gets its own
  // kv slot so the "started at" timestamp reflects when THIS key
  // actually went live, not the first key that ever did.
  const startedAtKey = `ingest_started_at:${key}`;

  const hlsUrlInternal = `http://ingest:8080/hls/${encodeURIComponent(key)}.m3u8`;

  let live = false;
  let startedAt: number | null = null;
  if (enabled) {
    try {
      const r = await fetch(hlsUrlInternal, { method: "HEAD", cache: "no-store" });
      live = r.ok;
    } catch { live = false; }

    if (live) {
      startedAt = Number(kvGet(startedAtKey)) || Date.now();
      if (!kvGet(startedAtKey)) kvSet(startedAtKey, String(startedAt));
    } else if (kvGet(startedAtKey)) {
      kvSet(startedAtKey, "");
    }
  }

  return NextResponse.json({
    key,
    enabled,
    live,
    hlsUrl: enabled ? `/api/ingest/playlist/${encodeURIComponent(key)}.m3u8` : null,
    pushUrl: `rtmp://<host>:1935/live (use stream key "${key}")`,
    startedAt,
  });
}
