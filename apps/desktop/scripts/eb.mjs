// electron-builder wrapper: resolves the app branding from the repo
// (see app-meta.mjs), exposes it to electron-builder.yml via env vars
// (${env.APP_NAME} / ${env.APP_ID} / ${env.GH_OWNER} / ${env.GH_REPO} /
// ${env.APP_COPYRIGHT}), writes a runtime name file the Electron app
// reads for its window/tray title, then runs electron-builder with all
// forwarded CLI args (e.g. `--win --x64 --publish never`).
//
// This is what makes the app name follow the repo name with zero
// hardcoding: rename the repo → installers, appId, publish target and
// window title all follow automatically. Defaults stay "CacheStream".

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppMeta } from "./app-meta.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");

const meta = resolveAppMeta();
console.log(`[eb] building as "${meta.productName}" (appId ${meta.appId}, publish ${meta.owner}/${meta.repo})`);

// Runtime name file — bundled via `files: src/**/*` and read by
// src/app-name.js so the window/tray title matches the build name.
mkdirSync(join(desktopDir, "src"), { recursive: true });
writeFileSync(
  join(desktopDir, "src", "app-name.json"),
  JSON.stringify({
    productName: meta.productName,
    appId: meta.appId,
    owner: meta.owner,
    repo: meta.repo,
  }, null, 2) + "\n",
);

const env = {
  ...process.env,
  APP_NAME: meta.productName,
  APP_ID: meta.appId,
  GH_OWNER: meta.owner,
  GH_REPO: meta.repo,
  APP_COPYRIGHT: meta.copyright,
};

// Inject the repo-derived npm `name` into the PACKAGED app's package.json
// (build output only — the source package.json files are untouched, since
// JSON can't interpolate env and rewriting tracked files at build time is
// dirty). This makes the shipped app's name follow the repo too.
const forwarded = [
  `-c.extraMetadata.name=${meta.slug}`,
  ...process.argv.slice(2),   // e.g. --win --x64 --publish never
];
const win = process.platform === "win32";
const bin = join(desktopDir, "node_modules", ".bin", win ? "electron-builder.cmd" : "electron-builder");

const r = spawnSync(bin, forwarded, {
  cwd: desktopDir,
  stdio: "inherit",
  env,
  shell: win,   // needed to invoke the .cmd shim on Windows
});
process.exit(r.status ?? 1);
