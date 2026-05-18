import { getOverlayConfig } from "@/lib/overlays";
import NowPlayingWidget from "./NowPlaying";
import ChatOverlay from "./ChatOverlay";
import AlertsTicker from "./AlertsTicker";
import StreamStatsOverlay from "./StreamStatsOverlay";

/**
 * Convenience wrapper that renders every globally-enabled scene
 * overlay. Used by scenes that don't use SceneFrame (Pet,
 * Datacenter, Ingest, Music) so they pick up the same set of
 * widgets the SceneFrame-based scenes do.
 *
 * Per-scene props let a specific overlay be suppressed even
 * when globally enabled (e.g. the Music scene suppresses its
 * own Now Playing widget because the scene IS the now-playing
 * display).
 *
 * Server component — reads kv directly. Renders the underlying
 * "use client" widgets which then mount the SSE subscriptions.
 */
export function SceneOverlays(props: {
  hideNowPlaying?: boolean;
  hideChatOverlay?: boolean;
  hideAlertsTicker?: boolean;
  hideStreamStats?: boolean;
  /** Force the Now Playing widget's corner (overrides config). */
  nowPlayingCorner?: "br" | "bl" | "tr" | "tl";
}) {
  const overlays = getOverlayConfig();

  const showNowPlaying  = overlays.nowPlaying.enabled    && !props.hideNowPlaying;
  const showChat        = overlays.chat.enabled         && !props.hideChatOverlay;
  const showTicker      = overlays.alertsTicker.enabled && !props.hideAlertsTicker;
  const showStreamStats = overlays.streamStats.enabled  && !props.hideStreamStats;

  return (
    <>
      {showNowPlaying  && <NowPlayingWidget   corner={props.nowPlayingCorner || overlays.nowPlaying.corner} />}
      {showChat        && <ChatOverlay        corner={overlays.chat.corner} />}
      {showStreamStats && <StreamStatsOverlay corner={overlays.streamStats.corner} />}
      {showTicker      && <AlertsTicker />}
    </>
  );
}
