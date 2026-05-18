# Changelog

## 1.7.1

Fixes the boot-loop introduced by v1.7.0's `.env` slim-down.

- **`INTERNAL_API_TOKEN` is now actually auto-generated**.
  v1.7.0 docs claimed it was, but `config.js` still required it
  via `required()` and the streamer crash-looped on every fresh
  deploy.
- Both containers' entrypoints now bootstrap the token via a
  shared file at `/app/audio/.internal-api-token`:
  - **Web container** writes the token (from `.env`, an existing
    file, or freshly generated) and exports it to its own env
    before exec'ing Node.
  - **Streamer container** waits up to 30 s for the file to
    appear, reads it, exports to env, then starts Node.
- If `INTERNAL_API_TOKEN` is set in `.env`, both containers
  honour it as before — no behaviour change for pinned deploys.

If you saw `streamer failed to start: Missing required
environment variable: INTERNAL_API_TOKEN` after upgrading to
1.7.0, rebuild with 1.7.1 and it'll just work.

## 1.7.0

The "you should never have to touch .env again" release.

### Setup wizard

- New first-run wizard at **`/setup`**. Fresh deploys with no
  config automatically redirect there from `/` and `/admin`.
- Three steps: PUBLIC_URL preflight, Twitch developer app
  (client id + secret, with copy-paste-friendly OAuth redirect),
  and login. The wizard self-resumes where you left off if
  interrupted between steps.
- `SESSION_SECRET` is auto-generated on first boot — no more
  `openssl rand -hex 48` ritual.
- Setup state is persisted to SQLite (kv) so a container restart
  doesn't re-trigger the wizard.

### Twitch stream key — pulled from OAuth, not pasted

- New `channel:read:stream_key` scope on the OAuth login.
- On every successful login, the panel auto-fetches the current
  stream key via Helix and hot-loads it into the streamer. No
  more `.env` editing when you rotate the key on Twitch.
- "Fetch from Twitch" button in Stream Info → Stream key & ingest
  for manual refresh after a Twitch-side rotation.

### Real "are we live on Twitch" check

- New `GET /api/twitch/live` route polls Helix `GET /streams` for
  the broadcaster's actual public live status.
- Status badge is now three-state:
  - 🟢 **LIVE on twitch** — encoding + ingest accepted + Helix
    confirms the channel is visible.
  - 🟡 **encoding · waiting for twitch** — pushing bytes, ingest
    ACK'd, but Helix doesn't see the channel yet (propagation
    or silent reject).
  - 🔴 **running · not on twitch** — FFmpeg pushing, Twitch
    silently rejected at the RTMP layer (wrong key, duplicate
    session).
- Twitch viewer count + title surface as additional metrics when
  live.

### `.env` slimmed down

The example file is now ~30 lines. Only `PUBLIC_URL` is truly
required pre-wizard. Everything else has been moved to the panel:
OAuth credentials, session secret, stream key, ingest URL, all
encoder knobs, runtime behaviour.

Existing v1.6 `.env` deployments keep working unchanged — the
settings layer cascades `kv → .env → default`, so anything you
had in `.env` before is still picked up.

### Migration from v1.6

1. Pull v1.7.0, rebuild containers.
2. If your `.env` has `TWITCH_CLIENT_ID` set, the wizard is
   automatically considered complete and you go straight to
   `/admin` as before.
3. If you want the fresh-install experience: delete the OAuth
   vars from `.env`, restart the web container, visit `/` — the
   wizard will walk you through it.
4. To re-run the wizard later (e.g. rotate the dev app secret),
   visit `/setup?force=1`.

## 1.6.0

A reliability + portability release. Boots clean on a Raspberry
Pi (where v1.5 was failing), auto-tunes encoder settings per
host, ships pre-built multi-arch images, and exposes the stream
key in the dashboard so you never have to edit `.env` to rotate
it.

### Headline features

- **Auto-adaptive CPU profile** — detects the host and picks
  resolution / bitrate / codec / preset automatically.
- **Pi 4 / Pi 5 / weak-ARM aware** — Pi 5 specifically skips the
  dead V4L2 H.264 encoder block (BCM2712 has no HW H.264). Pi 4
  uses `h264_v4l2m2m` when available.
