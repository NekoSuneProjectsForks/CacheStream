import { NextResponse } from "next/server";
import { ownerRoute, readJson } from "@/lib/api-helpers";
import { getStore, type CustomSceneTemplate, type CustomSceneConfig } from "@/lib/store";
import { isValidSlug } from "@/lib/slug";

export const dynamic = "force-dynamic";

interface Ctx { params: { id: string } }

const TEMPLATES: CustomSceneTemplate[] = [
  "starting_soon", "brb", "ending", "generic", "raw_html",
];

/** GET /api/scenes/custom/:id — fetch a single scene (for editor hydration). */
export const GET = ownerRoute(async (_req, ctx: Ctx) => {
  const scene = getStore().getCustomSceneById(ctx.params.id);
  if (!scene) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ scene });
});

/** PATCH /api/scenes/custom/:id — partial update. */
export const PATCH = ownerRoute(async (req, ctx: Ctx) => {
  const body = await readJson<{
    name?: string;
    slug?: string;
    template?: string;
    config?: CustomSceneConfig;
  }>(req);

  const patch: any = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.slug === "string") {
    const s = body.slug.toLowerCase();
    if (!isValidSlug(s)) {
      return NextResponse.json({ error: "slug must match [a-z0-9-], 1–40 chars" }, { status: 400 });
    }
    const existing = getStore().getCustomSceneBySlug(s);
    if (existing && existing.id !== ctx.params.id) {
      return NextResponse.json({ error: "slug already in use" }, { status: 409 });
    }
    patch.slug = s;
  }
  if (typeof body.template === "string") {
    if (!TEMPLATES.includes(body.template as CustomSceneTemplate)) {
      return NextResponse.json({ error: "invalid template" }, { status: 400 });
    }
    patch.template = body.template;
  }
  if (body.config && typeof body.config === "object") patch.config = body.config;

  const scene = getStore().updateCustomScene(ctx.params.id, patch);
  if (!scene) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ scene });
});

/** DELETE /api/scenes/custom/:id */
export const DELETE = ownerRoute(async (_req, ctx: Ctx) => {
  const ok = getStore().removeCustomScene(ctx.params.id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
