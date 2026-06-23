import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { kvGet, kvSet } from "@/lib/db";
import { ensureIngestWatcher } from "@/lib/ingest-watcher";

export const dynamic = "force-dynamic";

interface SafetyConfig {
  enabled: boolean;
  sceneUrl: string;
}

function read(): SafetyConfig {
  return {
    enabled: kvGet("safety_enabled") === "1",
    sceneUrl: kvGet("safety_scene_url") || "",
  };
}

/** GET /api/safety — disconnect-safety config (auto-switch on ingest drop). */
export const GET = staffRoute(async () => {
  ensureIngestWatcher();
  return NextResponse.json(read());
});

/** POST /api/safety { enabled?, sceneUrl? } */
export const POST = staffRoute(async (req) => {
  const body = await readJson<Partial<SafetyConfig>>(req);
  if (typeof body.enabled === "boolean") kvSet("safety_enabled", body.enabled ? "1" : "0");
  if (typeof body.sceneUrl === "string") kvSet("safety_scene_url", body.sceneUrl.trim());
  ensureIngestWatcher();
  return NextResponse.json(read());
});