- **Hardware encoder probing** — NVENC / QSV / V4L2 M2M /
  VideoToolbox auto-selected when present. Runtime fallback to
  `libx264` if the HW path errors out.
- **Thermal monitor** — Pi-style hosts auto-throttle to a safe
  profile if CPU temp > 80°C, restore on cool-down.
- **Twitch ingest health signal** — Status badge now goes red
  `RUNNING · NOT ON TWITCH` if FFmpeg never sees the RTMP
  handshake confirmation, instead of falsely showing green.
- **Stream key + ingest URL in the dashboard** — Stream Info →
  Stream key & ingest. Hot-restarts FFmpeg on save (~5 s
  reconnect, no container restart, no `.env` edit).
- **Two-FIFO music architecture** — silence carrier on a
  dedicated FIFO + real music on a second, both `amix`-ed by the
  streamer. Track changes no longer interrupt the broadcast.
- **Pre-built multi-arch images** on GitHub Container Registry
  (`amd64` + `arm64`). Skip the local build with the new
  `docker-compose.ghcr.yml` overlay.
- **Examples directory** — copy-paste templates for three scenes
  (countdown poster, now-playing card, chat leaderboard) and two
  games (`!8ball`, full-stack reaction race).

### Fixed

- **`mkfifo: Permission denied` on the audio FIFO** — the shared
  `/app/audio` volume was racing chowns between the web (`nextjs`)
  and streamer (`streamer`) entrypoints. Now both just `chmod
  0777` the IPC dir (it only contains named pipes).
- **FFmpeg reconnect loop on track changes** — single-FIFO design
  killed/restarted the writer on every track, briefly producing
  EOF on the streamer's read side. Twitch saw "audio stream
  ended" and dropped the connection. Two-FIFO split (silence
  carrier + music writer) eliminates the EOF window entirely.
- **`MaxListenersExceededWarning`** — screencast handler attached
  a no-op `drain` listener on every backpressured write. Removed.
- **Stream key leaking into logs** — FFmpeg's stderr echoed the
  full RTMP URL on errors. Now redacted via stderr-side string
  replacement.

### Auto-adaptive encoding

`STREAM_PROFILE=auto` (the new default) detects the host on boot:

| Detected host       | Resolution | FPS | Codec choice                                  | Bitrate       |
|---------------------|-----------:|----:|-----------------------------------------------|--------------:|
| Raspberry Pi 4      | 720p       | 30  | `h264_v4l2m2m` (HW) → libx264 ultrafast       | 2800–3500 kbps |
| Raspberry Pi 5      | 720p       | 30  | libx264 ultrafast (no HW H.264 on BCM2712)    | 2800 kbps     |
| Weak ARM (≤4 cores) | 720p       | 30  | libx264 ultrafast                             | 3000 kbps     |
| 1–2 core x86        | 720p       | 30  | libx264 veryfast                              | 3500 kbps     |
| 4–8 core x86        | 1080p      | 30  | libx264 veryfast (zerolatency)                | 4500 kbps     |
| 12+ core x86        | 1080p      | 60  | libx264 medium (no zerolatency)               | 6000 kbps     |

Explicit env vars (`STREAM_WIDTH`, `STREAM_VIDEO_CODEC`, etc.)
still win over the auto pick.

### Pre-built images on GHCR

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Multi-arch (`amd64` + `arm64`) built on every `v*` tag by
`.github/workflows/release.yml`. Pin a version with
`CACHESTREAM_VERSION=1.6.0`.

### Status surface

The Status tab now shows:
- **Codec** — what the streamer is actually encoding with
- **Auto-profile** — picked category + host signature
- **CPU temp** — live temperature, red when thermally throttled
- **`RUNNING · NOT ON TWITCH`** — when FFmpeg is fine but Twitch
  rejected the handshake (wrong key, duplicate stream session)

### New API endpoints

- `GET /api/twitch/ingest` — returns masked key + ingest URL +
  source (kv override vs `.env` fallback)
- `PATCH /api/twitch/ingest` — set / clear key + URL, pushes to
  streamer over RPC, hot-restarts the broadcast

Plus a new streamer RPC endpoint `POST /ingest` for runtime
credential updates without container restart.

### Examples

New `examples/` directory ships drop-in templates so newcomers
don't have to read the whole codebase to make their own:

