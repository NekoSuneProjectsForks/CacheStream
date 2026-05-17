import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

const ALLOWED_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);

/**
 * POST /api/vods/scan
 *
 * Walks MEDIA_VODS_DIR and adds any file that isn't already
 * represented as a vod_sources row. Useful when files were
 * SFTP'd in directly rather than uploaded through the panel.
 */
export const POST = ownerRoute(async () => {
  const dir = config.vods.libraryDir;
  try { await fs.access(dir); } catch { return NextResponse.json({ added: 0, vods: [] }); }

  const existing = new Set(getStore().listVods()
    .filter((v) => v.kind === "file")
    .map((v) => v.pathOrUrl));

  let added = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    if (existing.has(e.name)) continue;

    const stat = await fs.stat(path.join(dir, e.name));
    getStore().addVod({
      name: path.basename(e.name, ext),
      kind: "file",
      pathOrUrl: e.name,
      durationS: null,
      sizeBytes: stat.size,
      loop: false,
    });
    added++;
  }

  return NextResponse.json({ added, vods: getStore().listVods() });
});
