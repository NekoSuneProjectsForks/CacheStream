// Resolve the app's branding (product name, appId, publish target) from
// the GitHub repo, defaulting to CacheStream. No committed env file is
// involved in the default — the fallback is hardcoded. Precedence,
// highest first:
//
//   1. Explicit override — APP_NAME / APP_ID / GH_OWNER / GH_REPO, from
//      the real process env or an optional gitignored `apps/desktop/.env`.
//   2. GitHub Actions — GITHUB_REPOSITORY ("owner/repo"). CI needs no
//      files; it derives everything from the repo automatically.
//   3. `git remote origin` URL (local checkouts with a remote).
//   4. Hardcoded CacheStream default.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_OWNER = "NekoSuneProjectsForks";
const DEFAULT_REPO = "CacheStream";

/** Parse a KEY=VALUE env file into a plain object (no process.env writes). */
function readEnvFile(name) {
  const p = join(desktopDir, name);
  const out = {};
  if (!existsSync(p)) return out;
  let text = "";
  try { text = readFileSync(p, "utf8"); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function fromGitRemote() {
  try {
    const url = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch { /* no remote */ }
  return null;
}

const cleanName = (s) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "").trim();
const idSegment = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "") || "app";
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";

export function resolveAppMeta() {
  const local = readEnvFile(".env");               // optional gitignored override
  const ov = (k) => process.env[k] ?? local[k];    // explicit override

  const nameOverride = (ov("APP_NAME") || "").trim();

  // owner/repo: explicit override → GITHUB_REPOSITORY → git remote → default
  let owner = (ov("GH_OWNER") || process.env.GITHUB_REPOSITORY_OWNER || "").trim();
  let repo = (ov("GH_REPO") || "").trim();
  if (!repo && process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes("/")) {
    const [o, r] = process.env.GITHUB_REPOSITORY.split("/");
    owner = owner || o;
    repo = r;
  }
  if (!repo) {
    const g = fromGitRemote();
    if (g) { owner = owner || g.owner; repo = g.repo; }
  }
  owner = cleanName(owner) || DEFAULT_OWNER;
  repo = cleanName(repo) || DEFAULT_REPO;

  const productName = cleanName(nameOverride) || repo;   // → repo, else CacheStream
  const appId = (ov("APP_ID") || `com.cachenetworks.${idSegment(productName)}`).trim();
  const copyright = `MIT — ${owner}`;
  const slug = slugify(productName);

  return { productName, appId, owner, repo, copyright, slug };
}

// `node scripts/app-meta.mjs` prints the resolved values (CI debugging).
if (process.argv[1]?.endsWith("app-meta.mjs")) {
  console.log(JSON.stringify(resolveAppMeta(), null, 2));
}
