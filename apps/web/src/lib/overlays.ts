/**
 * Server-side helper for reading scene-overlay toggle config.
 *
 * Keeps the kv schema + defaults in one place. Both the SSR
 * SceneFrame and the /api/overlays/config route read through
 * here so the shape stays consistent.
 */

import { kvGet } from "./db";

export type Corner = "br" | "bl" | "tr" | "tl";

export interface OverlayConfig {
  nowPlaying:   { enabled: boolean; corner: Corner };
  chat:         { enabled: boolean; corner: Corner };
  alertsTicker: { enabled: boolean };
  streamStats:  { enabled: boolean; corner: Corner };
}

export const OVERLAY_DEFAULTS: OverlayConfig = {
  nowPlaying:   { enabled: true,  corner: "br" },
  chat:         { enabled: false, corner: "bl" },
  alertsTicker: { enabled: false },
  streamStats:  { enabled: false, corner: "tl" },
};

export function getOverlayConfig(): OverlayConfig {
  const out: OverlayConfig = JSON.parse(JSON.stringify(OVERLAY_DEFAULTS));
  const raw = kvGet("overlay_config");
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    for (const k of Object.keys(out) as (keyof OverlayConfig)[]) {
      const merged = { ...(out as any)[k], ...(parsed?.[k] || {}) };
      if (merged.corner && !["br","bl","tr","tl"].includes(merged.corner)) {
        merged.corner = (OVERLAY_DEFAULTS as any)[k].corner;
      }
      (out as any)[k] = merged;
    }
  } catch { /* fall back to defaults */ }
  return out;
}
