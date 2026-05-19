import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { kvGet, kvSet } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Per-embed CRUD.
 *
 *   GET    /api/embeds/<slug>  → public (scene route uses it)
 *   PATCH  /api/embeds/<slug>  → owner-only
 *   DELETE /api/embeds/<slug>  → owner-only
 *
 * GET is intentionally public-ish (no ownerRoute) because the
 * scene page at /scene/embed/<slug> runs inside the streamer's
 * headless Chromium and has no OAuth cookie. The slug-keyed URL
 * is treated as a capability — anyone who knows the slug can
 * read the embed URL, which is the same trust model as a public
 * scene URL.
 */

interface Embed {
  slug: string;
  name: string;
  url: string;
  width: number | null;
  height: number | null;
  transparent: boolean;
  createdAt: number;
}

function readAll(): Embed[] {
  const raw = kvGet("embeds:list");
  if (!raw) return [];
  try { return JSON.parse(raw) as Embed[]; }
  catch { return []; }
}
function writeAll(list: Embed[]): void {
  kvSet("embeds:list", JSON.stringify(list));
}

export async function GET(_: Request, { params }: { params: { slug: string } }) {
  const entry = readAll().find((e) => e.slug === params.slug);
  if (!entry) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(entry);
}

export const PATCH = ownerRoute(async (req, { params }: { params: { slug: string } }) => {
  const patch = await readJson<Partial<Embed>>(req);
  const list = readAll();
  const i = list.findIndex((e) => e.slug === params.slug);
  if (i < 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const cur = list[i];
  const next: Embed = {
    ...cur,
    ...(patch.name        !== undefined ? { name: String(patch.name).trim().slice(0, 60) } : {}),
    ...(patch.url         !== undefined ? { url:  String(patch.url).trim() } : {}),
    ...(patch.width       !== undefined ? { width:  typeof patch.width  === "number" && patch.width  > 0 ? Math.min(patch.width,  4096) : null } : {}),
    ...(patch.height      !== undefined ? { height: typeof patch.height === "number" && patch.height > 0 ? Math.min(patch.height, 4096) : null } : {}),
    ...(patch.transparent !== undefined ? { transparent: !!patch.transparent } : {}),
  };
  // Reject URL changes that don't look like real http(s).
  if (next.url && !/^https?:\/\//.test(next.url)) {
    return NextResponse.json({ error: "url must be http:// or https://" }, { status: 400 });
  }
  list[i] = next;
  writeAll(list);
  return NextResponse.json(next);
});

export const DELETE = ownerRoute(async (_req, { params }: { params: { slug: string } }) => {
  const list = readAll();
  const next = list.filter((e) => e.slug !== params.slug);
  if (next.length === list.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  writeAll(next);
  return NextResponse.json({ ok: true });
});
