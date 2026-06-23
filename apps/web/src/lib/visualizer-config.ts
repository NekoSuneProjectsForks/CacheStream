/**
 * Music visualizer config — pure types + defaults + validation.
 *
 * Client-safe: this module imports NOTHING server-only (no db,
 * no node builtins) so the /scene/music page and the MusicTab can
 * import the defaults/types directly without dragging better-sqlite3
 * into the browser bundle. The kv-backed read/write lives in the
 * server-only companion lib/visualizer.ts.
 */

export type VisualizerLayout =
  | "bars"
  | "mirror"
  | "waveform"
  | "trapnation"
  | "ncs"
  | "monstercat";

export const VISUALIZER_LAYOUTS: VisualizerLayout[] = [
  "trapnation",
  "ncs",
  "monstercat",
  "bars",
  "mirror",
  "waveform",
];

export const VISUALIZER_LAYOUT_LABELS: Record<VisualizerLayout, string> = {
  trapnation: "Trap Nation (circular)",
  ncs: "NCS (circular)",
  monstercat: "Monstercat (bars)",
  bars: "Bars",
  mirror: "Mirror bars",
  waveform: "Waveform",
};

/** Back-compat: the old "circular" layout is now "trapnation". */
const LAYOUT_ALIASES: Record<string, VisualizerLayout> = {
  circular: "trapnation",
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
  /** Custom background image URL ("" = the built-in gradient). May be an
   *  absolute http(s) URL or a same-origin path like /api/music/background. */
  background: string;
  /** Beat-reactive background flash (the scrim lifts on the beat). */
  flash: boolean;
  /** Beat-reactive screen shake (vizzy-style). */
  shake: boolean;
  /** Background dim 0–0.85 — the resting scrim darkness over the bg. */
  bgDim: number;
  /** Background blur in px (0–20) applied to a custom background image. */
  bgBlur: number;
  /** How the custom background image fits the screen. */
  bgFit: "cover" | "contain" | "tile";
  /** Beat FX strength multiplier (0.3–1.5) — scales flash dip + shake. */
  beatIntensity: number;
}

export const BG_FITS: VisualizerConfig["bgFit"][] = ["cover", "contain", "tile"];

export const VISUALIZER_DEFAULTS: VisualizerConfig = {
  layout: "bars",
  accent: "#00f0ff",
  accent2: "#ff2bd6",
  sensitivity: 1,
  barCount: 48,
  fps: 30,
  mirror: true,
  particles: true,
  showVinyl: false,
  background: "",
  flash: false,
  shake: false,
  bgDim: 0.45,
  bgBlur: 0,
  bgFit: "cover",
  beatIntensity: 1,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Allow http(s) URLs or same-origin paths only (no javascript:, data: etc). */
function isSafeBg(v: string): boolean {
  const s = v.trim();
  if (s === "") return true; // explicit "none"
  return /^https?:\/\//i.test(s) || s.startsWith("/");
}

function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

/** Coerce an arbitrary stored/posted partial into a valid config. */
export function normalizeVisualizer(parsed: any): VisualizerConfig {
  const out: VisualizerConfig = { ...VISUALIZER_DEFAULTS };
  if (!parsed || typeof parsed !== "object") return out;

  const aliased = LAYOUT_ALIASES[parsed.layout] || parsed.layout;
  if (VISUALIZER_LAYOUTS.includes(aliased)) out.layout = aliased;
  if (typeof parsed.accent === "string" && HEX.test(parsed.accent)) out.accent = parsed.accent;
  if (typeof parsed.accent2 === "string" && HEX.test(parsed.accent2)) out.accent2 = parsed.accent2;
  out.sensitivity = clampNum(parsed.sensitivity, 0.5, 2.5, VISUALIZER_DEFAULTS.sensitivity);
  out.barCount = Math.round(clampNum(parsed.barCount, 16, 96, VISUALIZER_DEFAULTS.barCount));
  out.fps = Math.round(clampNum(parsed.fps, 15, 30, VISUALIZER_DEFAULTS.fps));
  if (typeof parsed.mirror === "boolean") out.mirror = parsed.mirror;
  if (typeof parsed.particles === "boolean") out.particles = parsed.particles;
  if (typeof parsed.showVinyl === "boolean") out.showVinyl = parsed.showVinyl;
  if (typeof parsed.background === "string" && isSafeBg(parsed.background)) {
    out.background = parsed.background.trim();
  }
  if (typeof parsed.flash === "boolean") out.flash = parsed.flash;
  if (typeof parsed.shake === "boolean") out.shake = parsed.shake;
  out.bgDim = clampNum(parsed.bgDim, 0, 0.85, VISUALIZER_DEFAULTS.bgDim);
  out.bgBlur = clampNum(parsed.bgBlur, 0, 20, VISUALIZER_DEFAULTS.bgBlur);
  if (BG_FITS.includes(parsed.bgFit)) out.bgFit = parsed.bgFit;
  out.beatIntensity = clampNum(parsed.beatIntensity, 0.3, 1.5, VISUALIZER_DEFAULTS.beatIntensity);
  return out;
}
