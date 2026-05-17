import type { Metadata } from "next";
import { SceneFrame } from "../_shared/SceneFrame";
import { SocialRow } from "../_shared/SocialRow";

export const metadata: Metadata = { title: "CacheStream :: ending" };
export const dynamic = "force-dynamic";

/**
 * Built-in Ending scene. Title / subtitle plus a row of social
 * handles. Common pattern: leave this scene on for 30–60s after
 * "stop" so chatters have time to follow / link out before the
 * Twitch dashboard cuts to offline.
 */
export default function EndingPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const sp = searchParams;
  const title    = sp.title    || "Thanks for watching";
  const subtitle = sp.subtitle || "Stream over · see you next time";
  const accent   = sp.accent   || "#ff2bd6";
  const background = sp.bg;

  return (
    <SceneFrame accent={accent} background={background} corner="OFF AIR">
      <div className="cs-eyebrow">Off air</div>
      <h1 className="cs-title cs-glitch" data-text={title}>{title}</h1>
      <p className="cs-subtitle">{subtitle}</p>
      <SocialRow
        twitch={sp.twitch}
        youtube={sp.youtube}
        twitter={sp.twitter}
        discord={sp.discord}
      />
    </SceneFrame>
  );
}
