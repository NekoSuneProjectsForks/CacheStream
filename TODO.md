# CacheStream — Roadmap / TODO

Working notes for the in-progress feature work. Build/test is done by the
user via `test.bat` (desktop debug) and by GitHub Actions on tag. Do **not**
`git push` or `git tag` until told.

---

## ✅ Done (music visualizer overhaul)

- [x] **FPS fix** — no per-frame canvas realloc, cached gradient + analysis
      buffers, removed per-frame `drop-shadow` filter, configurable FPS cap,
      DPR clamp. (`scene/music/page.tsx`)
- [x] **Selectable layouts** — Bars, Mirror, Waveform, **Trap Nation**
      (filled radial blob + bass pulse), **NCS** (thin glowing wobbling ring),
      **Monstercat** (rounded bottom bars + baseline). Old `circular` → Trap
      Nation alias.
- [x] **Circular concentric alignment** fix (cover ring pinned to canvas centre).
- [x] **Hydration error** fix (`<style>` via `dangerouslySetInnerHTML`).
- [x] **Beat FX** — beat-reactive flash overlay + screen shake (toggleable),
      driven imperatively in the render loop.
- [x] **Custom background** — upload PNG/JPG/WebP/GIF or paste URL; clear;
      defaults to built-in gradient; live (~5s). (`api/music/background`)
- [x] **Self-healing album art** — robust `format`→ext mapping + on-demand
      re-extraction in `api/music/cover/:id`.
- [x] **Visualizer moved to its own admin tab** with a live preview iframe.
      (`tabs/VisualizerTab.tsx`, registered in `AdminPanel.tsx`)
- [x] **test.bat** → builds web bundle + launches desktop app in debug
      (`CS_DEVTOOLS` env gate in `window.js`).
- [x] **Repo-derived app name (no hardcoded "CacheStream")** — `scripts/app-meta.mjs`
      resolves productName/appId/publish owner+repo/npm-slug in order:
      explicit override → `GITHUB_REPOSITORY` (CI) → git remote → CacheStream
      default. `scripts/eb.mjs` feeds them to `electron-builder.yml` via
      `${env.*}`, injects the packaged npm `name` via
      `-c.extraMetadata.name=<slug>` (source package.json files untouched),
      and writes `src/app-name.json` for the runtime title (`src/app-name.js`,
      used by window/tray/error/updater). Workflow artifact name + installer
      names + updater URL all follow the repo. Data dir follows via Electron's
      app name. (`app-name.json` gitignored.)
- [x] **Default = GitHub repo name, else hardcoded CacheStream** — no committed
      env file involved in the default. An optional gitignored
      `apps/desktop/.env` can set `APP_NAME`/`GH_OWNER`/`GH_REPO`/`APP_ID` to
      override for local `npm run dist`; CI derives from the repo
      automatically.

- [x] **Web + streamer follow the name too** — desktop passes `APP_NAME`
      (resolved name) into the web server env; the web reads it via
      `lib/app-name.ts` for the default branding name + panel/scene `<title>`
      (default CacheStream). `build-web.mjs` renames the staged web bundle's
      `package.json` name to `<slug>-web`. Streamer has no package.json / no
      hardcoded name (synced into desktop), so it's covered by the desktop
      build.

> Note: the SOURCE `package.json` `name` fields stay as static npm
> identifiers (JSON can't read env; rewriting tracked files at build is
> dirty). The SHIPPED apps follow the repo — desktop via `extraMetadata`,
> web via the staged-package rename + runtime `APP_NAME`. A few pre-auth
> client strings (LoginGate/SetupWizard wordmark, music-scene station
> flavor) stay literal "CacheStream" to avoid hydration churn.

## ✅ Visualizer iteration 2
- [x] **NCS** rebuilt as the **glowing orb** (Roonil/NCS_Spectrum_GLava look):
      5 additively-blended smooth mirror-symmetric circular waveforms at
      staggered radii/rotation → luminous translucent sphere with bloom, no
      centre cover. (Went cover-ring → wireframe-globe → orb.)
- [x] **Trap Nation** (stelabouras/cloudnation look): cover-centred smooth
      blob — neighbour-averaged bins + slow spin + bloom passes + bass pulse.
- [x] **Beat flash** moved BEHIND the spectrum/cover/text (z-index:-1) so it
      pulses the **background only**, never washing the whole scene.
- [x] **Beat is bass-driven** — peak of the sub-bass/kick band (FFT bins 0–5)
      fires the flash/shake on the drum.
- [x] Stable `<main>`/`<audio>` so changing layout no longer stops music or
      freezes the spectrum.
