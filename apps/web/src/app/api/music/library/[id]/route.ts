import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/** PATCH /api/music/library/:id — edit metadata (title/artist/album). */
export const PATCH = staffRoute(async (req, ctx: Ctx) => {
  const body = await readJson<{
    title?: string | null;
    artist?: string | null;
    album?: string | null;
    coverPath?: string | null;
  }>(req);
  const t = getStore().updateMusicTrackMeta(ctx.params.id, body);
  if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ track: t });
});

/** DELETE /api/music/library/:id — remove from DB AND delete the file. */
export const DELETE = staffRoute(async (_req, ctx: Ctx) => {
  const store = getStore();
  const t = store.getMusicTrack(ctx.params.id);
  if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Delete the file (best-effort) and its cover (if any). Refuse
  // to delete anything outside MUSIC_LIBRARY_DIR — defence against
  // a bogus row pointing at /etc/passwd.
  const full = path.resolve(config.music.libraryDir, t.path);
  const rootResolved = path.resolve(config.music.libraryDir);
  if (full.startsWith(rootResolved + path.sep) || full === rootResolved) {
    try { await fs.unlink(full); } catch {}
  }
  if (t.coverPath) {
    const coversDir = path.resolve(config.runtime.dataDir, "covers");
    const cov = path.resolve(t.coverPath);
    if (cov.startsWith(coversDir + path.sep)) {
      try { await fs.unlink(cov); } catch {}
    }
  }
  store.removeMusicTrack(ctx.params.id);
  return NextResponse.json({ ok: true });
});
