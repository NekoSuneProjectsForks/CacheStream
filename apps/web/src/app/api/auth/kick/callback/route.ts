import { NextRequest, NextResponse } from "next/server";
import { unsign } from "@/lib/cookies";
import { config } from "@/lib/config";
import { getCurrentRole } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { exchangeKickCode, fetchKickChannels } from "@/lib/oauth/kick";
import { startKickClient } from "@/lib/platform/kick";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "cs_kick_state";
const VERIFIER_COOKIE = "cs_kick_verifier";

/**
 * GET /api/auth/kick/callback — completes the Kick link: validates state +
 * PKCE, exchanges the code, resolves the channel/chatroom, persists the
 * token + link, and starts the Kick chat client.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = unsign(req.cookies.get(STATE_COOKIE)?.value);
  const verifier = unsign(req.cookies.get(VERIFIER_COOKIE)?.value);

  const back = (status: string) => {
    const home = new URL("/admin", config.web.publicUrl);
    home.searchParams.set("kick", status);
    const res = NextResponse.redirect(home);
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(VERIFIER_COOKIE);
    return res;
  };

  if (getCurrentRole() !== "owner") return back("forbidden");
  if (!code || !state || !cookieState || state !== cookieState || !verifier) {
    return back("state");
  }

  try {
    const tok = await exchangeKickCode(code, verifier);
    const channels = await fetchKickChannels(tok.access_token);
    const ch = channels[0] || {};
    const chatroomId = String(ch.chatroom?.id ?? ch.chatroom_id ?? "");
    const platformUserId = String(ch.broadcaster_user_id ?? ch.id ?? "");
    const scopes = (tok.scope || "").split(" ").filter(Boolean);

    const store = getStore();
    store.savePlatformTokens({
      platform: "kick",
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
      scopes,
      platformUserId,
      updatedAt: Date.now(),
    });
    store.savePlatformLink({
      platform: "kick",
      platformUserId,
      login: ch.slug ?? ch.username ?? null,
      displayName: ch.name ?? ch.username ?? null,
      avatarUrl: null,
      extra: { chatroomId },
      scopes,
    });

    try { startKickClient(); } catch { /* best-effort */ }
    return back("linked");
  } catch (err) {
    console.error("[kick callback]", err);
    return back("error");
  }
}
