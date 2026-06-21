"use strict";

/**
 * CacheStream desktop — Electron main process.
 *
 * Boots the whole stack on one machine, no Docker:
 *   1. resolve per-user data dirs + a shared internal token
 *   2. start the AudioRelay (loopback-TCP carrier for music PCM)
 *   3. build the streamer config, start the in-process DesktopStreamer
 *      behind the SAME HTTP control API the web panel already speaks
 *   4. launch the bundled Next.js panel as a child Node process
 *   5. open the panel window
 *
 * The web panel talks to the streamer over 127.0.0.1 exactly as it
 * does to the Docker streamer, so none of its 70+ routes/workers change.
 */

const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Best-effort GPU enablement for the offscreen scene renderer. This
// is the desktop equivalent of the Docker Pi FPS fix — on a Pi the
// GPU is what lifts the compositor past ~3 fps. Harmless on hosts
// that ignore them.
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

const { resolveDirs, webBundleDir, resolveFfmpeg, freePort, preferredPort, lanAddress } = require("./paths");
const { loadOrCreateToken } = require("./token");
const { startWebServer } = require("./web-server");
const { AudioRelay } = require("./audio-relay");
const { DesktopStreamer } = require("./desktop-streamer");
const { IngestServer } = require("./ingest");
const { ensureFfmpeg } = require("./ensure-ffmpeg");
const { createPanelWindow, createTray } = require("./window");

// Vendored from apps/streamer/src (see scripts/sync-streamer.mjs).
const { buildConfig } = require("./streamer/config");
const { createLogger } = require("./streamer/logger");
const { createApi } = require("./streamer/api");
const { ThermalMonitor } = require("./streamer/thermal");

let state = {
  webChild: null, relay: null, streamer: null, thermal: null,
  api: null, ingest: null, panelWindow: null, tray: null, quitting: false,
};

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = state.panelWindow;
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
  app.whenReady().then(boot).catch((err) => {
    console.error("[main] boot failed:", err);
    // Show the operator what went wrong instead of silently quitting.
    try {
      const detail = err?.code === "WEB_BUNDLE_MISSING"
        ? `${err.message}\n\nThen relaunch the app.`
        : (err?.stack || String(err));
      dialog.showErrorBox("CacheStream failed to start", detail);
    } catch {}
    app.quit();
  });
}

