"use strict";

/**
 * In-app auto-update for the packaged desktop app.
 *
 * Checks GitHub Releases (via electron-updater + the `publish` block in
 * electron-builder.yml) for a newer version on launch and every few
 * hours. When one is found it asks the user:
 *
 *     ┌────────────────────────────────────────────┐
 *     │  Update available — CacheStream X.Y.Z      │
 *     │   [ Install now ]   [ Remind me later ]    │
 *     └────────────────────────────────────────────┘
 *
 * "Install now" downloads in the background, then offers "Restart now"
 * so a live stream is never interrupted without consent (if you choose
 * Later, it applies on next quit). "Remind me later" just defers — the
 * next check (next launch or in ~6h) re-asks.
 *
 * No-ops in dev (electron-updater needs the packaged app + the metadata
 * it publishes), and falls back to opening the Releases page if the
 * build target can't self-install (e.g. a .deb or the portable .exe).
 */

const { app, dialog, shell } = require("electron");

const RELEASES_URL =
  "https://github.com/NekoSuneProjectsForks/CacheStream/releases/latest";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6 hours

function initUpdater({ getWindow, logger } = {}) {
  // Updates only make sense in a built/installed app — in dev there's
  // no app-update.yml and no installer to swap in.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    logger?.warn?.({ err: err?.message }, "electron-updater unavailable — skipping auto-update");
    return;
  }

  // We drive downloads from the prompt, not automatically.
  autoUpdater.autoDownload = false;
  // If the user downloads but chooses "Later", apply it on next quit.
  autoUpdater.autoInstallOnAppQuit = true;
  if (logger) autoUpdater.logger = logger;

  let busy = false; // don't stack dialogs if a periodic check overlaps

  autoUpdater.on("update-available", async (info) => {
    if (busy) return;
    busy = true;
    const win = getWindow?.() || null;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      title: "Update available",
      message: `CacheStream ${info.version} is available`,
      detail: `You're running ${app.getVersion()}. Install the update now?`,
      buttons: ["Install now", "Remind me later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        // Target can't self-install (.deb / portable) or download failed
        // — open the Releases page so the user can grab the installer.
        logger?.warn?.({ err: err?.message }, "update download failed; opening releases page");
        await shell.openExternal(RELEASES_URL);
        busy = false;
      }
    } else {
      busy = false; // remind me later — a later check re-prompts
    }
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const win = getWindow?.() || null;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      title: "Update ready",
      message: `CacheStream ${info.version} downloaded`,
      detail:
        "Restart now to finish installing? If you're live, your stream " +
        "will briefly stop — otherwise it installs the next time you quit.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    busy = false;
    if (response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  autoUpdater.on("update-not-available", () => { busy = false; });
  autoUpdater.on("error", (err) => {
    busy = false;
    logger?.warn?.({ err: err?.message }, "auto-update check failed");
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger?.warn?.({ err: err?.message }, "auto-update check failed");
    });
  };

  // Let the app settle, then check; re-check periodically for long
  // multi-day streams that rarely restart.
  setTimeout(check, 10_000);
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref?.();
}

module.exports = { initUpdater };
