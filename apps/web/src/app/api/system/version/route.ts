import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/system/version
 *
 * Reports the panel's current running version + the latest
 * published CacheStream release on GitHub, plus a flag for
 * whether the host has the updater watcher installed (so the
 * UI can decide between "Update" button vs. install-instructions
 * link).
 *
 * Returns:
 *   {
 *     current: "1.9.3",
 *     latest: "1.9.3" | null,
 *     latestUrl: "https://github.com/.../releases/tag/v1.9.3",
 *     updateAvailable: boolean,
 *     updaterInstalled: boolean,
 *     lastCheckedAt: number,
 *   }
 *
 * The GitHub call is rate-limited at 60/hr unauthenticated, so
 * we cache the result for 5 minutes in module-level state. A
 * busted cache just falls back to "unknown latest" and the UI
 * shows the current version with no update prompt — safe degrade.
 */

const RELEASES_URL = "https://api.github.com/repos/cachenetworks/CacheStream/releases/latest";
const CACHE_MS = 5 * 60 * 1000;

let cache: { at: number; latest: string | null; url: string | null } | null = null;

async function fetchLatest(): Promise<{ latest: string | null; url: string | null }> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return { latest: cache.latest, url: cache.url };
  }
  try {
    const r = await fetch(RELEASES_URL, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "CacheStream" },
      // Next caches fetches by default — opt out so version checks
      // aren't frozen to the value at first request post-deploy.
      cache: "no-store",
    });
    if (!r.ok) {
      cache = { at: Date.now(), latest: null, url: null };
      return { latest: null, url: null };
    }
    const body = await r.json();
    // tag_name comes back as "v1.9.3". Strip the v for comparison;
    // keep the original for the URL.
    const tag = String(body.tag_name || "");
    const latest = tag.replace(/^v/, "") || null;
    const url = body.html_url || null;
    cache = { at: Date.now(), latest, url };
    return { latest, url };
  } catch {
    cache = { at: Date.now(), latest: null, url: null };
    return { latest: null, url: null };
  }
}

/**
 * Compare semver-ish version strings ("1.9.3" vs "1.10.0").
 * Returns true if `latest` is strictly newer than `current`.
 * Pre-release suffixes (e.g. "1.9.3-rc1") sort as older than the
 * plain release — same convention npm uses.
 */
function isNewer(latest: string, current: string): boolean {
  const norm = (s: string) => s.split("-")[0].split(".").map((p) => parseInt(p, 10) || 0);
  const [la, lb, lc] = norm(latest);
  const [ca, cb, cc] = norm(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export const GET = ownerRoute(async () => {
  // Pull current from the standalone package.json. process.env.npm_*
  // isn't reliable under Next standalone, so we read the file
  // directly. Path differs between dev (./package.json) and standalone
  // image (/app/package.json) so try a couple.
  const fs = await import("node:fs");
  const path = await import("node:path");
  let current = "0.0.0";
  for (const p of ["/app/package.json", "./package.json", path.join(process.cwd(), "package.json")]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (pkg.version) { current = pkg.version; break; }
    } catch {}
  }

  const { latest, url } = await fetchLatest();

  // The updater watcher (scripts/cachestream-updater.sh) lives on
  // the host and consumes a marker file in /app/data. The panel
  // can't tell whether the watcher is *running*, only whether the
  // operator set it up — we treat the presence of a sentinel file
  // (`.updater-installed`) written by the install script as the
  // signal. If the file isn't there, the UI shows install
  // instructions instead of an "Update" button.
  const dataDir = process.env.DATA_DIR || "/app/data";
  let updaterInstalled = false;
  try { updaterInstalled = fs.existsSync(path.join(dataDir, ".updater-installed")); } catch {}

  return NextResponse.json({
    current,
    latest,
    latestUrl: url,
    updateAvailable: latest ? isNewer(latest, current) : false,
    updaterInstalled,
    lastCheckedAt: cache?.at || Date.now(),
  });
});
