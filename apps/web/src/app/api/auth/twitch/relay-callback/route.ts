import { NextRequest } from "next/server";
import { unsign } from "@/lib/cookies";
import { exchangePickup } from "@/lib/oauth-relay";
import { setSetting } from "@/lib/settings";
import { finalizeOwnerLogin, renderError } from "@/lib/twitch/owner-login";

/**
 * GET /api/auth/twitch/relay-callback?pickup=...&state=...  — PUBLIC (relay)
 * owner login. The relay completed the Twitch handshake and returns a one-time
 * pickup. We redeem it for tokens, then run the SAME owner finalization as the
 * direct flow (no per-user Twitch app/secret involved).
 */
export const dynamic = "force-dynamic";

const STATE_COOKIE = "cs_twitch_relay_state";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const pickup = url.searchParams.get("pickup");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const cookieState = unsign(req.cookies.get(STATE_COOKIE)?.value);

  if (error) {
    const res = renderError(`Twitch login failed at the relay: ${escapeHtml(error)}`, 400);
    res.cookies.delete(STATE_COOKIE);
    return res;
  }
  if (!pickup || !state || !cookieState || state !== cookieState) {
    const res = renderError("OAuth state mismatch. Please try again.", 400);
    res.cookies.delete(STATE_COOKIE);
    return res;
  }

  let tok;
  try { tok = await exchangePickup("twitch", pickup); }
  catch { return renderError("Could not complete the login through the relay.", 502); }

  // Twitch Helix needs a Client-Id header matching the token's client. In
  // public mode that's the RELAY's Twitch app — store its (public) client_id
  // so every Helix call works. The secret stays on the relay; refresh is
  // routed back through the relay (see lib/twitch/tokens.ts).
  if (tok.client_id) setSetting("twitch_client_id", tok.client_id);

  return finalizeOwnerLogin(req, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_in: tok.expires_in ?? 3600,
    scope: (tok.scope || "").split(" ").filter(Boolean),
  }, STATE_COOKIE);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
