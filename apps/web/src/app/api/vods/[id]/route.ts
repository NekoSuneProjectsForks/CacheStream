import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type VodSource } from "@/lib/store";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

/** PATCH /api/vods/:id — edit name / loop / url. */
export const PATCH = ownerRoute(async (req, ctx: Ctx) => {
  const patch = await readJson<Partial<VodSource>>(req);
  const v = getStore().updateVod(ctx.params.id, patch);
  if (!v) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ vod: v });
});

/**
 * DELETE /api/vods/:id
 *
 * Removes the row, and if the source is kind='file' AND lives inside
 * the VOD library dir, deletes the file too.
 */
export const DELETE = ownerRoute(async (_req, ctx: Ctx) => {
  const store = getStore();
  const v = store.getVod(ctx.params.id);
  if (!v) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (v.kind === "file") {
    const full = path.resolve(config.vods.libraryDir, v.pathOrUrl);
    const root = path.resolve(config.vods.libraryDir);
    if (full.startsWith(root + path.sep) || full === root) {
      try { await fs.unlink(full); } catch {}
    }
  }
  store.removeVod(ctx.params.id);
  return NextResponse.json({ ok: true });
});
