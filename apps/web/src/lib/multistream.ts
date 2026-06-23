/**
 * Multistream targets (restream.io-style multi-RTMP output).
 *
 * Targets are persisted in kv and pushed to the streamer, which fans the
 * single encode out to every enabled target via FFmpeg's `tee` muxer.
 * With 0 configured targets the streamer stays on its legacy single
 * Twitch-ingest path, so existing setups are unchanged.
 */

import crypto from "node:crypto";
import { kvGet, kvSet } from "./db";
import { streamer } from "./streamer-client";

export interface StreamTarget {
  id: string;
  label: string;
  platform: string;          // 'twitch' | 'youtube' | 'kick' | 'custom'
  ingestUrl: string;         // rtmp(s)://…
  streamKey: string;
  enabled: boolean;
}

export function getTargets(): StreamTarget[] {
  try {
    const raw = JSON.parse(kvGet("stream_targets") || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function saveTargets(targets: StreamTarget[]): void {
  kvSet("stream_targets", JSON.stringify(targets));
}

export function newTargetId(): string {
  return crypto.randomUUID();
}

/** Mask a stream key for display (keep the last 4). */
export function maskKey(k: string): string {
  if (!k) return "";
  return k.length <= 4 ? "••••" : `••••${k.slice(-4)}`;
}

export function isMasked(s: string): boolean {
  return s.includes("•");
}

/** Push the enabled targets to the streamer (no-op when none configured). */
export async function pushTargetsToStreamer(): Promise<void> {
  const all = getTargets();
  if (!all.length) return;   // leave the streamer on its legacy single output
  const enabled = all
    .filter((t) => t.enabled && t.streamKey && t.ingestUrl)
    .map((t) => ({ ingestUrl: t.ingestUrl, streamKey: t.streamKey, label: t.label }));
  await streamer.setTargets(enabled);
}

/** Sum of enabled targets — used for the uplink egress estimate. */
export function enabledCount(): number {
  return getTargets().filter((t) => t.enabled && t.streamKey && t.ingestUrl).length;
}
