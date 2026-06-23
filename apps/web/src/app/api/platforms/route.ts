import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { getSetting, setSetting } from "@/lib/settings";
import { config } from "@/lib/config";
import { kickConfigured } from "@/lib/oauth/kick";
import { stopKickClient } from "@/lib/platform/kick";

export const dynamic = "force-dynamic";

function summary() {
  const store = getStore();
  const kickLink = store.getPlatformLink("kick");
  const twitchLinked = !!store.getTokens();
  return {
    connections: [
      { platform: "twitch", label: "Twitch", linked: twitchLinked,
        login: null, configured: true, comingSoon: false, canLink: false },
      { platform: "kick", label: "Kick", linked: !!kickLink,
        login: kickLink?.login || kickLink?.displayName || null,
        configured: kickConfigured(), comingSoon: false, canLink: true },
      { platform: "youtube", label: "YouTube", linked: false,
        login: null, configured: false, comingSoon: true, canLink: false },
      { platform: "vpzone", label: "VPzone", linked: false,
        login: null, configured: false, comingSoon: true, canLink: false },
    ],
    kick: {
      clientId: getSetting("kick_client_id"),
      hasSecret: !!getSetting("kick_client_secret"),
      redirectUri: `${config.web.publicUrl}/api/auth/kick/callback`,
    },
  };
}

/** GET /api/platforms — connection summary (owner only). */
export const GET = ownerRoute(async () => NextResponse.json(summary()));

/** POST /api/platforms — save Kick app credentials. */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ kickClientId?: string; kickClientSecret?: string }>(req);
  if (typeof body.kickClientId === "string") setSetting("kick_client_id", body.kickClientId.trim());
  if (typeof body.kickClientSecret === "string" && body.kickClientSecret.trim()) {
    setSetting("kick_client_secret", body.kickClientSecret.trim());
  }
  return NextResponse.json(summary());
});

/** DELETE /api/platforms { platform } — unlink a platform. */
export const DELETE = ownerRoute(async (req) => {
  const body = await readJson<{ platform?: string }>(req);
  if (body.platform === "kick") {
    stopKickClient();
    getStore().removePlatformLink("kick");
  }
  return NextResponse.json(summary());
});
