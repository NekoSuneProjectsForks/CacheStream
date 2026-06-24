/**
 * RPC client for the streamer worker.
 *
 * All web → streamer traffic goes through this module so:
 *   - the bearer token is added consistently
 *   - errors come back as a uniform { status, body } shape
 *   - request paths are typed (no scattered string URLs)
 *
 * Designed for use ONLY from server-side code (route handlers,
 * server components). The INTERNAL_API_TOKEN must never reach
 * the browser.
 */

import { config } from "./config";

/**
 * Normalise a URL that points at THIS web app to the base the streamer
 * can actually reach (config.scene.baseUrl). Scene + widget URLs are
 * stored with whatever base the panel/seed used (historically the
 * Docker service name `http://web:7788`), but the streamer's reachable
 * host differs between Docker (`web:7788`) and the desktop app
 * (`localhost:<port>`). Rewriting here — the one server-side choke
 * point for every scene/overlay URL — makes presets work under both
 * without touching what's stored. External URLs (custom scenes, third-
 * party embeds) have a foreign host and are left untouched.
 */
export function toStreamerUrl(raw: string): string {
  if (!raw || typeof raw !== "string") return raw;
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }

  const selfHosts = new Set(["web", "localhost", "127.0.0.1", "0.0.0.0"]);
  try { selfHosts.add(new URL(config.web.publicUrl).hostname); } catch { /* ignore */ }

  if (!selfHosts.has(u.hostname)) return raw;

  try {
    const base = new URL(config.scene.baseUrl);
    u.protocol = base.protocol;
    u.hostname = base.hostname;
    u.port = base.port;
    return u.toString();
  } catch {
    return raw;
  }
}

/** Rewrite any self-pointing `src` inside an overlay descriptor. */
function normalizeOverlay(o: unknown): unknown {
  if (!o || typeof o !== "object") return o;
  const src = (o as { src?: unknown }).src;
  if (typeof src === "string" && src) {
    return { ...(o as object), src: toStreamerUrl(src) };
  }
  return o;
}

export interface StreamerStatus {
  state: "idle" | "starting" | "running" | "reconnecting" | "stopping";
  error: string | null;
  startedAt: number | null;
  uptimeMs: number;
  sceneUrl: string;
  overlays: unknown[];
  frameCount: number;
  lastFrameAt: number | null;
  twitch: { ingestUrl: string; keyConfigured: boolean };
  video: {
    width: number; height: number; fps: number;
    bitrateKbps: number; codec?: string; preset?: string;
  };
  autoProfile?: {
    category: string;
    codec: string;
    codecTag: string;
    host?: {
      arch: string; cores: number; cpuModel: string;
      totalMemGB: number; piModel: string | null;
      isPi: boolean; isWeakArm: boolean;
    };
  } | null;
  thermal?: {
    enabled: boolean;
    state: "normal" | "throttled";
    lastTempC: number | null;
    throttleC: number;
    recoverC: number;
  } | null;
  /**
   * True once FFmpeg's stderr confirms Twitch accepted the RTMP
   * handshake. False if we've never seen the success markers, or
   * if we've since seen ingest-dropped markers. A `running` state
   * with this `false` means we're pushing bytes into the void
   * (Twitch silently rejected — usually a wrong key or a busted
   * encoder output).
   */
  ingestAccepted?: boolean;
  multistream?: {
    active: boolean;
    targets: Array<{ id: string; label: string; enabled: boolean; state: string }>;
  };
  /** Upload bandwidth monitor + multistream auto-protect snapshot. */
  bandwidth?: {
    autoProtect: boolean;
    upMbps: number | null;
    baselineMbps: number | null;
    usableMbps: number | null;
    perStreamMbps: number | null;
    maxStreams: number | null;
    wanted: number;
    warning: string | null;
    probing: boolean;
    lastProbeAt: number | null;
    intervalMs: number;
    samples: Array<{ mbps: number; at: number }>;
  };
}

export interface BandwidthStatus extends NonNullable<StreamerStatus["bandwidth"]> {}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 5_000
): Promise<T> {
  const url = `${config.streamer.url}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.streamer.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!res.ok) {
    const msg =
      (payload && typeof payload === "object" && "error" in payload && (payload as any).error) ||
      `streamer ${method} ${path} failed (${res.status})`;
    const err = new Error(String(msg)) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return payload as T;
}

export const streamer = {
  status:   () => call<StreamerStatus>("GET",  "/status"),
  start:    () => call<StreamerStatus>("POST", "/start",   undefined, 20_000),
  stop:     () => call<StreamerStatus>("POST", "/stop"),
  restart:  () => call<StreamerStatus>("POST", "/restart", undefined, 20_000),
  setScene: (url: string) =>
    call<StreamerStatus>("POST", "/scene", { url: toStreamerUrl(url) }),
  setOverlays: (overlays: unknown[]) =>
    call<StreamerStatus>("POST", "/overlays", {
      overlays: Array.isArray(overlays) ? overlays.map(normalizeOverlay) : overlays,
    }),
  playVod:  (source: { id: string; name: string; kind: "file" | "url"; pathOrUrl: string; loop?: boolean }) =>
    call<StreamerStatus>("POST", "/vod/play", source),
  stopVod:  () => call<StreamerStatus>("POST", "/vod/stop"),
  /**
   * Update the Twitch stream key + ingest URL at runtime, without
   * restarting the container. If the stream is currently running
   * the streamer hot-restarts FFmpeg with the new credentials.
   */
  setIngest: (input: { streamKey?: string | null; ingestUrl?: string | null }) =>
    call<StreamerStatus>("POST", "/ingest", input),
  /** Multistream targets (restream.io-style multi-protocol fan-out).
   *  ingestUrls are EXTERNAL RTMP/SRT/… destinations — not self-pointing
   *  scene URLs — so they're passed through verbatim (no normalizeOverlay). */
  setTargets: (targets: Array<{
    id?: string; label?: string; protocol?: string; ingestUrl: string;
    streamKey?: string; format?: string; enabled?: boolean;
  }>) =>
    call<StreamerStatus>("POST", "/targets", { targets }),
  /** Toggle multistream auto-protect / trigger an immediate bandwidth re-test. */
  setBandwidthOptions: (opts: { autoProtect?: boolean; retest?: boolean }) =>
    call<BandwidthStatus>("POST", "/bandwidth", opts),
};

/** Returns null instead of throwing — useful for status polling. */
export async function tryStatus(): Promise<StreamerStatus | null> {
  try { return await streamer.status(); }
  catch { return null; }
}
