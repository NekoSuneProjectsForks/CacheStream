"use client";

/**
 * Twitch VOD rerun scene.
 *
 * Loads the Twitch embed player for a configured archived
 * broadcast and lets it autoplay full-bleed. The streamer's
 * headless Chromium captures this page as the broadcast, so
 * effectively this is a "rerun your own past stream" feature —
 * useful for sleep streams, intermissions, or 24/7 reruns
 * between live blocks.
 *
 * Twitch's embed player requires a `parent=` query param that
 * matches the hostname the iframe is loaded from. The streamer
 * loads scenes via http://web:7788/scene/... (docker DNS), so
 * the parent there is "web". For operator preview from a real
 * browser the parent is window.location.hostname. We pass both
 * — the embed accepts a comma-separated list, so one always
 * matches and the other is ignored.
 *
 * The embed runs muted by default (Twitch's autoplay policy
 * requires it); we explicitly unmute on mount because the
 * Chromium scene already has the autoplay-policy=
 * no-user-gesture-required flag from the streamer's
 * puppeteer launch. Real-browser previews will stay muted
 * until the operator clicks the unmute button — that's
 * unavoidable browser policy.
 */

import { use, useEffect, useState } from "react";
import ClientSceneOverlays from "../../../_shared/ClientSceneOverlays";

export default function VodScene({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [parents, setParents] = useState<string>("web");

  useEffect(() => {
    // Build a comma-separated list of plausible parents — the
    // headless docker hostname AND whatever the actual browser
    // sees. Twitch's embed will accept the first one it considers
    // valid for the iframe's host.
    const dynamic = typeof window !== "undefined" ? window.location.hostname : "";
    setParents(["web", dynamic].filter(Boolean).join(","));
  }, []);

  const src = `https://player.twitch.tv/?video=${encodeURIComponent(id)}&autoplay=true&muted=false&parent=${encodeURIComponent(parents)}`;

  return (
    <>
      <style>{`
        html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
        .vod-wrap { position: fixed; inset: 0; }
        iframe { width: 100%; height: 100%; border: 0; background: #000; }
      `}</style>
      <div className="vod-wrap">
        <iframe
          src={src}
          allow="autoplay; fullscreen; encrypted-media"
          allowFullScreen
          title={`Twitch VOD ${id}`}
        />
      </div>
      <ClientSceneOverlays />
    </>
  );
}
