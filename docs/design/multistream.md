# Design: Multistream (restream.io-style multi-RTMP output)

Status: **Draft for approval** · Owner: NekoSuneVR · Target: post-1.18

## 1. Goal

Send one encode to **multiple RTMP targets simultaneously** (Twitch + YouTube +
Kick + custom RTMP), the way restream.io does — without N× encoding cost where it
can be avoided, and without dropping the whole stream if one target fails.

## 2. Current state (verified)

- The desktop streamer builds **one** FFmpeg process in
  `apps/desktop/src/desktop-streamer.js:_spawnFFmpeg()` (~L342–432):
  - Input 0: MJPEG frames over stdin (`-f image2pipe -vcodec mjpeg -i -`).
  - Input 1: PCM audio over the local TCP relay
    (`-f s16le -ar 44100 -ac 2 -i tcp://127.0.0.1:<relayOutPort>`).
  - Encode: `buildVideoCodecArgs()` (`apps/desktop/src/streamer/ffmpeg.js:27`),
    AAC audio, CBR.
  - Output: `-f flv -rtmp_live live -flvflags no_duration_filesize <rtmpUrl>`.
- The single target is `${twitch.ingestUrl}/${twitch.streamKey}`
  (`config.js:116`), hot-swappable via `setIngest()` (`desktop-streamer.js:211`)
  which restarts FFmpeg.
- Encoder profile (res/fps/bitrate/preset/codec) comes from
  `autoprofile.js` and can be downgraded live by `thermal.js`.
- FFmpeg binary is a full BtbN/static build (`ensure-ffmpeg.js`) → the `tee`
  muxer is available.
- Stream control: streamer HTTP API (`apps/streamer/src/api.js`) ↔ web
  (`lib/streamer-client.ts`); ingest config persisted in kv via
  `lib/twitchIngest.ts`, edited at `/api/twitch/ingest`.

## 3. Approach

Two viable mechanisms; we'll do **both, in order**, because they serve different
needs:

### 3.1 Phase 1 — FFmpeg `tee` muxer (shared encode) — DEFAULT

One process, one encode, fanned to all RTMP targets. Lowest CPU/RAM; ideal when
every target accepts the same codec/bitrate (the common case: 1080p60 H.264/AAC
to Twitch+YT+Kick).

Replace the single output tail with:

```
-map 0:v:0 -map 1:a:0
-f tee "[f=flv:onfail=ignore:rtmp_live=live:flvflags=no_duration_filesize]URL1|[f=flv:onfail=ignore:...]URL2|..."
```

Key detail: **`onfail=ignore`** per tee output so one dead target doesn't kill the
whole pipeline. We log per-target stderr and surface status in the panel.

Limitations (acceptable for phase 1):
- All targets share the same bitrate/keyframe interval. YouTube wants keyframes
  ≤4s; we already use GOP = 2×fps, so fine.
- No per-target transcode (e.g. a 720p Kick + 1080p Twitch). That's phase 2.

### 3.2 Phase 2 — Per-target processes (independent encodes) — OPTIONAL

For targets needing different settings or hard isolation, spawn one extra FFmpeg
per such target, each reading the **same already-encoded** feed and either
copying (`-c copy`, just remux to that RTMP) or re-encoding to a target-specific
ladder. Driven by a small local relay so the primary encoder writes once.

We avoid duplicating MJPEG decode/encode by having the primary process output the
encoded H.264/AAC to a local endpoint (e.g. `tee` → one branch to a local
`rtmp://127.0.0.1` served by the existing `node-media-server` in
`apps/desktop/src/ingest.js`), and per-target processes pull from there with
`-c copy` (free) or transcode (costly, opt-in).

This reuses the ingest server pattern already in the codebase rather than
inventing a new relay.

## 4. Data model

Generalize the single ingest target into a list. Backward compatible: a missing
list falls back to the existing single Twitch target.

```ts
// persisted in kv as "stream_targets" (JSON)
interface StreamTarget {
  id: string;
  label: string;            // "Twitch", "YouTube", "Kick", "Custom"
  platform: "twitch" | "youtube" | "kick" | "custom";
  ingestUrl: string;        // rtmp(s)://…
  streamKey: string;
  enabled: boolean;
  // phase 2 only:
  mode?: "shared" | "copy" | "transcode";
  transcode?: { heightP: number; bitrateKbps: number };
}
```

- `config.js`: `twitch: { streamKey, ingestUrl }` stays as the implicit default
  target; new `targets: StreamTarget[]` added.
- `setIngest()` becomes `setTargets(targets[])`; building the tee output iterates
  `targets.filter(t => t.enabled)`. Changing targets hot-restarts FFmpeg exactly
  like today's key change.
- Stream keys are secrets — mask in API responses (first5+last4) exactly like
  `twitchIngest.ts` does now; never log full URLs (the safeUrl pattern already
  exists).

## 5. UI

New "Multistream" card in the panel (likely under Status or a new Outputs tab):

- List of targets with enable toggles, label, platform, ingest URL, masked key,
  per-target live status dot (connected / error / disabled).
- "Add target" with platform presets (Twitch/YouTube/Kick fill the ingest URL;
  custom is freeform `rtmp(s)://`).
- Validation reuses the existing `^rtmps?://` check
  (`api/twitch/ingest/route.ts:51`).
- Auto-fill: if a platform is linked via the multi-platform account work
  (`multi-platform-accounts.md`), offer to pull its ingest URL/key automatically
  (Twitch already supports key fetch via Helix; YouTube via the broadcast's
  stream; Kick via their API).

## 6. Failure handling & limits

- Per-target `onfail=ignore` (phase 1) + per-target reconnect (phase 2).
- Panel surfaces each target's last error from FFmpeg stderr (parse the
  `[tee @ …]` / per-output lines).
- **Upload bandwidth is the real ceiling**: N targets × bitrate must fit the
  user's uplink. Show an estimated total egress (sum of enabled targets'
  bitrate) and warn past a threshold. This matters most for IRL/home uplinks.
- Thermal/auto-profile downgrades apply to the shared encode (phase 1) and thus
  to all targets uniformly — document this.

## 7. Staged rollout

1. **Data model + single→list refactor** — `targets[]` in config/kv, default
   derived from existing Twitch target. No UI yet, no behavior change.
2. **Tee output** — build the tee string from enabled targets; `onfail=ignore`;
   per-target stderr parsing → status. Hot-restart on change.
3. **Multistream UI** — targets CRUD + status dots + egress estimate.
4. **Account auto-fill** — pull ingest creds from linked platforms (depends on
   `multi-platform-accounts.md`).
5. **Phase 2 per-target encodes** — only if users need divergent ladders.

## 8. Open questions

- Do we cap target count (e.g. 5) to protect uplink/CPU? (Proposed: soft warn,
  no hard cap.)
- Should the embedded ingest server double as the phase-2 fan-out relay, or a
  dedicated lightweight relay? (Lean: reuse ingest server.)
- SRT/HLS outputs later? (Out of scope; tee already supports other muxers if
  needed.)
