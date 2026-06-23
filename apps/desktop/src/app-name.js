"use strict";

/**
 * Runtime app branding (display name + GitHub repo) resolved with no
 * hardcoded "CacheStream":
 *
 *   1. src/app-name.json — written at build time by scripts/eb.mjs from
 *      the repo the build ran in (the authoritative source in packaged
 *      builds; bundled via `files: src/**` in electron-builder.yml).
 *   2. app.getName() — electron-builder sets this to the productName in
 *      packaged builds; ignored when it's still the dev package name.
 *   3. CacheStream defaults.
 *
 * Used for the window/tray title, error dialogs and the updater's
 * "view releases" link, so renaming the repo renames the whole app.
 */

const { app } = require("electron");

let cached = null;

function load() {
  if (cached) return cached;
  let j = {};
  try { j = require("./app-name.json"); } catch { /* not generated (dev) */ }

  let name = j.productName;
  if (!name) {
    try {
      const n = app.getName();
      if (n && n !== "cachestream-desktop") name = n;
    } catch { /* app not ready */ }
  }

  cached = {
    productName: name || "CacheStream",
    owner: j.owner || "NekoSuneProjectsForks",
    repo: j.repo || "CacheStream",
  };
  return cached;
}

function appName() {
  return load().productName;
}

function releasesUrl() {
  const m = load();
  return `https://github.com/${m.owner}/${m.repo}/releases/latest`;
}

module.exports = { appName, releasesUrl };
