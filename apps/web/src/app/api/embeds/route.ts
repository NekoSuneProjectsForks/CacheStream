import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { staffRoute, readJson } from "@/lib/api-helpers";
import { kvGet, kvSet, kvDelete } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Browser-source embeds (v1.11.0).
 *
 * Lets operators drop arbitrary URL widgets — Streamlabs / Stream
 * Elements alerts, NightBot timers, donation tickers, Twitch
 * Sound Alerts dashboards, custom Carbon widgets — into a scene
 * as full-screen iframes. The headless Chromium renders them as
 * part of the broadcast, the streamer captures the page as
 * normal, so all the panel's overlays still composite on top.
 *
 * Storage: kv key `embeds:list` holds a JSON array of:
 *   { slug, name, url, width?, height?, transparent?, createdAt }
 *
 * Each embed gets a stable slug used in the scene URL:
 *   http://web:7788/scene/embed/<slug>
 *
 * That scene route renders a single iframe pointing at `url`.
 * `transparent` enables the `<body style="background:transparent">`
 * trick so the iframe layers cleanly over a background scene
 * via the CSS chroma stack (future work — for now embeds are
 * full-bleed, opaque).
 */

export interface Embed {
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    || crypto.randomBytes(4).toString("hex");
}

/** GET /api/embeds — list all configured browser-source embeds. */
export const GET = staffRoute(async () => {
  return NextResponse.json(readAll());
});

/**
 * POST /api/embeds — create a new embed.
 * Body: { name, url, width?, height?, transparent? }
 *
 * URL must be http:// or https://. The Chromium scene loads
 * untrusted third-party origins inside a sandboxed iframe so
 * even a hostile widget can't read the panel's cookies or hit
 * /api routes — but operators should still only embed sources
 * they trust, because the iframe can still consume CPU + render
 * arbitrary visuals over the broadcast.
 */
export const POST = staffRoute(async (req) => {
  const body = await readJson<Partial<Embed>>(req);
  if (!body.name || !body.url) {
    return NextResponse.json({ error: "name and url required" }, { status: 400 });
  }
  if (!/^https?:\/\//.test(body.url)) {
    return NextResponse.json({ error: "url must be http:// or https://" }, { status: 400 });
  }

  const list = readAll();
  // Generate a unique slug — append a short suffix if the base
  // collides so operators can have two "Alerts" embeds without
  // them stomping on each other.
  let slug = slugify(body.name);
  if (list.some((e) => e.slug === slug)) {
    slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
  }

  const entry: Embed = {
    slug,
    name: body.name.trim().slice(0, 60),
    url: body.url.trim(),
    width:  typeof body.width  === "number" && body.width  > 0 ? Math.min(body.width,  4096) : null,
    height: typeof body.height === "number" && body.height > 0 ? Math.min(body.height, 4096) : null,
    transparent: !!body.transparent,
    createdAt: Date.now(),
  };
  list.push(entry);
  writeAll(list);
  return NextResponse.json(entry);
});
