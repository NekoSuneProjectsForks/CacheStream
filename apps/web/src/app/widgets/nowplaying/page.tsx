"use client";

/**
 * Now Playing widget page — the iframe source for the Studio "Now Playing"
 * overlay layer. Reuses the shared NowPlaying card (track cover + title +
 * artist), which hides itself when music is idle. The page body is made
 * transparent so only the card composites over the scene.
 */

import NowPlayingWidget from "../../scene/_shared/NowPlaying";

export default function NowPlayingWidgetPage() {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent !important;}",
        }}
      />
      {/* tl + no gutter offset works best inside a Studio-sized box; the
          card still hides when nothing is playing. */}
      <NowPlayingWidget corner="tl" />
    </>
  );
}
