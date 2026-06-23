import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookieOpts, sign } from "@/lib/cookies";
import { config } from "@/lib/config";
import { getCurrentRole } from "@/lib/auth";
import { buildKickAuthorizeUrl, genPkce, kickConfigured } from "@/lib/oauth/kick";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "cs_kick_state";
const VERIFIER_COOKIE = "cs_kick_verifier";
const TTL_MS = 10 * 60 * 1000;

/**
 * GET /api/auth/kick/login — owner-only. Starts the Kick OAuth2 (PKCE)
 * flow to LINK a Kick channel to the owner account. Stores the CSRF state
 * + the PKCE verifier in short-lived signed cookies, then 302s to Kick.
 */
export async function GET(_req: NextRequest) {
  const home = new URL("/admin", config.web.publicUrl);
  if (getCurrentRole() !== "owner") {
    home.searchParams.set("kick", "forbidden");
    return NextResponse.redirect(home);
  }
  if (!kickConfigured()) {
    home.searchParams.set("kick", "not-configured");
    return NextResponse.redirect(home);
  }

  const state = crypto.randomBytes(24).toString("hex");
  const { verifier, challenge } = genPkce();
  const res = NextResponse.redirect(buildKickAuthorizeUrl(state, challenge));
  res.cookies.set(STATE_COOKIE, sign(state), cookieOpts(TTL_MS));
  res.cookies.set(VERIFIER_COOKIE, sign(verifier), cookieOpts(TTL_MS));
  return res;
}
