import type { Metadata } from "next";
import { SceneFrame } from "../_shared/SceneFrame";
import { appName } from "@/lib/app-name";

export const metadata: Metadata = { title: `${appName()} :: offline` };
export const dynamic = "force-dynamic";

/**
 * Built-in Offline scene. Intentionally minimal — used as the
 * default scene when the streamer is idle and the operator
 * hasn't configured anything else. Just a small mark + label.
 */
export default function OfflinePage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const title    = searchParams.title    || "OFFLINE";
  const subtitle = searchParams.subtitle || "Channel is not live right now";
  const accent   = searchParams.accent   || "#4ade80";

  return (
    <SceneFrame accent={accent} corner="STATUS · OFFLINE">
      <div className="cs-eyebrow"><span className="cs-pulse" /> Idle</div>
      <h1 className="cs-title">{title}</h1>
      <p className="cs-subtitle">{subtitle}</p>
    </SceneFrame>
  );
}
