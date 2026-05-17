import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { ownerRoute } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // long uploads for big VOD files

const ALLOWED_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

/**
 * POST /api/vods/upload
 *
 * Multipart upload of one or more video files. Each becomes a
 * vod_sources row (kind=file). Existing rows with the same filename
 * are kept — uploads with name collisions get a `(2)` suffix.
 */
export const POST = ownerRoute(async (req: NextRequest) => {
  const form = await req.formData();
  const files = form.getAll("file");
  if (!files.length) return NextResponse.json({ error: "no files" }, { status: 400 });

  await fs.mkdir(config.vods.libraryDir, { recursive: true });

  const store = getStore();
  const created = [];
  for (const f of files) {
    if (!(f instanceof File)) continue;
    const ext = path.extname(f.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return NextResponse.json({ error: `unsupported: ${f.name}` }, { status: 400 });
    }
    if (f.size > MAX_BYTES) {
      return NextResponse.json({ error: `${f.name} exceeds 4GB` }, { status: 413 });
    }

    const safeBase = f.name.replace(/[/\\:*?"<>|]+/g, "_");
    let target = path.join(config.vods.libraryDir, safeBase);
    let i = 2;
    while (await exists(target)) {
      const stem = path.basename(safeBase, ext);
      target = path.join(config.vods.libraryDir, `${stem} (${i})${ext}`);
      i++;
    }

    const buf = Buffer.from(await f.arrayBuffer());
    await fs.writeFile(target, buf);

    const row = store.addVod({
      name: path.basename(target, ext),
      kind: "file",
      pathOrUrl: path.basename(target),
      durationS: null,
      sizeBytes: f.size,
      loop: false,
    });
    created.push(row);
  }

  return NextResponse.json({ vods: created });
});

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
