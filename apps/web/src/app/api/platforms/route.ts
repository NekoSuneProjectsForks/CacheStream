import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore } from "@/lib/store";
import { getSetting, setSetting } from "@/lib/settings";
import { config } from "@/lib/config";
import { kickConfigured } from "@/lib/oauth/kick";
import { stopKickClient } from "@/lib/platform/kick";
import { relayMode } from "@/lib/oauth-relay";

export const dynamic = "force-dynamic";

function summary() {
  const store = getStore();
  const kickLink = store.getPlatformLink("kick");
  const twitchLinked = !!store.getTokens();
  const mode = relayMode();
  // In public (relay) mode, platforms can be linked without local keys.
  const kickCanLink = mode === "public" || kickConfigured();
  return {
    oauthRelay: {
      mode,
      url: config.oauthRelay.url,
      // What to register if the operator runs their OWN relay (local mode = own keys here).
      relayRedirectUri: `${config.web.publicUrl}/api/auth/relay/kick/callback`,
    },
    connections: [
      { platform: "twitch", label: "Twitch", linked: twitchLinked,
        login: null, configured: true, comingSoon: false, canLink: false },
      { platform: "kick", label: "Kick", linked: !!kickLink,
        login: kickLink?.login || kickLink?.displayName || null,
        configured: kickCanLink, comingSoon: false, canLink: true },
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

/** POST /api/platforms — set the OAuth method and/or save Kick app creds. */
export const POST = ownerRoute(async (req) => {
  const body = await readJson<{ relayMode?: string; kickClientId?: string; kickClientSecret?: string }>(req);
  if (body.relayMode === "public" || body.relayMode === "local") {
    setSetting("oauth_relay_mode", body.relayMode);
  }
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
