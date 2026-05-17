import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getStore } from "@/lib/store";
import { SceneFrame } from "../../_shared/SceneFrame";
import { Countdown } from "../../_shared/Countdown";
import { SocialRow } from "../../_shared/SocialRow";

export const dynamic = "force-dynamic";

interface Params { params: { slug: string } }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const scene = getStore().getCustomSceneBySlug(params.slug);
  return { title: `CacheStream :: ${scene?.name || "scene"}` };
}

/**
 * Renders a user-authored custom scene.
 *
 *   /scene/custom/<slug>
 *
 * Dispatches on the row's `template` field. Each template uses
 * a fixed set of payload keys from `config_json` — extra keys
 * are preserved by the store but ignored here.
 *
 * `raw_html` is the escape hatch: the operator's own HTML +
 * CSS are inlined verbatim into the page. There's no JS
 * sandbox — only the OAuth-authenticated owner can write
 * custom scenes, so injecting `<script>` here is on them.
 * (The scene runs inside headless Chromium, isolated from the
 * admin panel's origin via Cloudflare-Tunnel-served hostname.)
 */
export default function CustomScenePage({ params }: Params) {
  const scene = getStore().getCustomSceneBySlug(params.slug);
  if (!scene) notFound();

  const c = scene.config;

  switch (scene.template) {
    case "starting_soon":
      return (
        <SceneFrame accent={c.accent} background={asBg(c.background)} corner="ON STANDBY">
          <div className="cs-eyebrow"><span className="cs-pulse" /> Standby</div>
          <h1 className="cs-title cs-glitch" data-text={c.title || "Starting Soon"}>
            {c.title || "Starting Soon"}
          </h1>
          {c.subtitle && <p className="cs-subtitle">{c.subtitle}</p>}
          {c.countdownAt && (
            <>
              {c.countdownLabel && <div className="cs-tag">{c.countdownLabel}</div>}
              <Countdown to={c.countdownAt} label={c.countdownLabel} />
            </>
          )}
        </SceneFrame>
      );

    case "brb":
      return (
        <SceneFrame accent={c.accent || "#8a2bff"} background={asBg(c.background)} corner="INTERMISSION">
          <div className="cs-eyebrow"><span className="cs-pulse" /> Intermission</div>
          <h1 className="cs-title cs-glitch" data-text={c.title || "BRB"}>
            {c.title || "BRB"}
          </h1>
          {c.subtitle && <p className="cs-subtitle">{c.subtitle}</p>}
        </SceneFrame>
      );

    case "ending":
      return (
        <SceneFrame accent={c.accent || "#ff2bd6"} background={asBg(c.background)} corner="OFF AIR">
          <div className="cs-eyebrow">Off air</div>
          <h1 className="cs-title cs-glitch" data-text={c.title || "Thanks for watching"}>
            {c.title || "Thanks for watching"}
          </h1>
          {c.subtitle && <p className="cs-subtitle">{c.subtitle}</p>}
          <SocialRow
            twitch={c.twitch} youtube={c.youtube}
            twitter={c.twitter} discord={c.discord}
          />
        </SceneFrame>
      );

    case "generic":
      return (
        <SceneFrame accent={c.accent} background={asBg(c.background)}>
          {c.subtitle && <div className="cs-eyebrow">{c.subtitle}</div>}
          <h1 className="cs-title">{c.title || scene.name}</h1>
          {c.countdownAt && <Countdown to={c.countdownAt} label={c.countdownLabel} />}
        </SceneFrame>
      );

    case "raw_html":
      return (
        <>
          {/* Inline the operator's CSS first so it overrides the
              base styles where needed. */}
          {typeof c.css === "string" && c.css.length > 0 && (
            <style dangerouslySetInnerHTML={{ __html: c.css }} />
          )}
          <div
            // The owner authored this; we render it as-is.
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: typeof c.html === "string" ? c.html : "" }}
            style={{ width: "100vw", height: "100vh", overflow: "hidden" }}
          />
        </>
      );

    default:
      // Unknown template — render the name as a placeholder so the
      // scene doesn't 404 if a row was hand-edited mid-migration.
      return (
        <SceneFrame>
          <h1 className="cs-title">{scene.name}</h1>
          <p className="cs-subtitle">Unknown template: {scene.template}</p>
        </SceneFrame>
      );
  }
}

/** Strip an "image:" prefix that the editor uses for the background field. */
function asBg(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v.startsWith("image:")) return v.slice(6);
  if (/^https?:\/\//.test(v)) return v;
  return undefined;
}
