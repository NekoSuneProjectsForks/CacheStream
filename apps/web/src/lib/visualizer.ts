/**
 * Music visualizer config — server-only kv read/write.
 *
 * The pure types/defaults/validation live in the client-safe
 * lib/visualizer-config.ts; this companion adds the kv-backed
 * persistence used by the API route. Keep server-only imports
 * (db) out of visualizer-config.ts so client bundles stay clean.
 */

import { kvGet, kvSet } from "./db";
import {
  VISUALIZER_DEFAULTS,
  normalizeVisualizer,
  type VisualizerConfig,
} from "./visualizer-config";

export * from "./visualizer-config";

export function getVisualizerConfig(): VisualizerConfig {
  const raw = kvGet("music_visualizer");
  if (!raw) return { ...VISUALIZER_DEFAULTS };
  try {
    return normalizeVisualizer(JSON.parse(raw));
  } catch {
    return { ...VISUALIZER_DEFAULTS };
  }
}

export function setVisualizerConfig(patch: Partial<VisualizerConfig>): VisualizerConfig {
  const merged = normalizeVisualizer({ ...getVisualizerConfig(), ...patch });
  kvSet("music_visualizer", JSON.stringify(merged));
  return merged;
}
