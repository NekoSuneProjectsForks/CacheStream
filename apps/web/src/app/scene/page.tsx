import type { Metadata } from "next";
import "./scene.css";
import { appName } from "@/lib/app-name";

/**
 * The scene that gets streamed.
 *
 * Pure server component — zero JS shipped to the browser
 * (well, to headless Chromium). All animation is CSS only.
 * Edit scene.css to change the look; edit this file to add
 * more scenes (see the data-scene attribute pattern).
 */
export const metadata: Metadata = {
  title: `${appName()} :: live`,
};

export default function ScenePage() {
  return (
    <main className="scene" data-scene="hello-world">
      <div className="grid-bg" aria-hidden />
      <div className="scanlines" aria-hidden />

      <h1 className="glitch" data-text="Hello World">
        Hello World
      </h1>

      <p className="subtitle">
        <span className="caret">&gt;</span>
        <span className="typed">cachestream :: live // headless render</span>
        <span className="cursor" aria-hidden>_</span>
      </p>
    </main>
  );
}
