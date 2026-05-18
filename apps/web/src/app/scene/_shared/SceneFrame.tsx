import type { CSSProperties, ReactNode } from "react";
import { getBranding } from "@/lib/branding";
import { getOverlayConfig } from "@/lib/overlays";
import NowPlayingWidget from "./NowPlaying";
import ChatOverlay from "./ChatOverlay";
import AlertsTicker from "./AlertsTicker";
import StreamStatsOverlay from "./StreamStatsOverlay";
import "./scene-base.css";

interface Props {
  /** Accent hex / CSS colour (used for glows, badges, countdown). */
  accent?: string;
  /** Secondary background colour for the radial wash. */
  accent2?: string;
  /** Optional background image URL (covers full viewport). */
  background?: string;
  /** Override the brand text. Defaults to the branding display name. */
  brand?: string;
  /** Footer label (bottom-right corner). */
  corner?: string;
  /** Set to false to hide the brand ribbon entirely. */
  showBrand?: boolean;
  /**
   * Per-scene overrides for the global overlay config. Each
   * `hideXxx` prop, when true, suppresses that overlay even if
   * the operator has it globally enabled. Useful for scenes
   * where the overlay would conflict (e.g. the Music scene
   * already has its own Now Playing treatment).
   */
  hideNowPlaying?: boolean;
  hideChatOverlay?: boolean;
  hideAlertsTicker?: boolean;
  hideStreamStats?: boolean;
  /** Force the Now Playing widget's corner (overrides config). */
  nowPlayingCorner?: "br" | "bl" | "tr" | "tl";
  children: ReactNode;
}

/**
 * Reusable scene shell used by every built-in + custom scene.
 *   - Animated grid backdrop
 *   - CRT scanlines
 *   - Radial gradient wash from the accent
 *   - Optional background image
 *   - Brand ribbon (top-left, shows logo + display name from
 *     the branding store) + corner footer (bottom-right)
 *   - Centered .cs-content slot for the page's actual content
 *
 * Accent values feed CSS custom properties so countdown digits,
 * pulse dots, badge borders, etc. all pick up the operator's
 * chosen colour without per-scene overrides.
 *
 * If the operator hasn't set a brand accent and the caller didn't
 * pass one either, we fall back to the cyberpunk cyan default.
 * That keeps existing scenes looking identical to v1.4 while
 * giving new operators a single knob to retint everything.
 */
export function SceneFrame({
  accent,
  accent2,
  background,
  brand,
  corner,
  showBrand = true,
  hideNowPlaying = false,
  hideChatOverlay = false,
  hideAlertsTicker = false,
  hideStreamStats = false,
  nowPlayingCorner,
  children,
}: Props) {
  const branding = getBranding();
  const overlays = getOverlayConfig();
  const finalAccent = accent || branding.accent || "#00f0ff";
  const finalBrand  = brand  ?? branding.displayName;

  // Resolve whether each overlay should render for this scene:
  // global config says enabled AND per-scene didn't suppress.
  const showNowPlaying  = overlays.nowPlaying.enabled   && !hideNowPlaying;
  const showChat        = overlays.chat.enabled        && !hideChatOverlay;
  const showTicker      = overlays.alertsTicker.enabled && !hideAlertsTicker;
  const showStreamStats = overlays.streamStats.enabled  && !hideStreamStats;

  const style = {
    "--cs-accent-solid": finalAccent,
    "--cs-accent-glow":  hexAlpha(finalAccent, 0.55),
    "--cs-accent-soft":  hexAlpha(finalAccent, 0.4),
    "--cs-accent-line":  hexAlpha(finalAccent, 0.4),
    "--cs-accent":       hexAlpha(finalAccent, 0.18),
    "--cs-accent2":      accent2 ? hexAlpha(accent2, 0.14) : hexAlpha("#8a2bff", 0.18),
  } as CSSProperties;

  const bgStyle: CSSProperties | undefined = background
    ? {
        backgroundImage: `url(${cssUrl(background)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : undefined;

  return (
    <main className="cs-scene" style={style}>
      {bgStyle && <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: -1, ...bgStyle }} />}
      <div className="cs-wash"      aria-hidden />
      <div className="cs-grid"      aria-hidden />
      <div className="cs-scanlines" aria-hidden />

      {showBrand && (
        <div className="cs-brand">
          {branding.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logoUrl} alt="" className="cs-brand-logo" />
          )}
          <span className="cs-brand-name">{finalBrand}</span>
        </div>
      )}
      {corner && <div className="cs-corner">{corner}</div>}

      <div className="cs-content">{children}</div>
      {showNowPlaying  && <NowPlayingWidget   corner={nowPlayingCorner || overlays.nowPlaying.corner} />}
      {showChat        && <ChatOverlay        corner={overlays.chat.corner} />}
      {showStreamStats && <StreamStatsOverlay corner={overlays.streamStats.corner} />}
      {showTicker      && <AlertsTicker />}
    </main>
  );
}

function hexAlpha(c: string, a: number): string {
  if (!c) return `rgba(0, 240, 255, ${a})`;
  if (/^#([0-9a-f]{3})$/i.test(c)) {
    const m = c.slice(1);
    const r = parseInt(m[0] + m[0], 16);
    const g = parseInt(m[1] + m[1], 16);
    const b = parseInt(m[2] + m[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (/^#([0-9a-f]{6})$/i.test(c)) {
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return c;
}

function cssUrl(s: string): string {
  return `'${s.replace(/'/g, "\\'")}'`;
}
