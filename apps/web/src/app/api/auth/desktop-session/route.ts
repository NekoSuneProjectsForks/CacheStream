import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { config } from "@/lib/config";
import { getStore } from "@/lib/store";
import { sign } from "@/lib/cookies";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/desktop-session  (desktop app only)
 *
 * The Electron desktop app can open Twitch login in an EXTERNAL
 * browser. That browser has its own cookie jar, so the session cookie
 * the OAuth callback sets never reaches the app window — only the
 * broadcaster tokens (persisted server-side) carry over. This endpoint
 * lets the app — which holds INTERNAL_API_TOKEN, the same trust level
 * as the streamer — mint an owner session for itself once an owner
 * exists, and inject the resulting cookie into Electron's jar.
 *
 * Hard-gated two ways so it's completely inert in Docker:
 *   1. only responds when DESKTOP=1 (set by the desktop app), else 404
 *   2. requires the INTERNAL_API_TOKEN bearer (never reaches a browser)
 *
 * Returns:
 *   200 { value, expiresAt }  — signed cs_session cookie value
 *   204                       — no owner yet (login not finished)
 */
function tokenOk(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const want = config.streamer.token;
  if (!got || !want) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (process.env.DESKTOP !== "1") {
    return new NextResponse("not found", { status: 404 });
  }
  if (!tokenOk(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const store = getStore();
  const owner = store.getOwner();
  // Require a REAL logged-in owner. A seeded owner (INITIAL_OWNER_LOGIN)
  // has a login but no twitchUserId until they actually complete OAuth —
  // until then there's nothing to hand off, so the app keeps polling.
  if (!owner || !owner.twitchUserId) {
    return new NextResponse(null, { status: 204 });
  }

  const { sid, expiresAt } = store.createSession({
    id: owner.twitchUserId,
    login: owner.twitchLogin,
    display_name: owner.displayName || undefined,
    email: owner.email || undefined,
  });
  return NextResponse.json({ value: sign(sid), expiresAt });
}
