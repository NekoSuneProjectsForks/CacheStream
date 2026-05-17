import crypto from "node:crypto";
import { NextResponse } from "next/server";
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
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const state = crypto.randomBytes(24).toString("hex");
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(STATE_COOKIE, sign(state), cookieOpts(STATE_TTL_MS));
  return res;
}
