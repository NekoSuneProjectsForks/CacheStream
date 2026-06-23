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

// electron-builder does NOT expand ${env.X} inside the config file, so the
// resolved branding is applied as CLI config OVERRIDES (-c.key=value). These
// win over the static defaults in electron-builder.yml. artifactName's
// ${productName} macro then resolves to the overridden productName.
// (Values are repo names / appIds / owners — no spaces — so they're safe as
// bare `-c.x=value` args on both bash and the Windows .cmd shim. Copyright
// has spaces, so it stays the static `MIT` in the yml.)
const overrides = [
  `-c.productName=${meta.productName}`,
  `-c.appId=${meta.appId}`,
  `-c.publish.provider=github`,
  `-c.publish.owner=${meta.owner}`,
  `-c.publish.repo=${meta.repo}`,
  // Repo-derived npm `name` in the PACKAGED app's package.json (build output
  // only; source package.json untouched) → app.getName()/userData follow it.
  `-c.extraMetadata.name=${meta.slug}`,
];
const forwarded = [
  ...overrides,
  ...process.argv.slice(2),   // e.g. --win --x64 --publish never
];
const win = process.platform === "win32";
const bin = join(desktopDir, "node_modules", ".bin", win ? "electron-builder.cmd" : "electron-builder");

const r = spawnSync(bin, forwarded, {
  cwd: desktopDir,
  stdio: "inherit",
  // Inherit process.env (GH_TOKEN / GITHUB_* for publishing). No ${env.X}
  // is read from the yml anymore — branding comes via -c overrides above.
  shell: win,   // needed to invoke the .cmd shim on Windows
});
process.exit(r.status ?? 1);