- `examples/scenes/` — countdown poster, now-playing card, chat
  leaderboard
- `examples/games/8ball/` — minimal command-response (the
  smallest possible chat game)
- `examples/games/reaction/` — full-stack reaction race with
  schema migration, engine, three API routes, SSE, and a scene

### Migration from 1.5

`docker compose build && docker compose up -d` is the whole
upgrade. No DB migrations beyond what the schema runner does
automatically. Your existing `.env` continues to work — auto-
profile honours explicit overrides if set, falls back to host
detection otherwise.

If you want the auto-picked values to actually show up in your
logs, blank out the encoder-related `STREAM_*` env vars:

```bash
sed -i 's/^STREAM_WIDTH=.*/STREAM_WIDTH=/'         .env
sed -i 's/^STREAM_HEIGHT=.*/STREAM_HEIGHT=/'        .env
sed -i 's/^STREAM_FPS=.*/STREAM_FPS=/'              .env
sed -i 's/^STREAM_VIDEO_BITRATE=.*/STREAM_VIDEO_BITRATE=/'   .env
sed -i 's/^STREAM_VIDEO_MAXRATE=.*/STREAM_VIDEO_MAXRATE=/'   .env
sed -i 's/^STREAM_VIDEO_BUFSIZE=.*/STREAM_VIDEO_BUFSIZE=/'   .env
sed -i 's/^STREAM_PRESET=.*/STREAM_PRESET=/'        .env
sed -i 's/^STREAM_X264_THREADS=.*/STREAM_X264_THREADS=/'     .env
sed -i 's/^STREAM_X264_TUNE=.*/STREAM_X264_TUNE=/'           .env
docker compose restart streamer
```

## 1.5.0

Scenes get a real story — every broadcast staple is now a real
Next.js route, the operator can author their own from the panel,
and a unified branding store keeps name + logo + colour consistent
across every surface.

### Added

**Built-in scenes**
Four new full-screen routes ship out of the box, all sharing a
cyberpunk frame, optional background image, and the operator's
branding ribbon:
- `/scene/starting-soon` — animated standby with optional ISO
  countdown via `?at=YYYY-MM-DDTHH:MM:SSZ`.
- `/scene/brb` — calm "be right back" intermission card.
- `/scene/ending` — off-air thank-you with optional social handles
  (Twitch / YouTube / X / Discord) passed via query params.
- `/scene/offline` — neutral idle fallback.

Each accepts `?title=`, `?subtitle=`, `?accent=`, `?bg=` overrides,
so they double as one-shot URLs (no DB row needed for quick swaps).

**Custom scene builder**
- New **Scenes** admin tab.
- Template builder with five layouts: *Starting Soon*, *BRB*,
  *Ending*, *Generic*, *Raw HTML / CSS*.
- Each scene gets a URL-safe slug; served at `/scene/custom/<slug>`.
- Per-template field set: title / subtitle / accent / background /
  countdown / social row / inline HTML+CSS.
- Edit + delete + "Save as preset" + "Copy URL" + "Open preview"
  from one place. Slug collisions auto-suffix on create.
- Raw HTML is the escape hatch — anything Chromium can render,
  scoped to the owner.

**Shared scene primitives**
`apps/web/src/app/scene/_shared/`:
- `SceneFrame.tsx` — full-bleed shell (animated grid, scanlines,
  radial wash, brand ribbon, corner footer). Drives every built-in
  + custom scene from a single source.
- `Countdown.tsx` — clamped wall-clock countdown card.
- `SocialRow.tsx` — conditional handle pills.
- `scene-base.css` — accent-aware CSS custom properties so a single
  `accent` value retints glows / borders / countdown digits.

**Branding (logo + name + colour, everywhere)**
- New **Branding** admin tab.
- Streamer display name, tagline, accent colour, and logo upload
  (PNG / JPG / WEBP / SVG / GIF, up to 4 MB).
- Stored in the existing kv table; logos live under
  `<DATA_DIR>/branding/` and serve from `/api/branding/logo` with
  a cache-busted version param.
- Surfaces:
  - Every built-in + custom scene's top-left ribbon.
  - The public landing page (logo + display name + tagline +
    accent-tinted gradient and primary button).
  - The admin panel header.
