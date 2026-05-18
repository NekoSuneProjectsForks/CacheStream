import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { fetchStreamKey } from "@/lib/twitch/helix";
import { getStore } from "@/lib/store";
import { setIngest } from "@/lib/twitchIngest";
import { missingScopes } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * POST /api/twitch/ingest/fetch-key
 *
 * Pulls the broadcaster's current stream key from Helix using the
 * OAuth token stored at login. Saves it via the existing
 * twitchIngest path so the streamer hot-restarts with the new
 * value.
 *
 * Returns the standard ingest snapshot. The full key is never
 * echoed back to the browser — only the masked preview.
 *
 * 412 Precondition Failed if:
 *   - the broadcaster never logged in
 *   - the stored token is missing the channel:read:stream_key scope
 *     (the panel should send the user through re-auth in that case)
 */
export const POST = ownerRoute(async () => {
  const store = getStore();
  const tokens = store.getTokens();
  if (!tokens) {
    return NextResponse.json(
      { error: "no broadcaster tokens stored — log in first" },
      { status: 412 }
    );
  }
  const missing = missingScopes(tokens.scopes);
  if (missing.includes("channel:read:stream_key")) {
    return NextResponse.json(
      {
        error: "stored token is missing channel:read:stream_key — re-authorize",
        missingScopes: missing,
      },
      { status: 412 }
    );
  }

  let key: string | null;
  try {
    key = await fetchStreamKey(tokens.twitchUserId);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "helix fetch failed" },
      { status: 502 }
    );
  }
  if (!key) {
    return NextResponse.json({ error: "Twitch returned no key" }, { status: 502 });
  }

  // Stash in kv + push to streamer (this is the same path the
  // manual paste form uses, so the hot-restart behaviour is
  // identical).
  const snap = await setIngest({ streamKey: key });

  return NextResponse.json({
    streamKey: maskKey(snap.streamKey),
    streamKeyLength: snap.streamKey.length,
    ingestUrl: snap.ingestUrl,
    source: snap.source,
    fetched: true,
  });
});

function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 5)}…${"•".repeat(Math.min(k.length - 9, 6))}…${k.slice(-4)}`;
}
