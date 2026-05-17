import type { Metadata } from "next";
import { SceneFrame } from "../_shared/SceneFrame";
import { Countdown } from "../_shared/Countdown";

export const metadata: Metadata = { title: "CacheStream :: starting soon" };
export const dynamic = "force-dynamic";

/**
 * Built-in Starting Soon scene. Title / subtitle / accent /
 * background / countdown target come from the query string so
 * the same route works for both the bundled "use me" preset
 * and quick one-off overrides without going through Custom
 * Scenes. Example:
 *   /scene/starting-soon?title=Stream%20begins&at=2026-05-17T20:00:00Z&accent=%23ff2bd6
 */
export default function StartingSoonPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const sp = searchParams;
  const title    = sp.title    || "Starting Soon";
  const subtitle = sp.subtitle || "Stream begins shortly · stand by";
  const accent   = sp.accent   || "#00f0ff";
  const background = sp.bg;
  const countdownAt    = sp.at;
  const countdownLabel = sp.label || "Live in";

  return (
    <SceneFrame accent={accent} background={background} corner="ON STANDBY">
      <div className="cs-eyebrow"><span className="cs-pulse" /> Standby</div>
      <h1 className="cs-title cs-glitch" data-text={title}>{title}</h1>
      <p className="cs-subtitle">{subtitle}</p>
      {countdownAt && (
        <>
          <div className="cs-tag" aria-hidden>{countdownLabel}</div>
          <Countdown to={countdownAt} label={countdownLabel} />
        </>
      )}
    </SceneFrame>
  );
}
