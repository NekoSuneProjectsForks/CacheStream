import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/oauth";
import { config, OAUTH_SCOPES } from "@/lib/config";
import { relayMode, relayBaseUrl } from "@/lib/oauth-relay";
import { STATE_COOKIE, STATE_TTL_MS, cookieOpts, sign } from "@/lib/cookies";

/**
 * GET /api/auth/twitch/login
 *
 * Starts the owner login. In LOCAL mode this 302s straight to Twitch with the
 * app's own client id; in PUBLIC mode it 302s to the OAuth relay (no per-user
 * Twitch app needed — the relay holds the keys). The relay sends the user back
 * to /api/auth/twitch/relay-callback with a one-time pickup.
 *
 * Bounce-context cookies (signed, short-lived) survive either round-trip:
 *   ?from=setup    → cs_oauth_origin=setup  (mark first-run setup complete)
 *   ?code=<invite> → cs_invite=<code>       (consume a staff invite)
 */
export const dynamic = "force-dynamic";

const ORIGIN_COOKIE = "cs_oauth_origin";
const INVITE_COOKIE = "cs_invite";
const RELAY_STATE_COOKIE = "cs_twitch_relay_state";

export async function GET(req: NextRequest) {
  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL(req.url);
  const fromSetup = url.searchParams.get("from") === "setup";
  const inviteCode = url.searchParams.get("code");
  const public_ = relayMode() === "public";

  let res: NextResponse;
  if (public_) {
    const u = new URL(`${relayBaseUrl()}/oauth/twitch/start`);
    u.searchParams.set("redirect_uri", `${config.web.publicUrl}/api/auth/twitch/relay-callback`);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", OAUTH_SCOPES.join(" "));
    res = NextResponse.redirect(u.toString());
    res.cookies.set(RELAY_STATE_COOKIE, sign(state), cookieOpts(STATE_TTL_MS));
  } else {
    res = NextResponse.redirect(buildAuthorizeUrl(state));
    res.cookies.set(STATE_COOKIE, sign(state), cookieOpts(STATE_TTL_MS));
  }

  if (fromSetup) res.cookies.set(ORIGIN_COOKIE, sign("setup"), cookieOpts(STATE_TTL_MS));
  if (inviteCode && /^[A-Za-z0-9_-]{8,64}$/.test(inviteCode)) {
    res.cookies.set(INVITE_COOKIE, sign(inviteCode), cookieOpts(STATE_TTL_MS));
  }
  return res;
}
