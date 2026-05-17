import type { Metadata } from "next";
import { SceneFrame } from "../_shared/SceneFrame";

export const metadata: Metadata = { title: "CacheStream :: brb" };
export const dynamic = "force-dynamic";

/**
 * Built-in Be Right Back / Intermission scene. Calmer animation
 * than Starting Soon — no countdown by default, just a soft
 * pulsing card. Override via ?title= / ?subtitle= / ?accent=.
 */
export default function BrbPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const title    = searchParams.title    || "BRB";
  const subtitle = searchParams.subtitle || "Be right back · grabbing coffee";
  const accent   = searchParams.accent   || "#8a2bff";
  const background = searchParams.bg;

  return (
    <SceneFrame accent={accent} background={background} corner="INTERMISSION">
      <div className="cs-eyebrow"><span className="cs-pulse" /> Intermission</div>
      <h1 className="cs-title cs-glitch" data-text={title}>{title}</h1>
      <p className="cs-subtitle">{subtitle}</p>
    </SceneFrame>
  );
}
