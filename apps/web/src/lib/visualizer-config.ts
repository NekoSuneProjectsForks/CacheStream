/**
 * Music visualizer config — pure types + defaults + validation.
 *
 * Client-safe: this module imports NOTHING server-only (no db,
 * no node builtins) so the /scene/music page and the MusicTab can
 * import the defaults/types directly without dragging better-sqlite3
 * into the browser bundle. The kv-backed read/write lives in the
 * server-only companion lib/visualizer.ts.
 */

export type VisualizerLayout = "bars" | "mirror" | "circular" | "waveform";

export const VISUALIZER_LAYOUTS: VisualizerLayout[] = [
  "bars",
  "mirror",
  "circular",
  "waveform",
];

export const VISUALIZER_LAYOUT_LABELS: Record<VisualizerLayout, string> = {
  bars: "Bars",
  mirror: "Mirror bars",
  circular: "Circular (radial)",
  waveform: "Waveform",
};

export interface VisualizerConfig {
  /** Spectrum style. "circular" is the centered radial (vizzy-style) look. */
  layout: VisualizerLayout;
  /** Primary accent (hex). Bottom of the bar gradient / inner radial. */
  accent: string;
  /** Secondary accent (hex). Top of the gradient / outer radial. */
  accent2: string;
  /** Audio sensitivity multiplier (0.5–2.5). Scales bar height. */
  sensitivity: number;
  /** Bar / segment count (16–96). */
  barCount: number;
  /** Render cap in fps (15–30). Lower = less GPU while gaming. */
  fps: number;
  /** Draw the mirrored reflection under the bars (bars/mirror layouts). */
  mirror: boolean;
  /** Floating background particles (circular layout). */
  particles: boolean;
  /** Spinning vinyl behind the cover (bars/mirror layouts). */
  showVinyl: boolean;
}

export const VISUALIZER_DEFAULTS: VisualizerConfig = {
  layout: "bars",
  accent: "#00f0ff",
  accent2: "#ff2bd6",
  sensitivity: 1,
  barCount: 48,
  fps: 30,
  mirror: true,
  particles: true,
  showVinyl: true,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

/** Coerce an arbitrary stored/posted partial into a valid config. */
export function normalizeVisualizer(parsed: any): VisualizerConfig {
  const out: VisualizerConfig = { ...VISUALIZER_DEFAULTS };
  if (!parsed || typeof parsed !== "object") return out;

  if (VISUALIZER_LAYOUTS.includes(parsed.layout)) out.layout = parsed.layout;
  if (typeof parsed.accent === "string" && HEX.test(parsed.accent)) out.accent = parsed.accent;
  if (typeof parsed.accent2 === "string" && HEX.test(parsed.accent2)) out.accent2 = parsed.accent2;
  out.sensitivity = clampNum(parsed.sensitivity, 0.5, 2.5, VISUALIZER_DEFAULTS.sensitivity);
  out.barCount = Math.round(clampNum(parsed.barCount, 16, 96, VISUALIZER_DEFAULTS.barCount));
  out.fps = Math.round(clampNum(parsed.fps, 15, 30, VISUALIZER_DEFAULTS.fps));
  if (typeof parsed.mirror === "boolean") out.mirror = parsed.mirror;
  if (typeof parsed.particles === "boolean") out.particles = parsed.particles;
  if (typeof parsed.showVinyl === "boolean") out.showVinyl = parsed.showVinyl;
  return out;
}
