import { NextResponse } from "next/server";
import { kvGet, kvSet } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/ingest/status
 *
 * Returns the operator-configured RTMP ingest key + whether a
 * live HLS playlist is currently being produced by the `ingest`
 * nginx-rtmp container.
 *
 * Liveness check is a cheap HEAD against the playlist on the
 * sidecar's HTTP port. Coalesces well — even if the scene + the
 * panel poll this every couple of seconds, the nginx side is
 * basically free.
 *
 * Public route (the scene needs it without an auth cookie, since
 * scenes load in the streamer's headless Chromium, not the
 * operator's logged-in browser).
 */
export async function GET() {
  // Default key "cache" so a fresh deploy is playable without
  // first visiting the panel. The operator can rotate it later.
  const key = kvGet("ingest_stream_key") || "cache";
  const enabled = (kvGet("ingest_enabled") ?? "1") === "1";

  // The ingest sidecar exposes the HLS playlist over the internal
  // compose network (host: "ingest", port 8080). Browsers loading
  // the /scene/ingest page from the web container can also reach
  // it because docker compose DNS resolves service names.
  const internalBase = "http://ingest:8080";
  const playlistPath = `/hls/${key}.m3u8`;
  const hlsUrlInternal = `${internalBase}${playlistPath}`;

  let live = false;
  let startedAt: number | null = null;
  if (enabled) {
    try {
      const r = await fetch(hlsUrlInternal, { method: "HEAD", cache: "no-store" });
      live = r.ok;
      if (live) startedAt = Number(kvGet("ingest_started_at")) || Date.now();
      else if (kvGet("ingest_started_at")) kvSet("ingest_started_at", "");
    } catch {
      live = false;
    }
    if (live && !kvGet("ingest_started_at")) {
      kvSet("ingest_started_at", String(Date.now()));
      startedAt = Date.now();
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