- [x] **Background scrim + beat = background flash** — a dark scrim
      (opacity 0.45) over the background keeps the now-playing text legible;
      the beat now LIFTS the scrim (background brightens) instead of an
      accent wash. Tuned LIGHT + frequent: fires on most bass hits but only
      a small dip (~0.20) + subtle shake (≤5px), kept gentle / less
      photosensitive on purpose.

## ✅ Visualizer iteration 3
- [x] **Scene Overlays card buttons** (Branding tab) — were unstyled because
      styled-jsx only scopes to the declaring component, not the child
      `<Row>`. Switched to `<style jsx global>` namespaced under
      `.overlay-grid`; corner picker is now a polished 2×2 grid + proper
      toggle switch. (`tabs/OverlayConfigCard.tsx`)
- [x] **Preview audio in dev** — the scene is silent for the broadcast
      (ffmpeg audio only); opening it with `?preview=1` plays audio audibly.
      The Visualizer-tab preview iframe uses `?preview=1` so you can hear the
      music while testing; the streamer's scene URL has no param → stays
      silent.

## ✅ Visualizer iteration 4
- [x] **Vinyl default OFF** (the "unknown circle" — its grooves are concentric
      rings); still toggleable.
- [x] **Background controls** — dim (scrim 0–85%), blur (0–20px), fit
      (cover/contain/tile) in the Visualizer tab.
- [x] **Beat strength slider** (0.3–1.5×) scaling the flash dip + shake.
- [x] **NCS now-playing text** dropped to a lower-third so it doesn't overlap
      the orb.

## 🔜 Visualizer follow-ups (nice-to-have)
- [ ] Confirm Trap Nation against a reference clip (user to provide) — current
      is the canonical Specterr/cloudnation look; tune amplitude/bloom if needed.
- [ ] NCS orb: optional cover-as-globe-texture.
- [ ] Per-layout default tuning pass once eyeballed in the desktop app at 1080p/60.
- [ ] Optional: more layouts (mirrored waveform, dual-ring, bar+ring combo).
- [ ] Confirm album-art repro file from user if any embedded cover still fails.

---

## Studio overlay features

- [x] **Now Playing** overlay layer — new `nowplaying` overlay type + a
      `/widgets/nowplaying` page reusing `scene/_shared/NowPlaying.tsx`; wired
      into StudioTab (add button, label, icon) and the streamer overlay
      injector (`desktop-streamer.js`).
- [x] **Safety / Disconnect screen** — `lib/ingest-watcher.ts` polls the RTMP
      `/stat`; when a previously-live publisher drops it auto-switches the
      program to a chosen safety scene and restores on reconnect (conservative:
      only after a real drop, respects manual scene changes). Config via
      `/api/safety` + a "Safety on ingest drop" card in the Studio tab; watcher
      started from `boot.ts`.
- [ ] Gaming/IRL/Music helper overlays (countdown, BRB, social row presets,
      stream stats) — **deferred** (vague; several `scene/_shared/*` already
      exist as full scenes — decide whether to expose as overlay layers vs
      scene presets).

---

## 🧱 Epic 1 — Multi-platform accounts (Twitch/Kick/YouTube/VPzone)

Design doc: `docs/design/multi-platform-accounts.md` (approved approach:
design-first, staged build).

> **Implemented so far (foundation + Kick, UNTESTED end-to-end — needs a Kick
> app + live channel to verify):** `platform_links` + `platform_tokens` tables
> (`db.ts`) + store methods; `lib/platform/types.ts` (neutral chat/alert
> shapes); Kick OAuth2 PKCE (`lib/oauth/kick.ts` + `/api/auth/kick/login|
> callback`); Kick chat client over Pusher WS publishing to the `chat` bus
> (`lib/platform/kick.ts`) + outbound send fan-out in `/api/chat/send`; Kick
> webhook → `alerts` bus (`/api/kick/webhook`, RSA-verified); Connections admin
> tab (link/unlink Kick, enter Kick app creds; YouTube/VPzone "coming soon");
> `kick_client_id/secret` settings; Kick client started in `boot.ts`.

- [x] Stage 1: `platform_links` + `platform_tokens` tables + store methods.
      (Owner `account` table + Twitch-singleton migration shim still TODO.)
- [~] Stage 2: extract `lib/platform/twitch.ts` from `eventsub.ts`/`chat.ts`;
      normalize bus events with `platform`/`channelId`; platform badge in
      overlays. (Kick already publishes normalized w/ `platform`; Twitch
      extraction + the overlay badge still TODO.)
