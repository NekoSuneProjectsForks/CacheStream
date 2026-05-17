import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, fetchHelixUser } from "@/lib/oauth";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  cookieOpts,
  sign,
  unsign,
} from "@/lib/cookies";
import { getStore } from "@/lib/store";
import { config } from "@/lib/config";
import { onTokensRefreshed } from "@/lib/twitch/tokens";

/**
 * GET /api/auth/twitch/callback?code=...&state=...
 *
 * Validates the OAuth state (CSRF defence), exchanges the code
 * for tokens, fetches the Twitch user, then:
 *   - if no owner is set, claims ownership (first-login-wins)
 *   - if logged-in user matches the owner → issues a session,
 *     persists the broadcaster's tokens, kicks off chat + EventSub
 *   - otherwise → 403 deny page
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return renderError(
      `Twitch returned an error: ${escapeHtml(errorDescription || error)}`,
      400
    );
  }

  const signedState = req.cookies.get(STATE_COOKIE)?.value;
  const expected = unsign(signedState);
  if (!expected || expected !== state) {
    const res = renderError("OAuth state mismatch. Please try again.", 400);
    res.cookies.delete(STATE_COOKIE);
    return res;
  }

  if (!code) return renderError("Missing authorization code.", 400);

  let token;
  try {
    token = await exchangeCode(code);
  } catch {
    return renderError("Could not exchange code with Twitch.", 502);
  }

  let user;
  try {
    user = await fetchHelixUser(token.access_token);
  } catch {
    return renderError("Could not load your Twitch profile.", 502);
  }

  const store = getStore();
  store.claimOwnerIfUnset(user);

  if (!store.isOwner({ id: user.id, login: user.login })) {
    return renderError(
      `This CacheStream instance is owned by another Twitch account. ` +
        `Logged-in user <b>${escapeHtml(user.display_name || user.login)}</b> is not authorised.`,
      403
    );
  }

  store.upgradeOwnerFromUser(user);
  const { sid, expiresAt } = store.createSession(user);

  // Persist broadcaster tokens for Helix + chat + EventSub use.
  store.saveTokens({
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    expiresAt: Date.now() + (token.expires_in - 60) * 1000, // 60s safety buffer
    scopes: token.scope || [],
    twitchUserId: user.id,
    updatedAt: Date.now(),
  });

  // Fire-and-forget hook so the chat + EventSub clients can pick
  // up the new tokens immediately rather than wait for first use.
  try { await onTokensRefreshed(); } catch (err) { console.warn("[oauth] post-token hook:", err); }

  const res = NextResponse.redirect(`${config.web.publicUrl}/admin`);
  res.cookies.delete(STATE_COOKIE);
  res.cookies.set(
    SESSION_COOKIE,
    sign(sid),
    cookieOpts(expiresAt - Date.now())
  );
  return res;
}

function renderError(message: string, status: number): NextResponse {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Auth error</title>
<style>
  html,body{margin:0;background:#05060a;color:#e6f7ff;font-family:Segoe UI,system-ui,sans-serif}
  main{max-width:560px;margin:8vh auto;padding:2rem;border:1px solid rgba(0,240,255,.25);border-radius:6px;background:rgba(10,13,24,.65)}
  h1{margin:0 0 .8rem;color:#ff2bd6;text-shadow:0 0 14px rgba(255,43,214,.45)}
  a{color:#00f0ff}
</style></head>
<body><main>
  <h1>Authentication failed</h1>
  <p>${message}</p>
  <p><a href="/">← back home</a></p>
</main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
