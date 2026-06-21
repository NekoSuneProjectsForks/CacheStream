// Build the Next.js panel (apps/web) in standalone mode and stage
// it under apps/desktop/build/web so electron-builder can ship it
// as an unpacked resource. Also rebuilds the staged better-sqlite3
// native module against Electron's ABI (the dev copy in apps/web
// stays node-ABI so the web app can still be built/run normally).
//
// Layout produced (matches what `node server.js` expects):
//   build/web/server.js
//   build/web/node_modules/...        (incl. native better-sqlite3)
//   build/web/.next/...               (server chunks)
//   build/web/.next/static/...        (client assets)
//   build/web/public/...

import { existsSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { rebuildSqlite } from "./native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const webDir = join(desktopDir, "..", "web");
const stage = join(desktopDir, "build", "web");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, cwd) {
  console.log(`[build-web] ${cmd} ${args.join(" ")}  (cwd=${cwd})`);
  const useShell = process.platform === "win32";
  // Under shell:true (needed to run .cmd shims on Windows) Node joins
  // the args into one command string WITHOUT quoting — so any arg with
  // a space, like a project path under "…\Forked Projects\…", gets
  // split and the next command receives a truncated path. Quote args
  // that need it so paths with spaces survive.
  const safeArgs = useShell
    ? args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
    : args;
  const r = spawnSync(cmd, safeArgs, { cwd, stdio: "inherit", shell: useShell });
  if (r.status !== 0) {
    console.error(`[build-web] command failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

// 1. Install web deps if absent.
if (!existsSync(join(webDir, "node_modules"))) {
  run(npm, ["install", "--no-audit", "--no-fund"], webDir);
}

// 2. Build standalone.
run(npm, ["run", "build"], webDir);

const standalone = join(webDir, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("[build-web] .next/standalone/server.js missing — is output:'standalone' set?");
  process.exit(1);
}

// 3. Stage standalone + static + public.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(standalone, stage, { recursive: true });
cpSync(join(webDir, ".next", "static"), join(stage, ".next", "static"), { recursive: true });
if (existsSync(join(webDir, "public"))) {
  cpSync(join(webDir, "public"), join(stage, "public"), { recursive: true });
}
console.log("[build-web] staged web standalone → build/web");

// 4. Rebuild the staged better-sqlite3 against Electron's ABI and
//    stamp the version marker (see scripts/native.mjs). Without this
//    the module stays built for the system Node and the panel crashes
//    at boot with NODE_MODULE_VERSION mismatch.
await rebuildSqlite(desktopDir, stage);
console.log("[build-web] done");
