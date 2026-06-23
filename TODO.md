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

## 🔜 Visualizer follow-ups (nice-to-have)
- [ ] Confirm Trap Nation against a reference clip (user to provide) — current
      is the canonical Specterr look; tune amplitude/bloom if needed.
- [ ] NCS sphere: optional cover-as-globe-texture, and reposition the
      now-playing text so it doesn't overlap the sphere bottom.
- [ ] Beat flash: optional intensity slider + color (currently accent, ~0.55 max).
- [ ] Per-layout default tuning pass (amplitude/baseR) once eyeballed in the
      desktop app at 1080p/60.
- [ ] Optional: more layouts (mirrored waveform, dual-ring, bar+ring combo).
- [ ] Optional: background fit modes (cover/contain/tile) + dim/blur slider so
      bright images don't wash out the spectrum.
- [ ] Confirm album-art repro file from user if any embedded cover still fails.

---

## ⏳ Studio overlay features (NOT started — next chunk)

Extend `tabs/StudioTab.tsx` (currently only text/html/image/chat/alert) +
the scene overlay system:

- [ ] **Now Playing** overlay layer (reuse `scene/_shared/NowPlaying.tsx`).
- [ ] **Safety / Disconnect screen** — auto-switch the program scene when the
      RTMP ingest drops. Wire `api/ingest/status` polling → auto-`stream/scene`
      to a "disconnect safety" scene; revert on reconnect. (Ingest scene
      already exists: `scene/ingest/page.tsx`.)
- [ ] Gaming/IRL/Music helper overlays (countdown, BRB, social row presets,
      stream stats — several `scene/_shared/*` pieces already exist; expose as
      Studio layers).

---

## 🧱 Epic 1 — Multi-platform accounts (Twitch/Kick/YouTube/VPzone)

Design doc: `docs/design/multi-platform-accounts.md` (approved approach:
design-first, staged build).

- [ ] Stage 1: owner `account` + `platform_links` + `platform_tokens` tables +
      migration shim from the Twitch singletons.
- [ ] Stage 2: extract `lib/platform/twitch.ts` from `eventsub.ts`/`chat.ts`;
      normalize bus events with `platform`/`channelId`; platform badge in
      overlays.
- [ ] Stage 3: Connections UI (link/unlink per platform).
- [ ] Stage 4: **Kick** — OAuth2 + Pusher WebSocket chat + alerts + send.
- [ ] Stage 5: **YouTube** — OAuth + liveChat polling (quota-gated; apply for
      quota increase before GA).
- [ ] Stage 6: **VPzone** — once their API is documented.

## 🧱 Epic 2 — Multistream (restream.io-style multi-RTMP out)

Design doc: `docs/design/multistream.md`.

- [ ] Stage 1: `targets[]` model in config/kv (default derived from existing
      Twitch target). No behavior change.
- [ ] Stage 2: FFmpeg `tee` output from enabled targets w/ `onfail=ignore`;
      per-target stderr → status; hot-restart on change.
      (`desktop-streamer.js` `_spawnFFmpeg`)
- [ ] Stage 3: Multistream UI — targets CRUD, status dots, egress estimate.
- [ ] Stage 4: account auto-fill of ingest creds from linked platforms.
- [ ] Stage 5 (optional): per-target independent encodes via local relay.

---

## Notes / conventions
- Branch: `desktop`. Builds: `test.bat` locally, GitHub Actions on tag.
- Bump version **before** tagging; only push/tag when the user says so.
- `test.bat` is gitignored (`*.bat`).
