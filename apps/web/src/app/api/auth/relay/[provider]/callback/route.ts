import { NextRequest, NextResponse } from "next/server";
import { unsign } from "@/lib/cookies";
import { config } from "@/lib/config";
import { getCurrentRole } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { exchangePickup } from "@/lib/oauth-relay";
import { fetchKickChannels } from "@/lib/oauth/kick";
import { startKickClient } from "@/lib/platform/kick";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/relay/:provider/callback — the relay sends the browser here
 * with a one-time `pickup` (PUBLIC mode). We validate state, redeem the
 * pickup for tokens server-to-server, then link the platform.
 */
export async function GET(req: NextRequest, { params }: { params: { provider: string } }) {
  const provider = String(params.provider || "").toLowerCase();
  const url = new URL(req.url);
  const pickup = url.searchParams.get("pickup");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const cookieName = `cs_relay_${provider}_state`;
  const cookieState = unsign(req.cookies.get(cookieName)?.value);

  const back = (status: string) => {
    const home = new URL("/admin", config.web.publicUrl);
    home.searchParams.set(provider, status);
    const res = NextResponse.redirect(home);
    res.cookies.delete(cookieName);
    return res;
  };

  if (getCurrentRole() !== "owner") return back("forbidden");
  if (error || !pickup || !state || !cookieState || state !== cookieState) return back("state");

  try {
    const tok = await exchangePickup(provider, pickup);
    const scopes = (tok.scope || "").split(" ").filter(Boolean);
    const expiresAt = Date.now() + (((tok.expires_in ?? 3600) - 60) * 1000);

    if (provider === "kick") {
      const channels = await fetchKickChannels(tok.access_token);
      const ch = channels[0] || {};
      const chatroomId = String(ch.chatroom?.id ?? (ch as any).chatroom_id ?? "");
      const platformUserId = String(ch.broadcaster_user_id ?? ch.id ?? "");
      const store = getStore();
      store.savePlatformTokens({
        platform: "kick", accessToken: tok.access_token, refreshToken: tok.refresh_token ?? null,
        expiresAt, scopes, platformUserId, updatedAt: Date.now(),
      });
      store.savePlatformLink({
        platform: "kick", platformUserId,
        login: ch.slug ?? ch.username ?? null,
        displayName: ch.name ?? ch.username ?? null,
        avatarUrl: null, extra: { chatroomId }, scopes,
      });
      try { startKickClient(); } catch { /* best-effort */ }
    } else {
      return back("unsupported");
    }

    return back("linked");
  } catch (err) {
    console.error("[relay callback]", provider, err);
    return back("error");
  }
}
