import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { getStore, type MusicTrack } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/music/cover/:id — extracted album art for the track.
 *
 * Public — the scene page fetches without an auth cookie.
 *
 * Self-healing (v1.18): if the track has no recorded coverPath, or
 * the recorded file has gone missing, we re-parse the audio file and
 * extract the embedded picture on the fly, cache it to the covers
 * dir, and persist the path. This fixes the "no album image even
 * though the file has one" cases where the original scan missed the
 * art (music-metadata not yet installed at first scan, a partial
 * write, a non-standard picture frame, etc.) — a rescan is no longer
 * required to recover it.
 */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const store = getStore();
  const t = store.getMusicTrack(ctx.params.id);
  if (!t) return new Response("not found", { status: 404 });

  const coversDir = path.resolve(config.runtime.dataDir, "covers");
  const inCovers = (f: string | null): f is string =>
    !!f && (f === coversDir || f.startsWith(coversDir + path.sep));

  // 1. Recorded cover, if present + still on disk + inside covers dir.
  let file: string | null = t.coverPath ? path.resolve(t.coverPath) : null;
  if (!inCovers(file) || !file || !fs.existsSync(file)) {
    // 2. Try a live extraction from the source audio file.
    file = await extractCover(t, coversDir);
  }

  if (!inCovers(file)) return new Response("not found", { status: 404 });

  try {
    const buf = fs.readFileSync(file);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": contentTypeFor(file),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("missing", { status: 410 });
  }
}

function contentTypeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

/** Map a music-metadata picture `format` (MIME or bare ext) to a file ext. */
function extFromFormat(fmt?: string): string {
  const f = (fmt || "").toLowerCase();
  if (f.includes("png")) return "png";
  if (f.includes("webp")) return "webp";
  if (f.includes("gif")) return "gif";
  return "jpg"; // jpeg / jpg / image/jpeg / unknown
}

/**
 * Parse the track's audio file and write its first embedded picture
 * into the covers dir, persisting the path on the row. Returns the
 * absolute cover file path, or null if there's no usable art.
 */
async function extractCover(t: MusicTrack, coversDir: string): Promise<string | null> {
  try {
    const audioFile = path.join(config.music.libraryDir, t.path);
    if (!fs.existsSync(audioFile)) return null;

    const mm = await import("music-metadata");
    const meta = await mm.parseFile(audioFile, { skipCovers: false, duration: false });
    const pic = meta.common.picture?.[0];
    if (!pic?.data || pic.data.length === 0) return null;

    fs.mkdirSync(coversDir, { recursive: true });
    const out = path.join(coversDir, `${t.id}.${extFromFormat(pic.format)}`);
    fs.writeFileSync(out, Buffer.from(pic.data));
    getStore().setMusicTrackCover(t.id, out);
    return out;
  } catch (err: any) {
    console.warn("[music/cover] live extract failed:", err?.message || err);
    return null;
  }
}
