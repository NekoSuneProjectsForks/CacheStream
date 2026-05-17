import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/music/cover/:id — extracted album art for the track.
 *
 * Public — the scene page fetches without an auth cookie.
 * Returns 404 if the track has no embedded art.
 */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const t = getStore().getMusicTrack(ctx.params.id);
  if (!t || !t.coverPath) return new Response("not found", { status: 404 });

  const coversDir = path.resolve(config.runtime.dataDir, "covers");
  const file = path.resolve(t.coverPath);
  if (!file.startsWith(coversDir + path.sep) && file !== coversDir) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return new Response(buf, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("missing", { status: 410 });
  }
}