- [x] Stage 3: Connections UI (link/unlink per platform) — `ConnectionsTab`.
- [~] Stage 4: **Kick** — OAuth2 (PKCE) + Pusher WebSocket chat + webhook
      events + send. CODE DONE (see "Implemented" note above), UNTESTED.
      Remaining: register a Kick app, verify the WS event names / message
      shape against live chat, register the webhook subscription, confirm
      the send payload. Concrete spec (from docs.kick.com + the StreamBOT impl at
      D:\DEV\NekoSuneVRAPPS\Websites\StreamBOT):
      - **OAuth (PKCE, S256)**: authorize `https://id.kick.com/oauth/authorize`
        (`response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`,
        `code_challenge`, `code_challenge_method=S256`); token
        `https://id.kick.com/oauth/token` (`authorization_code` w/
        `code_verifier`; `refresh_token`; `client_credentials` for an app
        token used to send chat). Register app at the Kick "Developer/Apps"
        page for client id/secret.
      - **Scopes**: `user:read channel:read channel:write streamkey:read
        chat:write events:subscribe moderation:ban` (streamkey:read → can pull
        the RTMP key for multistream auto-fill).
      - **Resolve channel → chatroom id**: `GET
        https://api.kick.com/public/v1/channels` (Bearer) → `data[].chatroom.id`
        + `broadcaster_user_id`.
      - **Chat read (Pusher WS)**: `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false`;
        subscribe `{event:"pusher:subscribe",data:{channel:"chatrooms.<id>.v2",auth:""}}`;
        handle events `App\\Events\\ChatMessageEvent` / `chat.message.sent`;
        keepalive on `pusher:ping`; 5s reconnect backoff. Parse content from
        `data.content`→`data.message.content`; sender from
        sender/user/author; badges → isMod/isBroadcaster/isSub/isVip.
      - **Chat send**: `POST https://api.kick.com/public/v1/chat` (Bearer)
        `{content, type:"bot"}` (fallback `{content, type:"message",
        broadcaster_user_id}`); refresh+retry on 401.
      - **Events/alerts (webhook)**: subscribe via `events:subscribe`; receive
        `POST /api/kick/webhook` with headers `kick-event-type`,
        `kick-event-message-id/timestamp`, `kick-event-signature` (RSA-SHA256,
        verify against `GET https://api.kick.com/public/v1/public-key`). Map
        follow / subscription(+gift/renew) / raid / cheer / stream.online|offline.
      - **Moderation**: `POST https://api.kick.com/public/v1/moderation/bans`.
      - Lib: native fetch + `ws` (Pusher protocol by hand, like StreamBOT).
- [ ] Stage 5: **VPzone** — COMING SOON. https://vpzone.tv/api/docs is a JS SPA
      the doc fetcher can't read; need the raw API spec (chat transport, login,
      streamkey, alerts). UI shows a disabled "coming soon" connection until
      then.
- [ ] Stage 6: **YouTube** — COMING SOON (placeholder in UI). OAuth + liveChat
      polling, quota-gated; apply for a quota increase before GA.

## 🧱 Epic 2 — Multistream (restream.io-style multi-RTMP out)

Design doc: `docs/design/multistream.md`.

> **v1 shipped (tee, RTMP, UNTESTED on a live multi-target run):** `targets[]`
> in kv (`lib/multistream.ts`) + `/api/stream/targets`; Multistream admin tab
> (CRUD, enable toggles, masked keys, egress estimate); `desktop-streamer.js`
> fans out via FFmpeg `tee` (`onfail=ignore`) when ≥2 enabled targets, else the
> legacy single output; `setTargets` over the streamer API (`/targets`);
> re-pushed on boot. **Limitation: changing/toggling a target hot-restarts the
> pipeline (all outputs blip together).**

- [x] Stage 1: `targets[]` model in kv. Single-target default unchanged.
- [x] Stage 2: FFmpeg `tee` output w/ `onfail=ignore`; hot-restart on change.
- [x] Stage 3: Multistream UI — targets CRUD, enable toggles, egress estimate.
      (Per-target live status DOTS need Phase 1.5's relay manager.)
- [ ] **Stage 1.5 (NEXT — the requested HOT toggle + protocols):** replace the
      tee path with a shared local relay (`cs-multi` app on the embedded RTMP
      server) + independent per-target `-c copy` relay processes, so a target
      can be turned on/off LIVE without dropping the others. Adds SRT / RTSP /
      mpegts / custom output protocols (RTMP default; WHEP/FTL unsupported by
      FFmpeg). Per-target status dots. Full design in
      `docs/design/multistream.md` §3.1b. Isolated streaming-core change —
      build + test on its own.
- [ ] Stage 4: account auto-fill of ingest creds from linked platforms.
- [ ] Stage 5 (optional): per-target independent ENCODES (different ladders).

---

## Notes / conventions
- Branch: `desktop`. Builds: `test.bat` locally, GitHub Actions on tag.
- Bump version **before** tagging; only push/tag when the user says so.
- `test.bat` is gitignored (`*.bat`).
