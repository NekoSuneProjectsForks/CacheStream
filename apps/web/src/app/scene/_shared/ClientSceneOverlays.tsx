"use client";

/**
 * Client-side mirror of SceneOverlays. Same overlay set, but
 * fetches the overlay config over the public API at mount-time
 * so it can be used inside "use client" scenes (Pet, Datacenter,
 * Ingest, Music) that can't render server components directly.
 *
 * Cheap — one fetch per scene mount. Updates flow on the next
 * scene reload after the operator changes config in the panel.
 */

import { useEffect, useState } from "react";
import NowPlayingWidget from "./NowPlaying";
import ChatOverlay from "./ChatOverlay";
import AlertsTicker from "./AlertsTicker";
import StreamStatsOverlay from "./StreamStatsOverlay";

type Corner = "br" | "bl" | "tr" | "tl";

interface OverlayConfig {
  nowPlaying:   { enabled: boolean; corner: Corner };
  chat:         { enabled: boolean; corner: Corner };
  alertsTicker: { enabled: boolean };
  streamStats:  { enabled: boolean; corner: Corner };
}

const DEFAULTS: OverlayConfig = {
  nowPlaying:   { enabled: true,  corner: "br" },
  chat:         { enabled: false, corner: "bl" },
  alertsTicker: { enabled: false },
  streamStats:  { enabled: false, corner: "tl" },
};

interface Props {
  hideNowPlaying?: boolean;
  hideChatOverlay?: boolean;
  hideAlertsTicker?: boolean;
  hideStreamStats?: boolean;
  nowPlayingCorner?: Corner;
}

export default function ClientSceneOverlays(props: Props) {
  const [cfg, setCfg] = useState<OverlayConfig>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/overlays/config", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setCfg(data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const showNowPlaying  = cfg.nowPlaying.enabled    && !props.hideNowPlaying;
  const showChat        = cfg.chat.enabled          && !props.hideChatOverlay;
  const showTicker      = cfg.alertsTicker.enabled  && !props.hideAlertsTicker;
  const showStreamStats = cfg.streamStats.enabled   && !props.hideStreamStats;

  return (
    <>
      {showNowPlaying  && <NowPlayingWidget   corner={props.nowPlayingCorner || cfg.nowPlaying.corner} />}
      {showChat        && <ChatOverlay        corner={cfg.chat.corner} />}
      {showStreamStats && <StreamStatsOverlay corner={cfg.streamStats.corner} />}
      {showTicker      && <AlertsTicker />}
    </>
  );
}
