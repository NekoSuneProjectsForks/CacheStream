"use strict";

/**
 * Filesystem + binary path resolution for the desktop app.
 *
 * Everything mutable (SQLite DB, branding logos, covers, uploaded
 * music + VODs, the internal-API token) lives under Electron's
 * per-user data dir so a packaged, read-only app install still has
 * somewhere to write. In dev it lands under apps/desktop/.userdata.
 */

const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");

function dataRoot() {
  // app.getPath('userData') is the OS-conventional per-app dir
  // (%APPDATA%\CacheStream on Windows, ~/.config/CacheStream on
  // Linux). Created by Electron already.
  const root = app.getPath("userData");
  return root;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** The directory tree the web panel + streamer read/write. */
function resolveDirs() {
  const root = dataRoot();
  return {
    root,
    data:  ensureDir(path.join(root, "data")),        // SQLite + covers + logos
    music: ensureDir(path.join(root, "media", "music")),
    vods:  ensureDir(path.join(root, "media", "vods")),
    // RTMP-ingest HLS scratch (the desktop equivalent of nginx-rtmp's
    // /tmp/hls). Emptied on boot so a crashed run doesn't leave the
    // panel thinking a key is still "live".
    hls:   emptyDir(path.join(root, "hls")),
    tokenFile: path.join(root, ".internal-api-token"),
  };
}

/** Create a directory and remove any leftover files inside it. */
function emptyDir(p) {
  ensureDir(p);
  try {
    for (const name of fs.readdirSync(p)) {
      try { fs.rmSync(path.join(p, name), { recursive: true, force: true }); } catch {}
    }
  } catch {}
  return p;
}

/** Where the staged Next.js standalone bundle lives. */
function webBundleDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(__dirname, "..", "build", "web");
}

/**
 * Resolve a usable ffmpeg binary, in priority order:
 *   1. A per-arch vendored binary under resources/ffmpeg (used for
 *      targets ffmpeg-static doesn't cover — notably win32 arm64).
 *   2. ffmpeg-static's bundled binary (asar-unpacked when packaged).
 *   3. Bare "ffmpeg" on PATH (dev fallback).
 */
function resolveFfmpeg() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  const vendored = app.isPackaged
    ? path.join(process.resourcesPath, "ffmpeg", exe)
    : path.join(__dirname, "..", "build", "ffmpeg",
                `${process.platform}-${process.arch}`, exe);
  if (safeExists(vendored)) return vendored;

  try {
    // ffmpeg-static exports the absolute path to its binary. Inside
    // a packaged app that path points into app.asar; the real file
    // is at app.asar.unpacked thanks to asarUnpack in the builder
    // config, so rewrite the segment.
    let p = require("ffmpeg-static");
    if (p) {
      p = p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep)
           .replace("app.asar/", "app.asar.unpacked/");
      if (safeExists(p)) return p;
    }
  } catch { /* not installed in this context */ }

  return "ffmpeg";
}

function safeExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** Find a free TCP port on loopback. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Prefer a well-known port (so OBS can push to the conventional
 * :1935 and the panel keeps a stable LAN URL) but fall back to a
 * random free one if it's already taken. Bind on `host` so the
 * check matches how the real server will bind (0.0.0.0 for the
 * network-facing RTMP / panel; 127.0.0.1 for internal-only).
 */
function preferredPort(desired, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => {
      // Desired port busy — grab any free one instead.
      const fallback = net.createServer();
      fallback.unref();
      fallback.on("error", () => resolve(0));
      fallback.listen(0, host, () => {
        const { port } = fallback.address();
        fallback.close(() => resolve(port));
      });
    });
    srv.listen(desired, host, () => {
      srv.close(() => resolve(desired));
    });
  });
}

/**
 * Best-effort primary LAN IPv4 so the panel can show "push OBS to
 * rtmp://<lan-ip>:1935/live" and "open the panel from your phone at
 * http://<lan-ip>:7788". Returns null if the machine only has
 * loopback (then callers fall back to 127.0.0.1).
 */
function lanAddress() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (/^169\.254\./.test(ni.address)) continue; // link-local
      candidates.push({ name, address: ni.address });
    }
  }
  // Prefer common physical-interface names over virtual adapters
  // (docker/vEthernet/VMware/VirtualBox) which often sort first.
  const isVirtual = (n) => /docker|veth|vmnet|vmware|virtualbox|vbox|hyper-v|loopback|wsl/i.test(n);
  const real = candidates.find((c) => !isVirtual(c.name));
  return (real || candidates[0])?.address || null;
}

module.exports = {
  resolveDirs, webBundleDir, resolveFfmpeg, freePort, preferredPort, lanAddress,
};