async function boot() {
  const dirs = resolveDirs();
  const token = loadOrCreateToken(dirs.tokenFile);

  // Pre-flight: the panel bundle must exist (it's a shipped resource in
  // packaged builds; in dev `npm run dev` auto-builds it). Bail early
  // with an actionable message rather than hanging on the health probe.
  const bundleDir = webBundleDir();
  if (!fs.existsSync(path.join(bundleDir, "server.js"))) {
    const e = new Error(
      `Web panel bundle not found at ${bundleDir}.\n` +
      `Build it first:  cd apps/desktop && npm run build-web`,
    );
    e.code = "WEB_BUNDLE_MISSING";
    throw e;
  }

  // FFmpeg: detect, else download one automatically (one-time).
  const ffmpegPath = await ensureFfmpeg({
    resolveFfmpeg,
    binDir: path.join(dirs.root, "bin"),
    logger: console,
  });
  const lanIp = lanAddress();

  // Network-facing services keep their conventional ports when free
  // (stable LAN URL for the phone panel; OBS pushes to :1935) and
  // fall back to a random free port otherwise. Internal-only services
  // (streamer API, audio relay, ingest HTTP) stay on loopback.
  const [webPort, rtmpPort, apiPort, ingestHttpPort, musicInPort, audioOutPort] =
    await Promise.all([
      preferredPort(7788, "0.0.0.0"),
      preferredPort(1935, "0.0.0.0"),
      freePort(), freePort(), freePort(), freePort(),
    ]);

  // Use the literal hostname "localhost" (not 127.0.0.1) for the panel
  // origin + Twitch OAuth redirect. Twitch requires HTTPS for redirect
  // URLs EXCEPT for `localhost`, which it allows over plain http — but
  // it only grants that exception to the literal "localhost", not to
  // 127.0.0.1. So this is what lets login work without TLS. The web
  // server binds 0.0.0.0, so it answers localhost all the same.
  const panelOrigin = `http://localhost:${webPort}`;

  // ── Env the vendored streamer config (buildConfig) reads ───────
  process.env.INTERNAL_API_TOKEN = token;
  process.env.STREAMER_PORT = String(apiPort);
  process.env.FFMPEG_PATH = ffmpegPath;
  process.env.DEFAULT_SCENE_URL = `${panelOrigin}/scene`;
  process.env.NODE_ENV = "production";

  const config = buildConfig({ logger: console });
  const logger = createLogger(config.runtime.logLevel || "info").child({ module: "desktop" });

  logger.info({ webPort, rtmpPort, apiPort, ingestHttpPort, musicInPort, audioOutPort,
    ffmpegPath, dataDir: dirs.data, lanIp }, "cachestream desktop starting");

  // ── Audio relay (replaces FIFOs) ───────────────────────────────
  state.relay = new AudioRelay({ inPort: musicInPort, outPort: audioOutPort, logger: logger.child({ module: "audio" }) });
  state.relay.start();

  // ── RTMP ingest (replaces the Docker `ingest` nginx-rtmp service)─
  state.ingest = new IngestServer({
    rtmpPort, httpPort: ingestHttpPort, httpHost: "127.0.0.1",
    hlsDir: dirs.hls, ffmpegPath,
    logger: logger.child({ module: "ingest" }),
  });
  state.ingest.start();

  // ── Streamer + control API ─────────────────────────────────────
  state.streamer = new DesktopStreamer({
    config,
    logger: logger.child({ module: "stream" }),
    ffmpegPath,
    relayOutPort: audioOutPort,
  });
  state.thermal = new ThermalMonitor({ config, streamer: state.streamer, logger: logger.child({ module: "thermal" }) });
  state.thermal.start();
  state.streamer.thermal = state.thermal;

  state.api = createApi({ streamer: state.streamer, config, logger: logger.child({ module: "api" }) });
  await state.api.listen();

  // ── Web panel (Next.js standalone) as a child process ──────────
  const { child, ready } = startWebServer({
    bundleDir,
    port: webPort,
    hostname: "0.0.0.0", // reachable from the phone / LAN
    onLog: (line) => logger.info(line),
    env: {
      INTERNAL_API_TOKEN: token,
      STREAMER_URL: `http://127.0.0.1:${apiPort}`,
      // OAuth redirect + the panel window both use the localhost origin
      // (Twitch allows http only for `localhost`) so login works without
      // TLS and the dev-app redirect URL stays stable regardless of IP.
      PUBLIC_URL: panelOrigin,
      DEFAULT_SCENE_URL: `${panelOrigin}/scene`,
      // Streamer-reachable base for scene + widget URLs. In Docker this
      // defaults to the compose host `web:7788`; here the in-process
      // streamer renders over loopback, so point it at localhost. Scene
      // presets seeded with either base are normalised to this one.
      SCENE_BASE_URL: panelOrigin,
      DATA_DIR: dirs.data,
      MUSIC_LIBRARY_DIR: dirs.music,
      VOD_LIBRARY_DIR: dirs.vods,
      // Cross-platform audio: per-track music FFmpeg → relay.
      AUDIO_TRANSPORT: "tcp",
      MUSIC_TCP_PORT: String(musicInPort),
      FFMPEG_PATH: ffmpegPath,
      TRUST_PROXY: "false",
      // RTMP ingest — point the panel's /api/ingest/* routes at the
      // embedded server, and tell it the host + port to advertise to
      // OBS (the LAN IP when we have one, else loopback).
      INGEST_HTTP_URL: `http://127.0.0.1:${ingestHttpPort}`,
      RTMP_PORT: String(rtmpPort),
      ...(lanIp ? { RTMP_PUBLIC_HOST: lanIp } : {}),
    },
  });
  state.webChild = child;
  child.on("exit", (code) => {
    logger.warn({ code }, "web server child exited");
    if (!state.quitting) { app.quit(); }
  });

  await ready;
  const lanPanelUrl = lanIp ? `http://${lanIp}:${webPort}` : null;
  const rtmpPushUrl = `rtmp://${lanIp || "127.0.0.1"}:${rtmpPort}/live`;
  logger.info(
    { url: `${panelOrigin}/admin`, lanPanelUrl, rtmpPushUrl },
    "panel ready",
  );

  // ── Window + tray ─────────────────────────────────────────────
  state.panelWindow = createPanelWindow(panelOrigin);
  state.tray = createTray({
    getWindow: () => state.panelWindow,
    onQuit: () => app.quit(),
    lanPanelUrl,
    rtmpPushUrl,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !state.quitting) {
      state.panelWindow = createPanelWindow(panelOrigin);
    }
  });
}

app.on("window-all-closed", () => {
  // No tray → quitting closes the app. With a tray we keep running
  // in the background so the stream survives a closed window.
  if (!state.tray) app.quit();
});

app.on("before-quit", async (e) => {
  if (state.quitting) return;
  state.quitting = true;
  e.preventDefault();
  try { state.thermal?.stop(); } catch {}
  try { await state.streamer?.stop(); } catch {}
  try { await state.api?.close(); } catch {}
  try { state.ingest?.stop(); } catch {}
  try { state.relay?.stop(); } catch {}
  try { state.webChild?.kill(); } catch {}
  app.exit(0);
});
