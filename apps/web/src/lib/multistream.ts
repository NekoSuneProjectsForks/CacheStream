/**
 * Multistream targets (restream.io-style multi-protocol output).
 *
 * Targets are persisted in kv and pushed to the streamer, which runs a
 * shared local relay + one `-c copy` process per ENABLED target — so a
 * target can be toggled on/off LIVE without dropping the others. With no
 * targets the streamer stays on its legacy single direct output.
 *
 * Twitch + any linked platform (Connections) are auto-seeded as targets
 * (Twitch enabled, others off) so all outputs are managed in one place.
 */

import crypto from "node:crypto";
import { kvGet, kvSet } from "./db";
import { getStore } from "./store";
import { streamer } from "./streamer-client";

export type StreamProtocol = "rtmp" | "rtmps" | "srt" | "rtsp" | "mpegts" | "custom";

export interface StreamTarget {
  id: string;
  label: string;
  platform: string;          // 'twitch' | 'youtube' | 'kick' | 'custom'
  protocol: StreamProtocol;
  ingestUrl: string;         // rtmp(s)://… | srt://… | rtsp://… | full URL
  streamKey: string;         // appended for rtmp/custom; ignore for srt/rtsp
  format?: string;           // ffmpeg muxer for protocol="custom"
  enabled: boolean;
}

export const STREAM_PROTOCOLS: StreamProtocol[] = ["rtmp", "rtmps", "srt", "rtsp", "mpegts", "custom"];

export function newTargetId(): string {
  return crypto.randomUUID();
}

export function getTargets(): StreamTarget[] {
  try {
    const raw = JSON.parse(kvGet("stream_targets") || "[]");
    return Array.isArray(raw) ? raw.map(normalize) : [];
  } catch { return []; }
}

function normalize(t: any): StreamTarget {
  return {
    id: t.id || newTargetId(),
    label: t.label || "Target",
    platform: t.platform || "custom",
    protocol: STREAM_PROTOCOLS.includes(t.protocol) ? t.protocol : "rtmp",
    ingestUrl: t.ingestUrl || "",
    streamKey: t.streamKey || "",
    format: t.format || "",
    enabled: t.enabled !== false,
  };
}

export function saveTargets(targets: StreamTarget[]): void {
  kvSet("stream_targets", JSON.stringify(targets));
}

/**
 * Ensure Twitch + linked platforms exist as targets. Twitch is seeded
 * enabled (it's the primary); platforms from Connections are seeded
 * DISABLED (toggle off) so nothing new fires until the operator opts in.
 * Returns the (possibly-updated) target list.
 */
export function ensureSeedTargets(): StreamTarget[] {
  const targets = getTargets();
  let changed = false;
  const has = (platform: string) => targets.some((t) => t.platform === platform);

  // Twitch — from the existing kv ingest config.
  const twitchKey = kvGet("twitch_stream_key") || "";
  if (!has("twitch") && twitchKey) {
    targets.unshift({
      id: newTargetId(), label: "Twitch", platform: "twitch", protocol: "rtmp",
      ingestUrl: kvGet("twitch_ingest_url") || "rtmp://live.twitch.tv/app",
      streamKey: twitchKey, enabled: true,
    });
    changed = true;
  }

  // Linked platforms (Connections) → seeded off until the operator fills
  // in / confirms the ingest. Kick uses RTMPS.
  for (const link of getStore().listPlatformLinks()) {
    if (link.platform === "twitch" || has(link.platform)) continue;
    targets.push({
      id: newTargetId(),
      label: link.displayName || link.login || link.platform,
      platform: link.platform,
      protocol: link.platform === "kick" ? "rtmps" : "rtmp",
      ingestUrl: "", streamKey: "", enabled: false,
    });
    changed = true;
  }

  if (changed) saveTargets(targets);
  return targets;
}

/** Mask a stream key for display (keep the last 4). */
export function maskKey(k: string): string {
  if (!k) return "";
  return k.length <= 4 ? "••••" : `••••${k.slice(-4)}`;
}
export function isMasked(s: string): boolean {
  return s.includes("•");
}

/**
 * Push the FULL configured target list to the streamer (so relay mode is
 * active even if everything is momentarily disabled — the streamer runs a
 * relay process only for ENABLED targets). No-op when none configured.
 */
export async function pushTargetsToStreamer(): Promise<void> {
  const all = getTargets();
  if (!all.length) return;   // legacy single-output path
  await streamer.setTargets(all.map((t) => ({
    id: t.id, label: t.label, protocol: t.protocol, ingestUrl: t.ingestUrl,
    streamKey: t.streamKey, format: t.format, enabled: t.enabled,
  })));
}

export function enabledCount(): number {
  return getTargets().filter((t) => t.enabled && t.ingestUrl).length;
}

/** Mirror the Twitch target's key/url back to the canonical Twitch kv so
 *  the Helix key-fetch + the seed stay consistent (Twitch is now managed
 *  from the Multistream tab). */
export function syncTwitchTargetToKv(): void {
  const tw = getTargets().find((t) => t.platform === "twitch");
  if (tw?.streamKey) {
    kvSet("twitch_stream_key", tw.streamKey);
    if (tw.ingestUrl) kvSet("twitch_ingest_url", tw.ingestUrl);
  }
}
