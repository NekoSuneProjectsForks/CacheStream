import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/oauth";
import {
  STATE_COOKIE,
  STATE_TTL_MS,
  cookieOpts,
  sign,
} from "@/lib/cookies";

/**
 * GET /api/auth/twitch/login
 *
 * Generates a CSRF state, sets it in a short-lived signed
 * cookie, then 302s the user to Twitch's authorize endpoint.
 *
 * Two optional bounce-context cookies, both signed + short-lived:
 *
 *   ?from=setup    → cs_oauth_origin=setup
 *                    Tells the callback to mark first-run setup
 *                    complete + land on /admin instead of /setup.
 *
 *   ?code=<invite> → cs_invite=<code>
 *                    Tells the callback to consume the staff
 *                    invite + add the user as a moderator.
 *                    Used by /login/invite when the broadcaster
 *                    has handed someone an invite URL.
 */
export const dynamic = "force-dynamic";

const ORIGIN_COOKIE = "cs_oauth_origin";
const INVITE_COOKIE = "cs_invite";

export async function GET(req: NextRequest) {
  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL(req.url);
  const fromSetup = url.searchParams.get("from") === "setup";
  const inviteCode = url.searchParams.get("code");

  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(STATE_COOKIE, sign(state), cookieOpts(STATE_TTL_MS));
  if (fromSetup) {
    res.cookies.set(ORIGIN_COOKIE, sign("setup"), cookieOpts(STATE_TTL_MS));
  }
  if (inviteCode && /^[A-Za-z0-9_-]{8,64}$/.test(inviteCode)) {
    res.cookies.set(INVITE_COOKIE, sign(inviteCode), cookieOpts(STATE_TTL_MS));
  }
  return res;
}
