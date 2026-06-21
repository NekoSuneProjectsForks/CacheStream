# CacheStream Desktop

CacheStream as a **native desktop app** — the full control panel plus
the headless streaming pipeline, with **no Docker, no Node, no Chromium,
and no FFmpeg to install**. One installer, double-click, log in to
Twitch, hit **Start**.

Targets: **Linux** (x64 + arm64, incl. Raspberry Pi OS 64-bit) and
**Windows** (x64 + arm64), as AppImage / `.deb` / NSIS installer /
portable `.exe`.

## How it works

It's an [Electron](https://www.electronjs.org/) app that reuses the
existing CacheStream pieces instead of forking them:

```
Electron main process
 ├─ AudioRelay            loopback-TCP carrier for music PCM (replaces
 │                        the Linux FIFOs — works on Windows too)
 ├─ DesktopStreamer       offscreen, GPU-accelerated BrowserWindow renders
 │   │                    /scene/* at a guaranteed frame rate …
 │   └─ 'paint' → JPEG  → bundled FFmpeg → Twitch RTMP
 ├─ IngestServer          embedded RTMP→HLS server (replaces the Docker
 │                        nginx-rtmp `ingest` service): node-media-server
 │                        receives OBS pushes on :1935, bundled FFmpeg
 │                        remuxes to HLS, a tiny HTTP server mirrors
 │                        nginx-rtmp's /hls/* + /stat + /health surface
 ├─ internal control API  the SAME http://127.0.0.1 API the panel speaks
 │                        (vendored from apps/streamer/src/api.js)
 └─ Next.js panel         the unmodified apps/web standalone server, run
                          as a child process via utilityProcess.fork
```

This bundles **all three** Docker services (`web`, `streamer`, `ingest`)
into one app, so every panel feature — chat, alerts, scenes, overlays,
music, VODs, games, branding, scheduler, **and RTMP ingest** — works
exactly as in the Docker build, with nothing else to install.

Rendering scenes through Electron's offscreen GPU window with a fixed
`setFrameRate` is also what makes the desktop app immune to the Pi's
"~3 fps software-compositor" problem — no flags needed.

## Network access (not just localhost)

The panel and the RTMP ingest bind to **all interfaces**, so other
devices on your LAN can reach them:

- **Panel** — `http://<this-machine-ip>:7788/admin` opens the control
  panel from your phone or another computer. (The desktop window itself
  loads over `http://localhost:7788`.)
- **RTMP ingest** — point OBS / a phone encoder / a capture box at
  `rtmp://<this-machine-ip>:1935/live` with the stream key from the
  panel's **Sources → RTMP ingest** tab. CacheStream renders that feed
  as a scene, composites overlays on top, and forwards it to Twitch.

The app picks the conventional ports (`7788`, `1935`) when free and
falls back to a random free port if they're taken — the actual LAN URLs
are printed on boot and shown in the tray menu (click to copy).
Internal-only services (the streamer control API, the audio relay, and
the ingest's HTTP/HLS side) stay on `127.0.0.1`.

## Twitch login (no HTTPS needed)

Twitch requires OAuth redirect URLs to be HTTPS **except for the literal
host `localhost`**, which it allows over plain `http`. The desktop app
therefore serves the panel from `http://localhost:7788` (not
`127.0.0.1` — Twitch does *not* grant the http exception to the IP
form). So login works with **no TLS / no tunnel**.

When you register your Twitch dev app, set the **OAuth Redirect URL** to
exactly:

```
http://localhost:7788/api/auth/twitch/callback
```

Session cookies are issued without the `Secure` flag in this mode
(`TRUST_PROXY=false`), so they work over plain http. If port `7788` is
taken and the app falls back to a random port, update the dev-app
redirect URL to match that port.

## Develop

```bash
cd apps/desktop
npm install
npm run dev            # builds the panel if needed, then launches Electron
```

`npm run dev` is self-healing: its `predev` step runs `sync-streamer`
(copies the reusable streamer modules — `ffmpeg/config/autoprofile/
thermal/logger/api` — from `apps/streamer/src` into the generated
`src/streamer/`) and then `ensure-web`, which **builds the Next.js panel
automatically if `build/web/server.js` is missing**. The first run can
take a few minutes while Next.js builds; subsequent runs skip it.

Re-run `npm run build-web` whenever you change the web app (the auto-step
only triggers when the bundle is *absent*, not when it's stale).

### Missing binaries heal themselves

- **FFmpeg** — if no FFmpeg is detected (vendored build → `ffmpeg-static`
  → `ffmpeg` on `PATH`), the app downloads a static build for your
  platform from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
  on first boot and caches it under the data dir's `bin/`. Covers the
  win-arm64 gap and any host without FFmpeg installed.
- **Web panel bundle** — auto-built in dev (above); shipped as a resource
  in packaged builds. If it's somehow missing you get a clear dialog
  ("run `npm run build-web`") instead of a silent hang.

## Package installers

```bash
npm run dist            # current platform/arch
npm run dist:linux      # AppImage + deb, x64 + arm64
npm run dist:win        # NSIS + portable, x64 + arm64
```

Output lands in `dist/`. Cross-arch native builds (better-sqlite3 +
ffmpeg) are best produced on a native runner of the target arch — see
[`.github/workflows/desktop.yml`](../../.github/workflows/desktop.yml),
which builds all four targets on matching GitHub runners and attaches
the installers to the tagged release.

## Bundled binaries

- **Chromium** — Electron's own (rendering + the panel window).
- **FFmpeg** — [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static)
  for linux x64/arm64 + win x64. Windows-arm64 isn't covered by
  ffmpeg-static, so CI vendors a [BtbN](https://github.com/BtbN/FFmpeg-Builds)
  win-arm64 build into `build/ffmpeg/win32-arm64/` and the app prefers
  that. `resolveFfmpeg()` falls back to a `ffmpeg` on `PATH` in dev, and
  if *nothing* is found, `ensureFfmpeg()` (src/ensure-ffmpeg.js) downloads
  a BtbN static build at runtime and caches it under `<userData>/bin/` —
  so a host with no FFmpeg at all still works.
- **SQLite** — `better-sqlite3` from the web bundle, rebuilt against
  Electron's ABI during `build-web`.
- **RTMP server** — [`node-media-server`](https://www.npmjs.com/package/node-media-server),
  a pure-JS RTMP receiver. No native build, so it ships in the asar and
  works on every win/linux × x64/arm64 target. HLS is remuxed with the
  same bundled FFmpeg (`-c copy`, so it's cheap).

## Data location

Everything mutable lives under the per-user data dir
(`app.getPath('userData')`):

- Windows: `%APPDATA%\CacheStream\`
- Linux: `~/.config/CacheStream/`

…containing `data/` (SQLite DB, covers, logos), `media/music`,
`media/vods`, `hls/` (RTMP-ingest HLS scratch, emptied on boot), and
`.internal-api-token`.
