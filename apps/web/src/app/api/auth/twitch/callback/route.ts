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
import { onTokensRefreshed, markRefreshTokenAlive } from "@/lib/twitch/tokens";

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

  const isOwner = store.isOwner({ id: user.id, login: user.login });

  // v1.13.0: if the user isn't the owner, check whether they
  // arrived carrying an invite cookie. If so, consume it + add
  // them as a moderator. If not (or the invite is invalid),
  // fall through to the existing 403 deny page.
  if (!isOwner) {
    const inviteSigned = req.cookies.get("cs_invite")?.value;
    const inviteCode = unsign(inviteSigned);
    if (inviteCode) {
      const result = store.consumeInvite(inviteCode, {
        id: user.id,
        login: user.login,
        displayName: user.display_name || user.login,
      });
      if (!result.ok) {
        const res = renderError(
          `That invite is no longer valid (${escapeHtml(result.reason)}). ` +
            `Ask the broadcaster for a fresh one.`,
          403,
        );
        res.cookies.delete("cs_invite");
        return res;
      }
      // Moderator accepted — issue a session, skip the token save
      // (moderators don't replace the broadcaster's Helix identity),
      // and bounce to /admin where the panel will show them their
      // role badge.
      const { sid: modSid, expiresAt: modExpiresAt } = store.createSession(user);
      const res = NextResponse.redirect(`${config.web.publicUrl}/admin`);
      res.cookies.delete(STATE_COOKIE);
      res.cookies.delete("cs_oauth_origin");
      res.cookies.delete("cs_invite");
      res.cookies.set(
        SESSION_COOKIE,
        sign(modSid),
        cookieOpts(modExpiresAt - Date.now()),
      );
      return res;
    }

    return renderError(
      `This CacheStream instance is owned by another Twitch account. ` +
        `Logged-in user <b>${escapeHtml(user.display_name || user.login)}</b> is not authorised. ` +
        `Ask the broadcaster for an invite link if you should have access.`,
      403,
    );
  }

  store.upgradeOwnerFromUser(user);
  const { sid, expiresAt } = store.createSession(user);

  // Persist broadcaster tokens for Helix + chat + EventSub use.
  // We only do this on the owner branch — moderators authenticate
  // with their OWN Twitch identity but their tokens are throwaway,
  // since the broadcaster's tokens are what drive Helix calls.
  store.saveTokens({
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    expiresAt: Date.now() + (token.expires_in - 60) * 1000, // 60s safety buffer
    scopes: token.scope || [],
    twitchUserId: user.id,
    updatedAt: Date.now(),
  });

  // Clear any "refresh token dead" flag set during a previous
  // session — these tokens are fresh and will work.
  markRefreshTokenAlive();

  // Fire-and-forget hook so the chat + EventSub clients can pick
  // up the new tokens immediately rather than wait for first use.
  try { await onTokensRefreshed(); } catch (err) { console.warn("[oauth] post-token hook:", err); }

  // Boot chat + eventsub if this is the first login since startup
  // (bootOnce ran with no tokens → skipped service start). Idempotent
  // so re-logins are safe. Fixes the silent-dead-chat bug where the
  // panel showed everything fine but EventSub was never connected
  // because bootOnce's one-shot flag had already flipped to true.
  try {
    const { startServicesIfReady } = await import("@/lib/boot");
    startServicesIfReady();
  } catch (err) { console.warn("[oauth] service-start hook:", err); }

  // Auto-pull the broadcaster's current stream key from Helix and
  // push it to the streamer. Run async so the redirect to /admin
  // isn't blocked — the result is visible in the Stream Info card
  // by the time the operator gets there.
  //
  // We do this on every callback (login OR re-auth) because the
  // broadcaster may have rotated their key on Twitch since their
  // last login. Fresh key every time = no stale-key surprises.
  if (token.scope?.includes("channel:read:stream_key")) {
    (async () => {
      try {
        const { fetchStreamKey } = await import("@/lib/twitch/helix");
        const { setIngest } = await import("@/lib/twitchIngest");
        const k = await fetchStreamKey(user.id);
        if (k) {
          await setIngest({ streamKey: k });
          console.log("[oauth] auto-fetched stream key from Helix");
        }
      } catch (err) {
        console.warn("[oauth] auto-fetch stream key failed:", err);
      }
    })();
  }

  // If this login originated from the setup wizard, mark setup
  // complete and clear the origin cookie. The /admin redirect
  // below is unchanged either way — the wizard's gate (in
  // /setup/page.tsx) will start sending fresh hits to /admin once
  // it sees `isSetupComplete()` flip true.
  const originSigned = req.cookies.get("cs_oauth_origin")?.value;
  const origin = unsign(originSigned);
  if (origin === "setup") {
    try {
      const { markSetupComplete } = await import("@/lib/settings");
      markSetupComplete();
    } catch (err) {
      console.warn("[oauth] markSetupComplete failed:", err);
    }
  }

  const res = NextResponse.redirect(`${config.web.publicUrl}/admin`);
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete("cs_oauth_origin");
  res.cookies.delete("cs_invite");
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
