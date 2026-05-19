import type { ReactNode } from "react";
import "./_shared/scene-base.css";

/**
 * Scene route-group layout.
 *
 * Inherits the shared `scene-base.css` so every scene — built-in,
 * custom, Pet, Datacenter, Music, Ingest — gets the body fade-in
 * animation on mount and the common html/body reset. Before
 * v1.10.2 only SceneFrame-using scenes imported this; the others
 * showed a hard cut to white-then-page during the headless
 * Chromium reload between scenes. Promoting the CSS to a layout-
 * level import means every scene under /scene/* picks it up
 * automatically, even ones with their own `<style jsx>` blocks.
 *
 * No `<html>`/`<body>` — those are owned by the root app layout.
 * This is just a CSS-import wrapper.
 */
export default function SceneLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
