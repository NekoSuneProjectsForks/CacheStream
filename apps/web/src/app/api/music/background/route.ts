import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { ownerRoute } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import { kvGet, kvSet } from "@/lib/db";
import { setVisualizerConfig } from "@/lib/visualizer";

export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function bgPath(ext: string): string {
  return path.join(config.runtime.dataDir, `music-bg.${ext}`);
}

function currentBg(): { ext: string; file: string } | null {
  const ext = kvGet("music_bg_ext");
  if (!ext) return null;
  const file = bgPath(ext);
  return fs.existsSync(file) ? { ext, file } : null;
}

/**
 * GET /api/music/background — public binary stream of the uploaded
 * music-scene background. 404 when none, so the scene falls back to its
 * built-in gradient.
 */
export async function GET() {
  const cur = currentBg();
  if (!cur) return new NextResponse("no background", { status: 404 });
  const buf = fs.readFileSync(cur.file);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": `image/${cur.ext === "jpg" ? "jpeg" : cur.ext}`,
      "Cache-Control": "no-store",
    },
  });
}

/** POST /api/music/background — multipart upload of one background image. */
export const POST = ownerRoute(async (req: NextRequest) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    return NextResponse.json({ error: "must be PNG, JPEG, WebP or GIF" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "image exceeds 20MB" }, { status: 413 });
  }

  fs.mkdirSync(config.runtime.dataDir, { recursive: true });
  // Remove any previous background of a different extension.
  const prev = kvGet("music_bg_ext");
  if (prev && prev !== ext) { try { fs.unlinkSync(bgPath(prev)); } catch {} }

  const bytes = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(bgPath(ext), bytes);
  kvSet("music_bg_ext", ext);

  // Point the scene at it with a cache-busting token so a re-upload
  // refreshes immediately (the scene polls config every ~5s).
  const url = `/api/music/background?v=${bytes.length}-${ext}`;
  const visualizer = setVisualizerConfig({ background: url });
  return NextResponse.json({ ok: true, visualizer });
});

/** DELETE /api/music/background — remove the background, revert to gradient. */
export const DELETE = ownerRoute(async () => {
  const ext = kvGet("music_bg_ext");
  if (ext) { try { fs.unlinkSync(bgPath(ext)); } catch {} }
  kvSet("music_bg_ext", "");
  const visualizer = setVisualizerConfig({ background: "" });
  return NextResponse.json({ ok: true, visualizer });
});
