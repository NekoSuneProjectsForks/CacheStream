import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookieOpts, sign } from "@/lib/cookies";
import { config } from "@/lib/config";
import { getCurrentRole } from "@/lib/auth";
import { buildRelayLoginUrl } from "@/lib/oauth-relay";
import { KICK_SCOPES } from "@/lib/oauth/kick";

export const dynamic = "force-dynamic";

const TTL_MS = 10 * 60 * 1000;
// Providers brokered through the relay + the scope to request for each.
const SCOPES: Record<string, string> = { kick: KICK_SCOPES.join(" ") };

/**
 * GET /api/auth/relay/:provider/login — owner-only. Starts a relay-brokered
 * (PUBLIC mode) login: stores a CSRF state cookie and 302s to the relay,
 * which handles the provider + PKCE and returns a one-time pickup to the
 * callback. No per-user client id/secret needed.
 */
export async function GET(_req: NextRequest, { params }: { params: { provider: string } }) {
  const provider = String(params.provider || "").toLowerCase();
  const home = new URL("/admin", config.web.publicUrl);

  if (getCurrentRole() !== "owner") { home.searchParams.set(provider || "relay", "forbidden"); return NextResponse.redirect(home); }
  if (!SCOPES[provider]) { home.searchParams.set("relay", "unsupported"); return NextResponse.redirect(home); }

  const state = crypto.randomBytes(24).toString("hex");
  const res = NextResponse.redirect(buildRelayLoginUrl(provider, state, SCOPES[provider]));
  res.cookies.set(`cs_relay_${provider}_state`, sign(state), cookieOpts(TTL_MS));
  return res;
}
