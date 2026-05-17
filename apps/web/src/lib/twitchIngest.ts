/**
 * Twitch ingest credentials (stream key + RTMP URL) managed
 * from the dashboard.
 *
 * Storage: existing kv table. Two keys:
 *   - twitch_stream_key
 *   - twitch_ingest_url
 *
 * The streamer container reads its boot defaults from `.env`
 * (TWITCH_STREAM_KEY / TWITCH_INGEST_URL). At runtime the web
 * container pushes the kv overrides to the streamer via the
 * /ingest RPC, which hot-restarts FFmpeg with the new values.
 *
 * That means:
 *   - First boot:        streamer uses .env values until the
 *                        web container pushes its kv on boot
 *                        (or stays on .env if kv is empty).
 *   - Dashboard save:    kv updated, pushed to streamer,
 *                        broadcast reconnects in ~5s.
 *   - Dashboard clear:   kv deleted, pushed to streamer with
 *                        null values → streamer's setIngest
 *                        treats null as "keep whatever you
 *                        already have", so it falls back to
 *                        the .env boot value cleanly.
 *
 * Source labels for the UI:
 *   "kv"  → dashboard override is in effect
 *   "env" → no kv override, streamer is using its .env value
 *           (which we don't actually have visibility into from
 *           the web container — but the streamer's status
 *           endpoint exposes `keyConfigured`, and we display
 *           "set via .env (managed by streamer)" in the UI.
 */

import { kvGet, kvSet, kvDelete } from "./db";
import { streamer } from "./streamer-client";

const KEY_STREAM_KEY = "twitch_stream_key";
const KEY_INGEST_URL = "twitch_ingest_url";

export interface IngestSnapshot {
  /** Dashboard-stored key (kv). Empty string if not set. */
  streamKey: string;
  /** Dashboard-stored ingest URL (kv). Empty string if not set. */
  ingestUrl: string;
  source: {
    streamKey: "kv" | "env-or-unset";
    ingestUrl: "kv" | "env-or-default";
  };
}

export function getIngest(): IngestSnapshot {
  const kvKey = kvGet(KEY_STREAM_KEY) || "";
  const kvUrl = kvGet(KEY_INGEST_URL) || "";
  return {
    streamKey: kvKey,
    ingestUrl: kvUrl,
    source: {
      streamKey: kvKey ? "kv" : "env-or-unset",
      ingestUrl: kvUrl ? "kv" : "env-or-default",
    },
  };
}

/**
 * Persist + push to the streamer. Empty / null values clear the
 * kv entry; the streamer's setIngest then keeps its existing
 * in-memory value (which is whatever .env provided at boot, or
 * whatever was last successfully pushed).
 */
export async function setIngest(input: {
  streamKey?: string | null;
  ingestUrl?: string | null;
}): Promise<IngestSnapshot> {
  if (input.streamKey !== undefined) {
    if (input.streamKey && input.streamKey.trim().length > 0) {
      kvSet(KEY_STREAM_KEY, input.streamKey.trim());
    } else {
      kvDelete(KEY_STREAM_KEY);
    }
  }
  if (input.ingestUrl !== undefined) {
    if (input.ingestUrl && input.ingestUrl.trim().length > 0) {
      kvSet(KEY_INGEST_URL, input.ingestUrl.trim());
    } else {
      kvDelete(KEY_INGEST_URL);
    }
  }

  // Push to the streamer. Passing null tells the streamer
  // "keep your existing value", which is what we want when the
  // operator clears the dashboard override (streamer should
  // fall back to its .env boot value, not to blank).
  const snap = getIngest();
  try {
    await streamer.setIngest({
      streamKey: snap.streamKey || null,
      ingestUrl: snap.ingestUrl || null,
    });
  } catch (err) {
    console.warn("[twitchIngest] failed to push to streamer:", err);
  }
  return snap;
}

/**
 * Called once on web container boot to push the stored kv values
 * (if any) to the streamer. Handles the case where the streamer
 * container restarted and lost its in-memory copy of the runtime
 * override.
 */
export async function pushIngestToStreamer(): Promise<void> {
  const snap = getIngest();
  if (!snap.streamKey && !snap.ingestUrl) return; // nothing to push
  try {
    await streamer.setIngest({
      streamKey: snap.streamKey || null,
      ingestUrl: snap.ingestUrl || null,
    });
  } catch {
    /* streamer may not be ready yet — it'll get pushed next save */
  }
}
