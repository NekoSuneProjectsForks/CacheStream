import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/system/update
 *
 * Writes a marker file at /app/data/.update-requested. The
 * `cachestream-updater.sh` script (a host-side systemd unit
 * installed via scripts/install-updater.sh) is watching for
 * that file; when it appears, the script runs:
 *
 *   git pull && docker compose pull && docker compose up -d --build
 *
 * …and then deletes the marker. The web container itself can't
 * run those commands — Node inside the container has no access
 * to docker.sock and shouldn't have. The marker pattern keeps
 * the privileged work on the host where it belongs.
 *
 * Body: optional `{ target?: "latest" | "<tag>" }`. Defaults to
 * "latest" (the script will `git pull` to whatever main has).
 *
 * The route is safe to call without the watcher installed —
 * we'll happily write a marker that nothing reads. The UI gates
 * the button on the watcher being present so this is mostly
 * defence-in-depth.
 */
export const POST = ownerRoute(async (req) => {
  const body = (await req.json().catch(() => ({}))) as { target?: string };
  const target = (body.target || "latest").slice(0, 64).replace(/[^A-Za-z0-9._-]/g, "");

  const dataDir = process.env.DATA_DIR || "/app/data";
  const markerPath = path.join(dataDir, ".update-requested");
  const installedPath = path.join(dataDir, ".updater-installed");

  if (!fs.existsSync(installedPath)) {
    return NextResponse.json({
      error: "updater not installed on host. See scripts/install-updater.sh.",
    }, { status: 412 });
  }

  // Atomic-ish write: write to a tmp file then rename so the
  // watcher never sees a half-written marker. Content carries the
  // requested target + a timestamp so the script can decide what
  // to do (and so a stale marker from a crashed previous attempt
  // can be detected and re-run).
  const tmp = markerPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({
    target,
    requestedAt: Date.now(),
  }) + "\n");
  fs.renameSync(tmp, markerPath);

  return NextResponse.json({ ok: true, target, queued: true });
});

/**
 * GET /api/system/update
 *
 * Polls whether an update is currently in progress. The watcher
 * deletes the marker file when it completes successfully, so a
 * present marker = "still running". The UI uses this to disable
 * the button + show a spinner during the update window.
 */
export const GET = ownerRoute(async () => {
  const dataDir = process.env.DATA_DIR || "/app/data";
  const markerPath = path.join(dataDir, ".update-requested");
  const logPath = path.join(dataDir, ".update-log");

  let inFlight = false;
  let requestedAt: number | null = null;
  try {
    const buf = fs.readFileSync(markerPath, "utf8");
    inFlight = true;
    const parsed = JSON.parse(buf);
    requestedAt = parsed.requestedAt || null;
  } catch {
    // ENOENT is the happy path — no update in flight.
  }

  let lastLog: string | null = null;
  try { lastLog = fs.readFileSync(logPath, "utf8").slice(-2000); } catch {}

  return NextResponse.json({ inFlight, requestedAt, lastLog });
});
