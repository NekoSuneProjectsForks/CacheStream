import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ownerRoute } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import { musicEngine } from "@/lib/music";

export const dynamic = "force-dynamic";

// Disable Next's default body parser size cap so large files
// (album lossless rips can be 50–80 MB) come through.
export const maxDuration = 300;
export const fetchCache = "force-no-store";

const ALLOWED_EXT = new Set([".mp3", ".m4a", ".ogg", ".oga", ".flac", ".wav", ".opus"]);
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB ceiling per file

/**
 * POST /api/music/upload
 *
 * Accepts multipart/form-data with one or more `file` fields.
 * Files are written into MUSIC_LIBRARY_DIR with their original
 * names (collisions get a `(2)`, `(3)`, … suffix). After upload
 * the library is rescanned so the new files get tagged + cover
 * art extracted in one pass.
 */
export const POST = ownerRoute(async (req: NextRequest) => {
  const form = await req.formData();
  const files = form.getAll("file");

  if (!files.length) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }

  await fs.mkdir(config.music.libraryDir, { recursive: true });

  const written: string[] = [];
  for (const f of files) {
    if (!(f instanceof File)) continue;
    const ext = path.extname(f.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return NextResponse.json({ error: `unsupported file: ${f.name}` }, { status: 400 });
    }
    if (f.size > MAX_BYTES) {
      return NextResponse.json({ error: `${f.name} exceeds 200MB` }, { status: 413 });
    }

    const safeBase = f.name.replace(/[/\\:*?"<>|]+/g, "_");
    let target = path.join(config.music.libraryDir, safeBase);
    let i = 2;
    while (await exists(target)) {
      const stem = path.basename(safeBase, ext);
      target = path.join(config.music.libraryDir, `${stem} (${i})${ext}`);
      i++;
    }

    const buf = Buffer.from(await f.arrayBuffer());
    await fs.writeFile(target, buf);
    written.push(path.basename(target));
  }

  // Re-scan to populate tag metadata + covers for newly uploaded files.
  const tracks = await musicEngine().scanLibrary();
  return NextResponse.json({ uploaded: written, tracks });
});

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
