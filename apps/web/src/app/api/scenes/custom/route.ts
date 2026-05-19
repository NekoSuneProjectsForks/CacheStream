import { NextResponse } from "next/server";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { getStore, type CustomSceneTemplate, type CustomSceneConfig } from "@/lib/store";
import { isValidSlug, slugify } from "@/lib/slug";

export const dynamic = "force-dynamic";

const TEMPLATES: CustomSceneTemplate[] = [
  "starting_soon", "brb", "ending", "generic", "raw_html",
];

/** GET /api/scenes/custom — list every user-authored scene. */
export const GET = staffRoute(async () => {
  return NextResponse.json({ scenes: getStore().listCustomScenes() });
});

/**
 * POST /api/scenes/custom
 *   { name, template, slug?, config }
 *
 * Slug is auto-derived from the name when omitted. Slug collisions
 * get a numeric suffix.
 */
export const POST = staffRoute(async (req) => {
  const body = await readJson<{
    name?: string;
    template?: string;
    slug?: string;
    config?: CustomSceneConfig;
  }>(req);

  const name = (body.name || "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const template = body.template as CustomSceneTemplate;
  if (!TEMPLATES.includes(template)) {
    return NextResponse.json({ error: `template must be one of ${TEMPLATES.join(", ")}` }, { status: 400 });
  }

  const store = getStore();
  let slug = (body.slug || slugify(name)).toLowerCase();
  if (!isValidSlug(slug)) {
    return NextResponse.json({ error: "slug must match [a-z0-9-], 1–40 chars" }, { status: 400 });
  }

  // Resolve collisions: "demo" -> "demo-2" -> "demo-3" ...
  if (store.getCustomSceneBySlug(slug)) {
    let i = 2;
    while (store.getCustomSceneBySlug(`${slug}-${i}`)) i++;
    slug = `${slug}-${i}`;
  }

  const scene = store.addCustomScene({
    slug, name, template,
    config: body.config || {},
  });
  return NextResponse.json({ scene });
});