- Inline preview frame in the Branding tab so changes are visible
  before saving.

**Public + auto-seeded scene presets**
On first 1.5 boot, the eight built-in scene URLs are seeded into
`scenes` so they appear in the Studio + Status dropdowns without
manual entry. Deleting a preset is sticky — restarts don't
recreate it.

### Schema

- v4 migration: `custom_scenes` table (`id`, `slug`, `name`,
  `template`, `config_json`, timestamps). Runs automatically.

### API

```
GET    /api/scenes/custom
POST   /api/scenes/custom              { name, template, slug?, config }
GET    /api/scenes/custom/:id
PATCH  /api/scenes/custom/:id          { name?, slug?, template?, config? }
DELETE /api/scenes/custom/:id

GET    /api/branding                   (public — scenes need it)
PATCH  /api/branding                   { displayName?, tagline?, accent? }
GET    /api/branding/logo              (public stream of the logo)
POST   /api/branding/logo              multipart file upload
DELETE /api/branding/logo
```

### Notes

- Updating branding doesn't restart the broadcast — existing
  scenes pick up the new logo / name / accent the next time the
  scene URL is loaded by the streamer (e.g. on **Take** in Studio
  or a scene switch from Status). For an immediate refresh, hit
  **Restart** on the Status tab.

## 1.4.0

Studio gets a real editor; Music gets uploads, tags, cover art, a
radio-style scene; VODs (pre-recorded video) are now a first-class
broadcast source.

### Studio mode — full rewrite

The v1.3 side-by-side mini-iframes were an eyesore. v1.4 swaps to:

- **Single large preview canvas** with proper letterboxing.
- **Small floating Program (live) thumbnail** in the bottom-right so
  you always see what's actually broadcasting.
- **Sidebar** with categorised layer-adding buttons, a layer list
  with selection state, and a per-layer inspector (text/HTML/source +
  x/y/width/height numeric inputs).
- **Resolution + zoom badge**, optional **Grid** and **Thirds**
  overlay toggles for composition.
- **Selection state** — clicking a layer shows the resize handle and
  highlights it on the canvas; clicking the empty canvas deselects.
- Empty-state copy guides first-time users to the bundled scenes
  (`/scene`, `/scene/pet`, `/scene/datacenter`, `/scene/music`).

### Music — uploads, tags, cover art, radio scene

- **Upload from the panel** — drop MP3 / FLAC / OGG / WAV / OPUS up
  to 200 MB each. Files land in `./media/music`.
- **`music-metadata` tag parser** runs on upload and rescan: title /
  artist / album / duration pulled from ID3 / Vorbis / FLAC tags;
  embedded cover art extracted into `./data/covers/`.
- **Per-track edit** — title, artist, album editable inline in the
  Music tab. Manually-edited tracks are marked `edited` and won't be
  clobbered by future rescans.
- **Per-track delete** — removes the DB row and the file.
- **Now-playing cover thumbnail** in the Music tab + a track list
  with cover thumbnails for everything in the library.
- **New `/scene/music` scene** — radio-station style display with:
  - Large album art + spinning vinyl decoration
  - Track title / artist / album
  - Real audio visualiser (Web Audio AnalyserNode on the same file
    the streamer is broadcasting — synced within ~200 ms). Falls back
    to procedural bars for radio mode (CORS blocks real analysis).
  - Live clock, station label, ON-AIR badge.

### VODs — pre-recorded broadcast

A whole new broadcast mode parallel to the live-scene pipeline.

- **VOD tab** in the admin panel.
- **Upload** MP4 / MOV / MKV / WEBM / M4V (up to 4 GB per file via
  the panel; for larger files, SFTP into `./media/vods` then click
  **Scan dir**).
- **Add remote URL** for any HTTP(S) / RTMP source FFmpeg can ingest.
- **Per-VOD edit + loop + delete.**
- **Play** swaps the broadcast off the Chromium scene pipeline and
  spawns a dedicated FFmpeg streaming the file/URL directly to
  Twitch (no Chromium round-trip). **Stop** returns to the scene.

### Schema

- v3 migration: `music_tracks.album`, `music_tracks.cover_path`,
  `music_tracks.manual` columns added (defensive, idempotent).
- New `vod_sources` table.

### Compose / volumes

