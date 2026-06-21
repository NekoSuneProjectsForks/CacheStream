"use strict";

/**
 * Guarantee a working FFmpeg, downloading one if the machine has
 * none. Resolution order:
 *
 *   1. The normal detection (vendored per-arch build → ffmpeg-static
 *      → `ffmpeg` on PATH). See paths.resolveFfmpeg().
 *   2. A copy we downloaded on a previous run (cached under the
 *      per-user data dir).
 *   3. A fresh download of a static build from BtbN/FFmpeg-Builds,
 *      extracted with the system `tar` (bsdtar on Win10+/macOS, GNU
 *      tar on Linux — both read .zip and .tar.xz).
 *
 * If every path fails (e.g. offline on an unsupported arch) it falls
 * back to the literal "ffmpeg" so the error surfaces at stream start
 * rather than blocking boot.
 */

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function exeName() {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/** Does this binary actually run? */
function ffmpegWorks(bin) {
  if (!bin) return false;
  try {
    const r = spawnSync(bin, ["-version"], { stdio: "ignore", timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** A static-build download URL for this platform/arch, or null. */
function downloadUrl() {
  const p = process.platform;
  const a = process.arch;
  const base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";
  if (p === "win32" && a === "x64")   return base + "ffmpeg-master-latest-win64-gpl.zip";
  if (p === "win32" && a === "arm64") return base + "ffmpeg-master-latest-winarm64-gpl.zip";
  if (p === "linux" && a === "x64")   return base + "ffmpeg-master-latest-linux64-gpl.tar.xz";
  if (p === "linux" && a === "arm64") return base + "ffmpeg-master-latest-linuxarm64-gpl.tar.xz";
  return null; // macOS / other — rely on ffmpeg-static or PATH.
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("too many redirects"));
    const req = https.get(url, { headers: { "User-Agent": "CacheStream" } }, (res) => {
      // GitHub release assets 302 to a storage host.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
    });
    req.on("error", reject);
  });
}

function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // `tar` reads both .zip and .tar.xz on modern Windows/macOS/Linux.
  const r = spawnSync("tar", ["-xf", archive, "-C", destDir], { stdio: "ignore" });
  if (r.status !== 0) {
    throw new Error("extraction failed — system `tar` unavailable or unsupported archive");
  }
}

/** Depth-first search for the ffmpeg binary in an extracted tree. */
function findFfmpeg(dir) {
  const target = exeName().toLowerCase();
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name.toLowerCase() === target) return full;
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {() => string} opts.resolveFfmpeg  normal detection (from paths.js)
 * @param {string} opts.binDir               where to cache a download
 * @param {object} [opts.logger]
 * @returns {Promise<string>} a usable ffmpeg path (or "ffmpeg")
 */
async function ensureFfmpeg({ resolveFfmpeg, binDir, logger = console }) {
  // 1. Normal detection.
  const detected = resolveFfmpeg();
  if (detected && detected !== "ffmpeg" && ffmpegWorks(detected)) return detected;
  if (detected === "ffmpeg" && ffmpegWorks("ffmpeg")) return "ffmpeg";

  // 2. Previously downloaded copy.
  fs.mkdirSync(binDir, { recursive: true });
  const cached = path.join(binDir, exeName());
  if (fs.existsSync(cached) && ffmpegWorks(cached)) return cached;

  // 3. Download a static build.
  const url = downloadUrl();
  if (!url) {
    logger.warn?.({ platform: process.platform, arch: process.arch },
      "no ffmpeg auto-download for this platform — falling back to PATH `ffmpeg`");
    return "ffmpeg";
  }

  const isZip = url.endsWith(".zip");
  const tmp = path.join(binDir, `ffmpeg-download${isZip ? ".zip" : ".tar.xz"}`);
  const extractDir = path.join(binDir, "extract");
  logger.info?.({ url }, "ffmpeg not found — downloading a bundled build (one-time)");
  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
    await download(url, tmp);
    extract(tmp, extractDir);
    const bin = findFfmpeg(extractDir);
    if (!bin) throw new Error("ffmpeg binary not found inside the archive");
    fs.copyFileSync(bin, cached);
    if (process.platform !== "win32") fs.chmodSync(cached, 0o755);
    if (!ffmpegWorks(cached)) throw new Error("downloaded ffmpeg failed to run");
    logger.info?.({ path: cached }, "ffmpeg downloaded and ready");
    return cached;
  } catch (err) {
    logger.error?.({ err: err?.message || String(err) },
      "ffmpeg auto-download failed — falling back to PATH `ffmpeg`");
    return "ffmpeg";
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { ensureFfmpeg, ffmpegWorks };
