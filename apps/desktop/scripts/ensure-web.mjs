// Make `npm run dev` self-healing in two ways:
//   1. If the Next.js panel bundle hasn't been built yet
//      (build/web/server.js missing), build it now instead of letting
//      Electron boot against a missing server and hang.
//   2. If the bundle IS present but its native better-sqlite3 was built
//      for the wrong ABI (e.g. an earlier build staged it for system
//      Node, or Electron was bumped), rebuild just that module — fast,
//      no full Next.js rebuild. This prevents the boot-time
//      NODE_MODULE_VERSION mismatch crash.
//
// `npm run build-web` remains the explicit full force-rebuild.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { rebuildSqlite, sqliteNeedsRebuild } from "./native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const stage = join(desktopDir, "build", "web");
const serverJs = join(stage, "server.js");

if (!existsSync(serverJs)) {
  console.log(
    "[ensure-web] web bundle missing → building it now.\n" +
    "             (first run can take a few minutes; re-run with\n" +
    "             `npm run build-web` whenever you change apps/web)",
  );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["run", "build-web"], {
    cwd: desktopDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(r.status ?? 1);
}

// Bundle present — make sure its native module matches the Electron ABI.
if (sqliteNeedsRebuild(desktopDir, stage)) {
  console.log("[ensure-web] better-sqlite3 ABI stale/missing → rebuilding native module");
  await rebuildSqlite(desktopDir, stage);
} else {
  console.log("[ensure-web] web bundle present + native module OK → skipping build");
}