- `./media/music` is now mounted **read-write** so panel uploads work.
- New `./media/vods` mount — read-write on web (uploads + delete),
  read-only on streamer (playback).
- The streamer container gets the same `/app/media/vods` path so the
  web container can hand it a resolved file path safely.

### Dependencies

- `music-metadata@^7.14` added to the web container. Pinned at v7
  (CJS) because v8+ is ESM-only and adds friction with Next's
  standalone output.

## 1.3.0

UI + games + CPU optimisation pass. No new external services.

### Added

**Studio mode**
- New **Studio** tab in the admin panel: side-by-side preview /
  program with iframe stages scaled to 32% (~614×346 of the
  1920×1080 stage).
- **Moveable overlays** — drag/resize layers directly on the
  preview. Numeric positions (top/left/width/height in px) are
  persisted back into the overlay set's JSON.
- **Take → Program** button atomically switches the live scene
  + applies the draft overlay set. If no set is selected, the
  draft saves as a new "Studio draft" set on the fly.

**AI Pet creature** (`/scene/pet`)
- Persistent creature with 6 stats (hunger, happiness, energy,
  intelligence, aggression, morality), age in minutes, evolution
  tier (4 tiers: Datablob → Loglurker → Cachewyrm → Stackwraith).
- Tick loop (15s) drifts personality back toward 50, drains
  hunger/energy, triggers evolutions when intelligence crosses
  thresholds.
- Chat commands: `!feed`, `!pet`/`!pat`, `!play`, `!sleep`,
  `!teach <word>` (mod-only), `!insult`/`!hit`.
- Cyberpunk creature scene with animated bobbing, evolving eye
  colour per tier, mood label derived from stats, and a live
  feed of recent mutations.

**Twitch Plays Datacenter** (`/scene/datacenter`)
- NOC-aesthetic management sim: servers, power, coolant,
  temperature, uptime, attacks, budget, reputation.
- Tick loop (10s) heats up under load, recovers under coolant,
  spawns random cyberattacks, awards budget for healthy uptime.
- Chat commands: `!add-server`, `!defend`, `!cool`, `!power+`,
  `!invest`, `!restart`.
- Live event feed and rack visualisation built straight into
  the scene; no extra widgets needed.

**Admin Games tab**
- Live stats for both games, rename pet, reset either game.

### CPU optimisation

Streamer hot path reworked to spend less encoder time per frame.
Typical 1080p30 install drops ~15-25% CPU at default settings.

- **Smaller filter graph** — dropped the redundant
  `format=yuv420p` step (covered by `-pix_fmt yuv420p`),
  switched scaler from `bicubic` to `bilinear` (visually
  identical when in/out match; ~2-3× cheaper otherwise).
- **Lower screencast JPEG quality** — Chromium → FFmpeg JPEG
  pipe now defaults to quality 70 (was 80). Less encode +
  decode CPU; identical perceived quality after H.264.
- **New env knobs**:
  - `STREAM_X264_THREADS` — pin x264 worker count (0 = auto)
  - `STREAM_X264_TUNE` — override or clear `-tune zerolatency`
  - `STREAM_SCREENCAST_QUALITY` — Chromium JPEG quality (1-100)
  - `STREAM_CAPTURE_EVERY_NTH` — drop frames on capture (e.g.
    set to 2 if you only need 30fps from a 60fps scene)
- **Slower admin polling** — status tab cadence 3s → 5s.
- **Schedule scenes that aren't in use** so Chromium can paint
  cheap scenes when no one's watching the heavy ones.

### Schema migrations

- `pet_state` + `datacenter_state` tables added. Migration runs
  automatically on first 1.3 boot.

### Files of note

```
apps/web/src/lib/games/{pet,datacenter}.ts   tick loops + chat hooks
apps/web/src/app/scene/{pet,datacenter}/     scene routes (1920×1080)
apps/web/src/app/admin/tabs/StudioTab.tsx    moveable overlay editor
apps/web/src/app/api/games/**                game APIs + SSE
apps/streamer/src/{config,stream}.js         CPU tuning knobs
```

## 1.2.0

Tier-A platform release. Everything new sits on top of the
v1.1 streamer + control panel.

### Added

**Twitch API foundation**
- Broadcaster OAuth tokens are persisted and auto-refreshed (60s
  safety buffer). Stored in SQLite, never returned to the browser.
