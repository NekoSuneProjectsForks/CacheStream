"use strict";

/**
 * In-app auto-update for the packaged desktop app.
 *
 * Checks GitHub Releases (via electron-updater + the `publish` block in
 * electron-builder.yml) for a newer version on launch and every few
 * hours. When one is found it pops a styled window showing the release
 * notes (the GitHub release body, rendered from Markdown) and two
 * buttons — Install now / Remind me later:
 *
 *     ┌────────────────────────────────────────────┐
 *     │  Update available — CacheStream X.Y.Z      │
 *     │  ── what's new ───────────────────────────  │
 *     │  • rendered markdown release notes …       │
 *     │   [ Install now ]   [ Remind me later ]    │
 *     └────────────────────────────────────────────┘
 *
 * "Install now" downloads in the background, then offers "Restart now"
 * so a live stream is never interrupted without consent (if you choose
 * Later, it applies on next quit). "Remind me later" defers — the next
 * check (next launch or in ~6h) re-asks.
 *
 * No-ops in dev (electron-updater needs the packaged app + the metadata
 * it publishes), and falls back to opening the Releases page if the
 * build target can't self-install (e.g. a .deb or the portable .exe).
 */

const { app, dialog, shell, BrowserWindow } = require("electron");
const { appName, releasesUrl } = require("./app-name");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6 hours

// ---- Markdown → HTML -------------------------------------------------

/** electron-updater notes can be a string or [{version, note}]. */
function normalizeNotes(notes) {
  if (!notes) return "";
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (n && n.version ? `## ${n.version}\n` : "") + (n && n.note ? n.note : ""))
      .join("\n\n");
  }
  return String(notes);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderMarkdown(md) {
  const text = normalizeNotes(md).trim();
  if (!text) return "<p class='muted'>No release notes were provided for this version.</p>";
  try {
    const { marked } = require("marked");
    return marked.parse(text, { breaks: true, gfm: true });
  } catch {
    // Fallback: show the raw notes, escaped, preserving line breaks.
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

function buildHtml({ version, currentVersion, notesHtml }) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; height:100%; background:#0a0d18; color:#e6f7ff;
    font-family:'Segoe UI',system-ui,-apple-system,sans-serif; }
  .wrap { display:flex; flex-direction:column; height:100vh; }
  header { padding:18px 22px 12px; border-bottom:1px solid rgba(0,240,255,.18); }
  h1 { margin:0; font-size:18px; letter-spacing:.02em;
    color:#00f0ff; text-shadow:0 0 14px rgba(0,240,255,.35); }
  .sub { margin-top:4px; font-size:12px; color:#8aa; }
  .notes { flex:1; overflow:auto; padding:16px 22px; font-size:13.5px; line-height:1.55; }
  .notes h1,.notes h2,.notes h3 { color:#ff2bd6; margin:1.1em 0 .4em; font-size:1.05em; }
  .notes h2 { font-size:1.15em; }
  .notes ul,.notes ol { padding-left:1.3em; }
  .notes li { margin:.2em 0; }
  .notes code { background:rgba(0,0,0,.4); padding:.1em .35em; border-radius:3px; font-size:.92em; }
  .notes pre { background:rgba(0,0,0,.45); padding:.7em .9em; border-radius:5px; overflow:auto; }
  .notes a { color:#00f0ff; }
  .muted { color:#8aa; }
  footer { display:flex; gap:10px; justify-content:flex-end; padding:12px 22px;
    border-top:1px solid rgba(0,240,255,.18); background:rgba(0,0,0,.25); }
  button { font:inherit; font-size:13px; padding:9px 16px; border-radius:5px; cursor:pointer;
    border:1px solid rgba(0,240,255,.3); background:rgba(10,13,24,.6); color:#cfefff; }
  button.primary { background:linear-gradient(180deg,#00d0e0,#0090b8); border-color:#00f0ff;
    color:#021018; font-weight:600; text-shadow:none; }
  button:hover { filter:brightness(1.12); }
</style></head>
<body><div class="wrap">
  <header>
    <h1>Update available — ${escapeHtml(appName())} ${escapeHtml(version)}</h1>
    <div class="sub">You're on ${escapeHtml(currentVersion)}. Here's what's new:</div>
  </header>
  <div class="notes">${notesHtml}</div>
  <footer>
    <button onclick="location.href='cachestream-action:later'">Remind me later</button>
    <button class="primary" onclick="location.href='cachestream-action:install'">Install now</button>
  </footer>
</div></body></html>`;
}

/** Show the notes window; resolves "install" or "later". */
function showUpdateWindow({ version, currentVersion, notes, parent }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 620, height: 700,
      parent: parent || undefined,
      modal: !!parent,
      title: "Update available",
      backgroundColor: "#0a0d18",
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    let answered = false;
    const done = (action) => {
      if (answered) return;
      answered = true;
      try { if (!win.isDestroyed()) win.close(); } catch {}
      resolve(action);
    };

    win.webContents.on("will-navigate", (e, url) => {
      const m = /^cachestream-action:(install|later)/.exec(url);
      if (m) { e.preventDefault(); done(m[1]); }
    });
    // Closing the window (X) counts as "remind me later".
    win.on("closed", () => done("later"));

    const html = buildHtml({ version, currentVersion, notesHtml: renderMarkdown(notes) });
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
}

// ---- Updater ---------------------------------------------------------

function initUpdater({ getWindow, logger } = {}) {
  // Updates only make sense in a built/installed app.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    logger?.warn?.({ err: err?.message }, "electron-updater unavailable — skipping auto-update");
    return;
  }

  autoUpdater.autoDownload = false;          // gate downloads behind the prompt
  autoUpdater.autoInstallOnAppQuit = true;   // if downloaded but "Later", apply on quit
  if (logger) autoUpdater.logger = logger;

  let busy = false; // don't stack windows if a periodic check overlaps

  autoUpdater.on("update-available", async (info) => {
    if (busy) return;
    busy = true;
    const action = await showUpdateWindow({
      version: info.version,
      currentVersion: app.getVersion(),
      notes: info.releaseNotes,
      parent: getWindow?.() || null,
    });
    if (action === "install") {
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        // Target can't self-install (.deb / portable) or download failed.
        logger?.warn?.({ err: err?.message }, "update download failed; opening releases page");
        await shell.openExternal(releasesUrl());
        busy = false;
      }
    } else {
      busy = false; // remind me later — a later check re-prompts
    }
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox(getWindow?.() || null, {
      type: "info",
      title: "Update ready",
      message: `${appName()} ${info.version} downloaded`,
      detail:
        "Restart now to finish installing? If you're live, your stream " +
        "will briefly stop — otherwise it installs the next time you quit.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    busy = false;
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
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
