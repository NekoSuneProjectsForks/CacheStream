import { NextRequest } from "next/server";
import { exchangeCode } from "@/lib/oauth";
import { STATE_COOKIE, unsign } from "@/lib/cookies";
import { finalizeOwnerLogin, renderError } from "@/lib/twitch/owner-login";

/**
 * GET /api/auth/twitch/callback?code=...&state=...  — DIRECT (own-keys) flow.
 *
 * Validates the OAuth state (CSRF), exchanges the code for tokens, then hands
 * off to finalizeOwnerLogin (shared with the relay flow) which claims/checks
 * ownership, persists tokens, and issues the session.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return renderError(`Twitch returned an error: ${escapeHtml(errorDescription || error)}`, 400);
  }

  const expected = unsign(req.cookies.get(STATE_COOKIE)?.value);
  if (!expected || expected !== state) {
    const res = renderError("OAuth state mismatch. Please try again.", 400);
    res.cookies.delete(STATE_COOKIE);
    return res;
  }
  if (!code) return renderError("Missing authorization code.", 400);

  let token;
  try { token = await exchangeCode(code); }
  catch { return renderError("Could not exchange code with Twitch.", 502); }

  return finalizeOwnerLogin(req, {
    access_token: token.access_token,
    refresh_token: token.refresh_token || null,
    expires_in: token.expires_in,
    scope: token.scope || [],
  }, STATE_COOKIE);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
