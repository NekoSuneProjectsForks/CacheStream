import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookieOpts, sign } from "@/lib/cookies";
import { config } from "@/lib/config";
import { getCurrentRole } from "@/lib/auth";
import { buildKickAuthorizeUrl, genPkce, kickConfigured } from "@/lib/oauth/kick";
import { relayMode } from "@/lib/oauth-relay";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "cs_kick_state";
const VERIFIER_COOKIE = "cs_kick_verifier";
const TTL_MS = 10 * 60 * 1000;

/**
 * GET /api/auth/kick/login — owner-only. Links a Kick channel to the owner.
 * In PUBLIC mode we hand off to the hosted relay (no per-user keys); in LOCAL
 * mode we run the direct OAuth2 (PKCE) flow with the owner's own keys.
 */
export async function GET(_req: NextRequest) {
  const home = new URL("/admin", config.web.publicUrl);
  if (getCurrentRole() !== "owner") {
    home.searchParams.set("kick", "forbidden");
    return NextResponse.redirect(home);
  }
  // Public mode: broker through the relay (no local client id/secret needed).
  if (relayMode() === "public") {
    return NextResponse.redirect(new URL("/api/auth/relay/kick/login", config.web.publicUrl));
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