- Expanded OAuth scopes:
  `user:read:email`, `channel:manage:broadcast`,
  `channel:read:subscriptions`, `bits:read`,
  `moderation:read`, `moderator:manage:banned_users`,
  `moderator:manage:chat_messages`, `moderator:read:followers`,
  `chat:read`, `chat:edit`.
- The chat status banner detects missing scopes from a stale
  token and offers a one-click re-authorize link.
- Helix API client with channel info, category search, stream
  lookup, chat deletion, ban/timeout.

**Stream info management**
- New **Stream Info** tab — edit title, category (debounced
  Twitch category search), tags, broadcaster language. Shows
  live viewer count when broadcasting.

**Chat (read + write + auto-reply)**
- Long-lived Twitch IRC client over WebSocket. Hand-rolled
  parser, auto-reconnect with exponential backoff, IRC PING/PONG.
- **Chat** tab: connection state badges, live message feed (SSE),
  message composer.
- `/api/chat/stream` (SSE) is reachable without auth so overlay
  iframes can subscribe inside the headless browser.
- `/widgets/chat` — drop-in chat overlay widget; add as a `chat`
  overlay layer with `src=http://web:7788/widgets/chat`.

**Custom commands + AutoMod**
- Per-trigger cooldowns, mod-only / sub-only flags, response
  templating: `{user}`, `{channel}`, `{arg1}`…`{args}`.
- AutoMod rules with `contains` / `startswith` / `regex` matching
  and `delete` / `timeout` / `ban` actions.
- **Commands / AutoMod** tab with both editors.

**EventSub alerts**
- WebSocket EventSub client. Subscribes to follow, sub, gift,
  resub, cheer, raid on session welcome. Handles `session_reconnect`
  hand-off cleanly.
- **Alerts** tab — live feed of incoming events.
- `/widgets/alert` — drop-in alert popup widget; add as an `alert`
  overlay layer.

**Music / Radio**
- Local library: drop MP3/OGG/FLAC/WAV/OPUS into `./media/music`
  on the host, click Rescan in the panel.
- Internet radio: any Icecast/Shoutcast URL or direct stream URL.
  Save as named presets.
- Volume control, loop, shuffle.
- Audio is mixed into a shared named pipe (`/app/audio/mix.fifo`)
  that the streamer's FFmpeg consumes. Music changes never
  interrupt the video stream.
- Silent fallback (`anullsrc`) is `amix`-merged with the FIFO so
  the broadcast always has an audio track, even with nothing
  playing.

### Changed

- **Persistence** moved from `data/state.json` to SQLite
  (`data/cachestream.db`). One-shot migration runs on first 1.2
  boot — the JSON file is read, copied, and renamed to
  `state.json.migrated-<timestamp>`. Safe to leave in place;
  remove once you've confirmed the new DB has your data.
- Admin panel split into tabs: **Status / Stream Info / Chat /
  Commands & AutoMod / Alerts / Music**. The v1.1 sections
  (presets, overlays, scheduler) all live under **Status**.
- Overlay types expanded: `text`, `html`, `image`, `chat`, `alert`.
  `chat` and `alert` overlays inject an `<iframe>` so widget JS
  runs in isolation.

### Dependencies

- Added: `better-sqlite3`, `ws` (+ `@types/*` dev deps).
- The web container now includes `ffmpeg` for the music encoder.

### Migration notes

If you're upgrading from 1.1:

1. `git pull && docker compose build`.
2. Run `docker compose up -d`. The SQLite migration runs once;
   you'll see a `[db] migrated state.json → SQLite` line in the
   web container logs.
3. Visit `/admin` and click **Re-authorize** (the chat status
   banner will prompt you) so the new OAuth scopes are granted.
4. Optional: create `./media/music` on the host and drop some
   tracks in.

The new audio FIFO is created automatically on streamer boot.

## 1.1.0

- Initial split into `apps/web` (Next.js) + `apps/streamer`
  (Puppeteer/FFmpeg worker).
- Twitch OAuth (first-login-wins) with HMAC-signed cookies.
- Control panel: live status, scene presets, overlay sets,
  minute-resolution scheduler.
- Cyberpunk Hello World scene at `/scene`.
