// Shared helpers for making the staged web bundle's native
// better-sqlite3 match Electron's ABI, plus a space-safe spawn.
//
// The desktop app runs the Next.js panel on Electron's bundled Node
// (via utilityProcess.fork), so better-sqlite3 must match Electron's
// NODE_MODULE_VERSION — not the system Node that `npm install` builds
// it for.
//
// Primary strategy: DOWNLOAD better-sqlite3's prebuilt Electron binary
// (WiseLibs publishes one per electron ABI / platform / arch). This
// needs NO C++ toolchain — important because most machines don't have
// Visual Studio / build-essential installed. We only fall back to
// electron-rebuild (compile from source) if the download fails.
//
// We never trust a "rebuild complete" message: the staged module is
// only accepted once it actually LOADS under Electron's own Node
// (ELECTRON_RUN_AS_NODE), and only then do we stamp
// build/web/.electron-version.

import {
  readFileSync, writeFileSync, existsSync, rmSync, cpSync,
  mkdirSync, createWriteStream, readdirSync, copyFileSync, statSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * spawnSync that survives spaces in paths under Windows' shell:true.
 * Node joins args into one command string without quoting, so a path
 * like "…\Forked Projects\…" gets split — quote args that need it.
 */
export function runSafe(cmd, args, cwd) {
  const useShell = process.platform === "win32";
  const safe = useShell
    ? args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
    : args;
  console.log(`[native] ${cmd} ${args.join(" ")}  (cwd=${cwd})`);
  const r = spawnSync(cmd, safe, { cwd, stdio: "inherit", shell: useShell });
  if (r.status !== 0) {
    console.error(`[native] command failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

/** The exact installed Electron version (drives the target ABI). */
export function electronVersion(desktopDir) {
  const pkg = join(desktopDir, "node_modules", "electron", "package.json");
  return JSON.parse(readFileSync(pkg, "utf8")).version;
}

/** Absolute path to the Electron executable. */
function electronBinary(desktopDir) {
  const base = join(desktopDir, "node_modules", "electron");
  const rel = readFileSync(join(base, "path.txt"), "utf8").trim();
  return join(base, "dist", rel);
}

/** Electron's NODE_MODULE_VERSION (ABI), asked of the binary itself. */
function electronAbi(desktopDir) {
  const bin = electronBinary(desktopDir);
  const r = spawnSync(bin, ["-e", "process.stdout.write(String(process.versions.modules))"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  const abi = (r.stdout || "").trim();
  if (!/^\d+$/.test(abi)) throw new Error(`could not read Electron ABI (got "${abi}")`);
  return abi;
}

const markerPath = (stage) => join(stage, ".electron-version");
const stageModule = (stage) => join(stage, "node_modules", "better-sqlite3");
const sqliteBinary = (stage) =>
  join(stageModule(stage), "build", "Release", "better_sqlite3.node");

function sqliteVersion(stage, desktopDir) {
  for (const p of [
    join(stageModule(stage), "package.json"),
    join(desktopDir, "..", "web", "node_modules", "better-sqlite3", "package.json"),
  ]) {
    try { return JSON.parse(readFileSync(p, "utf8")).version; } catch { /* next */ }
  }
  throw new Error("could not determine better-sqlite3 version");
}

/**
 * Authoritatively check the staged better-sqlite3 loads under
 * Electron's Node (i.e. its ABI matches the runtime).
 */
export function sqliteAbiOk(desktopDir, stage) {
  let bin;
  try { bin = electronBinary(desktopDir); } catch { return false; }
  if (!existsSync(bin) || !existsSync(sqliteBinary(stage))) return false;
  const script = `require(${JSON.stringify(stageModule(stage))}); console.log("ABI_OK");`;
  const r = spawnSync(bin, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  return r.status === 0 && /ABI_OK/.test(r.stdout || "");
}

/** True if the staged native module is missing, stale, or wrong-ABI. */
export function sqliteNeedsRebuild(desktopDir, stage) {
  if (!existsSync(sqliteBinary(stage))) return true;
  const marker = markerPath(stage);
  if (!existsSync(marker)) return true;
  try {
    if (readFileSync(marker, "utf8").trim() !== electronVersion(desktopDir)) return true;
  } catch {
    return true;
  }
  return !sqliteAbiOk(desktopDir, stage);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("too many redirects"));
    https.get(url, { headers: { "User-Agent": "CacheStream" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Extract a .tar.gz into its own folder using the system tar.
 * Subtleties handled:
 *   - Run via the shell on Windows so `tar` resolves to tar.exe.
 *   - Set cwd to the archive's folder and pass only the BASENAME, so
 *     tar never sees the "D:" drive prefix (GNU tar would treat it as
 *     a remote host → "Cannot connect to D:"). Works for both GNU tar
 *     and Windows/macOS bsdtar.
 * Extracts in place (next to the archive); the caller searches there.
 */
function extractTarGz(archive) {
  const dir = dirname(archive);
  const name = basename(archive);
  const useShell = process.platform === "win32";
  const safeName = useShell && /\s/.test(name) ? `"${name}"` : name;
  return spawnSync("tar", ["-xzf", safeName], { cwd: dir, encoding: "utf8", shell: useShell });
}

/** Depth-first search for better_sqlite3.node in an extracted tree. */
function findNode(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "better_sqlite3.node") return full;
    }
  }
  return null;
}

/**
 * Download WiseLibs' prebuilt better-sqlite3 for this Electron ABI and
 * drop it into the staged module. No compiler required. Returns true
 * on success.
 */
async function tryPrebuilt(desktopDir, stage) {
  let abi, ver;
  try { abi = electronAbi(desktopDir); ver = sqliteVersion(stage, desktopDir); }
  catch (e) { console.warn(`[native] prebuilt skipped: ${e.message}`); return false; }

  const plat = process.platform;       // win32 | linux | darwin
  const arch = process.arch;           // x64 | arm64
  const asset = `better-sqlite3-v${ver}-electron-v${abi}-${plat}-${arch}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${ver}/${asset}`;

  const tmpDir = join(stage, ".sqlite-prebuilt");
  const tgz = join(tmpDir, asset);
  console.log(`[native] downloading prebuilt ${asset}`);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    await download(url, tgz);
    const sz = statSync(tgz).size;
    if (sz < 1024) throw new Error(`downloaded archive too small (${sz}B) — likely not the asset`);
    const r = extractTarGz(tgz);
    if (r.status !== 0) {
      throw new Error(`tar failed (code ${r.status}): ${(r.stderr || r.error?.message || "").toString().trim().slice(0, 200)}`);
    }
    const node = findNode(tmpDir);
    if (!node) throw new Error("better_sqlite3.node not found in prebuilt archive");
    const destDir = join(stageModule(stage), "build", "Release");
    mkdirSync(destDir, { recursive: true });
    copyFileSync(node, join(destDir, "better_sqlite3.node"));
    return sqliteAbiOk(desktopDir, stage);
  } catch (e) {
    console.warn(`[native] prebuilt download failed: ${e.message}`);
    return false;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Make the staged better-sqlite3 match Electron's ABI and verify it.
 * Exits non-zero if it can't produce a loadable module.
 */
export function rebuildSqlite(desktopDir, stage) {
  return rebuildSqliteAsync(desktopDir, stage);
}

async function rebuildSqliteAsync(desktopDir, stage) {
  const ver = electronVersion(desktopDir);

  // 1. Fast, compiler-free path: download the matching prebuilt.
  console.log(`[native] matching better-sqlite3 to Electron ${ver}`);
  if (await tryPrebuilt(desktopDir, stage)) {
    writeFileSync(markerPath(stage), ver);
    console.log(`[native] better-sqlite3 prebuilt verified against Electron ${ver}`);
    return;
  }

  // 2. Fallback: compile from source via electron-rebuild (needs a C++
  //    toolchain). Restore the full module first — the Next standalone
  //    trace strips binding.gyp/src/deps, so the staged copy can't build.
  console.log("[native] prebuilt unavailable — falling back to electron-rebuild (needs build tools)");
  const fullSource = join(desktopDir, "..", "web", "node_modules", "better-sqlite3");
  if (existsSync(fullSource)) {
    rmSync(stageModule(stage), { recursive: true, force: true });
    cpSync(fullSource, stageModule(stage), { recursive: true });
  }
  runSafe(npx,
    ["electron-rebuild", "-v", ver, "-m", stage, "-o", "better-sqlite3", "-f", "--build-from-source"],
    desktopDir);

  if (!sqliteAbiOk(desktopDir, stage)) {
    console.error(
      "[native] better-sqlite3 still won't load under Electron's Node.\n" +
      "         The prebuilt download failed AND there's no build toolchain.\n" +
      "         Install one, then re-run `npm run build-web`:\n" +
      "           Windows: Visual Studio Build Tools (Desktop C++) + Python 3\n" +
      "           Linux:   build-essential + python3\n" +
      "         (Or just ensure the machine has internet for the prebuilt.)",
    );
    process.exit(1);
  }
  writeFileSync(markerPath(stage), ver);
  console.log(`[native] better-sqlite3 compiled + verified against Electron ${ver}`);
}
