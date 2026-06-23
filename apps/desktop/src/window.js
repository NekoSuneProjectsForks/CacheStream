"use strict";

/**
 * The visible control-panel window + an optional tray icon.
 * The window simply loads the locally-served Next.js panel.
 */

const { BrowserWindow, Tray, Menu, shell, nativeImage, clipboard } = require("electron");
const path = require("node:path");
const { appName } = require("./app-name");

function createPanelWindow(panelUrl) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: appName(),
    backgroundColor: "#0a0d18",
    autoHideMenuBar: true,
    webPreferences: {
      // The panel is our own trusted local origin, but keep the
      // renderer locked down anyway — it only needs to display the
      // web UI, not Node.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadURL(`${panelUrl}/admin`);

  // Debug builds (test.bat sets CS_DEVTOOLS=1) auto-open DevTools so the
  // renderer console + network are visible while iterating. No effect in
  // shipped builds where the env var is unset.
  if (process.env.CS_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  // Open external links (e.g. Twitch dashboard) in the OS browser,
  // not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(panelUrl)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  return win;
}

/**
 * @param {object} opts
 * @param {() => BrowserWindow|null} opts.getWindow
 * @param {() => void} opts.onQuit
 * @param {string|null} [opts.lanPanelUrl]  e.g. http://192.168.1.20:7788
 * @param {string|null} [opts.rtmpPushUrl]  e.g. rtmp://192.168.1.20:1935/live
 */
function createTray({ getWindow, onQuit, lanPanelUrl = null, rtmpPushUrl = null }) {
  try {
    const iconPath = path.join(__dirname, "..", "build", "icon.png");
    const img = nativeImage.createFromPath(iconPath);
    // An empty image makes Tray throw on some platforms; bail to a
    // window-only experience if we have no usable icon.
    if (img.isEmpty()) return null;

    const tray = new Tray(img);
    tray.setToolTip(appName());

    const template = [
      { label: `Open ${appName()}`, click: () => { const w = getWindow(); if (w) { w.show(); w.focus(); } } },
    ];
    // LAN reachability — so you can open the panel from your phone or
    // point OBS at the ingest without hunting for the machine's IP.
    if (lanPanelUrl || rtmpPushUrl) {
      template.push({ type: "separator" });
      if (lanPanelUrl) {
        template.push({
          label: `Panel on LAN: ${lanPanelUrl}`,
          click: () => clipboard.writeText(`${lanPanelUrl}/admin`),
          toolTip: "Copy the LAN panel URL",
        });
      }
      if (rtmpPushUrl) {
        template.push({
          label: `OBS push URL: ${rtmpPushUrl}`,
          click: () => clipboard.writeText(rtmpPushUrl),
          toolTip: "Copy the RTMP ingest URL for OBS",
        });
      }
    }
    template.push({ type: "separator" });
    template.push({ label: "Quit", click: () => onQuit() });

    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.on("click", () => { const w = getWindow(); if (w) { w.show(); w.focus(); } });
    return tray;
  } catch {
    return null;
  }
}

module.exports = { createPanelWindow, createTray };
