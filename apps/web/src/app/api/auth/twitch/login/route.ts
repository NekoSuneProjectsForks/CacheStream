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
 * If `?from=setup` is present, sets a one-shot `cs_oauth_origin`
 * cookie so the callback can mark setup complete on success and
 * land the user on /admin instead of looping back to /setup.
 */
export const dynamic = "force-dynamic";

const ORIGIN_COOKIE = "cs_oauth_origin";

export async function GET(req: NextRequest) {
  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL(req.url);
  const fromSetup = url.searchParams.get("from") === "setup";

  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(STATE_COOKIE, sign(state), cookieOpts(STATE_TTL_MS));
  if (fromSetup) {
    res.cookies.set(ORIGIN_COOKIE, sign("setup"), cookieOpts(STATE_TTL_MS));
  }
  return res;
}
