import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/music/file/:id
 *
 * Stream the raw audio file. Used by the /scene/music visualizer
 * to fetch the same track Chromium is rendering so it can
 * analyse the audio in the browser (Web Audio AnalyserNode).
 *
 * Public (no auth) so the headless browser can fetch without
 * an owner cookie. Content is the raw audio — the scene URL is
 * only exposed inside your network anyway.
 *
 * Supports HTTP Range so the <audio> element can seek.
 */
export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const track = getStore().getMusicTrack(ctx.params.id);
  if (!track) return new Response("not found", { status: 404 });

  const full = path.resolve(config.music.libraryDir, track.path);
  const root = path.resolve(config.music.libraryDir);
  if (!full.startsWith(root + path.sep) && full !== root) {
    return new Response("forbidden", { status: 403 });
  }

  let stat: fs.Stats;
  try { stat = fs.statSync(full); }
  catch { return new Response("file missing", { status: 410 }); }

  const range = req.headers.get("range");
  const total = stat.size;
  const ext = path.extname(full).slice(1).toLowerCase();
  const ct  = mimeFor(ext);

  if (range) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end   = m[2] ? Number(m[2]) : total - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(full, { start, end });
      return new Response(toWebStream(stream), {
        status: 206,
        headers: {
          "Content-Type": ct,
          "Content-Length": String(chunkSize),
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        },
      });
    }
  }

  return new Response(toWebStream(fs.createReadStream(full)), {
    headers: {
      "Content-Type": ct,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    },
  });
}

function mimeFor(ext: string): string {
  switch (ext) {
    case "mp3":  return "audio/mpeg";
    case "m4a":  return "audio/mp4";
    case "ogg":
    case "oga":  return "audio/ogg";
    case "flac": return "audio/flac";
    case "wav":  return "audio/wav";
    case "opus": return "audio/opus";
    default:     return "application/octet-stream";
  }
}

function toWebStream(node: fs.ReadStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      node.on("data", (chunk) => controller.enqueue(chunk));
      node.on("end",  () => controller.close());
      node.on("error", (err) => controller.error(err));
    },
    cancel() { node.destroy(); },
  });
}
