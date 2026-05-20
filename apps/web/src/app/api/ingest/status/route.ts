import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet } from "@/lib/db";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/ingest/status[?k=<key>]
 *
 * Returns the configured RTMP ingest key + whether a publisher
 * is currently pushing to it. As of v1.13.6 we hit nginx-rtmp's
 * /stat XML feed for an authoritative live/idle answer plus
 * useful diagnostics (inbound bitrate, publisher IP, duration).
 * Falls back to the v1.11 HEAD-against-the-HLS-playlist probe
 * if /stat is unreachable.
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

  let live = false;
  let startedAt: number | null = null;
  let bitrateKbps = 0;
  let clientAddr: string | null = null;
  let publisherInfo: { width: number; height: number; codec: string } | null = null;
  let lastError: string | null = null;

  if (enabled) {
    // Primary check: nginx-rtmp /stat XML — authoritative because
    // it returns the actual publisher session state, not just the
    // presence of a stale HLS playlist file.
    //
    // v1.13.8: trust /stat when it returns 200. The previous code
    // fell through to a HEAD on the .m3u8 file ANY time `live`
    // came back false from /stat, including the normal "no
    // publisher yet" case. That HEAD generated a 404 in nginx's
    // error log on every panel poll for every configured key —
    // very loud, no useful signal. Only fall back to the HEAD
    // probe when /stat itself was unreachable (e.g. older nginx-
    // rtmp build without stat support).
    let statReachable = false;
    try {
      const r = await fetch("http://ingest:8080/stat", { cache: "no-store" });
      if (r.ok) {
        statReachable = true;
        const xml = await r.text();
        const stream = findStream(xml, "live", key);
        if (stream) {
          live = true;
          bitrateKbps = stream.bwIn ? Math.round(stream.bwIn / 1000) : 0;
          clientAddr = stream.clientAddr;
          publisherInfo = stream.meta;
        }
      } else {
        lastError = `stat ${r.status}`;
      }
    } catch (err: any) {
      lastError = `stat unreachable: ${err?.message || err}`;
    }

    // Fallback: HEAD the HLS playlist. Only runs when /stat itself
    // couldn't answer — supports older nginx-rtmp builds without
    // stat compiled in.
    if (!statReachable && !live) {
      try {
        const r = await fetch(
          `http://ingest:8080/hls/${encodeURIComponent(key)}.m3u8`,
          { method: "HEAD", cache: "no-store" },
        );
        live = r.ok;
      } catch { /* leave live=false */ }
    }

    if (live) {
      startedAt = Number(kvGet(startedAtKey)) || Date.now();
      if (!kvGet(startedAtKey)) kvSet(startedAtKey, String(startedAt));
    } else if (kvGet(startedAtKey)) {
      kvSet(startedAtKey, "");
    }
  }

  // v1.13.6: render the actual host the operator should push to.
  // Previously this returned the literal string
  // `rtmp://<host>:1935/live (use stream key "cache")` and the
  // operator was expected to mentally substitute <host>. Use
  // PUBLIC_URL when available (Cloudflare Tunnel deploys), or
  // fall back to the request's own hostname.
  const pushUrl = derivePushUrl(req);

  return NextResponse.json({
    key,
    enabled,
    live,
    hlsUrl: enabled ? `/api/ingest/playlist/${encodeURIComponent(key)}.m3u8` : null,
    pushUrl,
    streamKey: key,
    startedAt,
    bitrateKbps,
    clientAddr,
    publisherInfo,
    lastError,
  });
}

/** Build a usable rtmp://… URL for the operator to paste into OBS. */
function derivePushUrl(req: NextRequest): string {
  // PUBLIC_URL is a full https://… that's behind a tunnel; the
  // RTMP port is NOT tunneled (it's a raw TCP port on the host).
  // We need the bare host the operator uses to reach :1935.
  // Pick in order:
  //   1. RTMP_PUBLIC_HOST env override (operator explicitly set it)
  //   2. PUBLIC_URL's hostname (likely the same machine the tunnel
  //      runs on, but only if the operator hasn't put it behind a
  //      different IP)
  //   3. The request's own hostname (the panel's URL — works for
  //      local dev)
  const override = process.env.RTMP_PUBLIC_HOST?.trim();
  if (override) return `rtmp://${override}:${process.env.RTMP_PORT || 1935}/live`;
  try {
    const pub = config.web.publicUrl;
    if (pub) {
      const host = new URL(pub).hostname;
      if (host && host !== "localhost") {
        return `rtmp://${host}:${process.env.RTMP_PORT || 1935}/live`;
      }
    }
  } catch { /* ignore */ }
  // Fallback to request host (strips port).
  try {
    const host = new URL(req.url).hostname;
    return `rtmp://${host}:${process.env.RTMP_PORT || 1935}/live`;
  } catch {
    return `rtmp://<your-host>:1935/live`;
  }
}

/**
 * Parse nginx-rtmp's <stat> XML for the named stream within the
 * named application. Returns null when the stream isn't present
 * (i.e. nothing is publishing to that key right now).
 *
 * The XML schema is simple but verbose; rather than pull in a
 * full XML parser we do targeted substring extraction. This is
 * safe because the input always comes from our own nginx-rtmp
 * sidecar — never user-controlled content.
 */
function findStream(xml: string, app: string, key: string): {
  bwIn: number;
  clientAddr: string | null;
  meta: { width: number; height: number; codec: string } | null;
} | null {
  // Find the <application> block whose <name> matches `app`.
  const appRx = new RegExp(`<application>[\\s\\S]*?<name>${app}</name>[\\s\\S]*?</application>`, "g");
  const appMatch = xml.match(appRx);
  if (!appMatch) return null;
  const appXml = appMatch[0];

  // Within that, find the <stream> whose <name> matches `key`.
  const streamRx = new RegExp(`<stream>[\\s\\S]*?<name>${escapeRegex(key)}</name>[\\s\\S]*?</stream>`, "g");
  const sMatch = appXml.match(streamRx);
  if (!sMatch) return null;
  const sXml = sMatch[0];

  // Only counted as live if there's at least one publisher.
  if (!/<publishing\/>|<publishing>/.test(sXml)) return null;

  const bwIn = parseInt(tag(sXml, "bw_in") || "0", 10);
  const clientAddr = tag(sXml, "address");
  const w = parseInt(tag(sXml, "width") || "0", 10);
  const h = parseInt(tag(sXml, "height") || "0", 10);
  const codec = tag(sXml, "codec") || "";
  return {
    bwIn,
    clientAddr,
    meta: w && h ? { width: w, height: h, codec } : null,
  };
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1] : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
