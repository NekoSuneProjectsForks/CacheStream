import { NextRequest, NextResponse } from "next/server";
import { setSetting, isSetupComplete } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * POST /api/setup/oauth-app
 *
 * Persist the Twitch developer app's client id + secret to kv.
 * Reachable WITHOUT an owner session while setup is in progress;
 * once `isSetupComplete()` is true this route 403s so a random
 * visitor can't trash an existing config. Re-running the wizard
 * (via /setup?force=1) re-enables it by going through the panel's
 * authenticated path instead.
 *
 * Empty strings are treated as "leave the existing value" so the
 * operator can update one field at a time.
 */
export async function POST(req: NextRequest) {
  if (isSetupComplete()) {
    return NextResponse.json(
      { error: "setup already complete — use /admin → Settings to update" },
      { status: 403 }
    );
  }

  let body: { clientId?: string; clientSecret?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }

  const cid = (body.clientId || "").trim();
  const sec = (body.clientSecret || "").trim();

  // Sanity: Twitch client ids are 30 chars of base62. We don't
  // enforce strictly (Twitch could change), but reject obvious junk.
  if (cid && /\s/.test(cid)) {
    return NextResponse.json({ error: "client id cannot contain whitespace" }, { status: 400 });
  }
  if (sec && /\s/.test(sec)) {
    return NextResponse.json({ error: "client secret cannot contain whitespace" }, { status: 400 });
  }

  if (cid) setSetting("twitch_client_id",     cid);
  if (sec) setSetting("twitch_client_secret", sec);

  return NextResponse.json({ ok: true });
}
