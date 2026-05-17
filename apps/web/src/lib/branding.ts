/**
 * Branding — streamer display name, logo, brand colour.
 *
 * Stored in the existing kv table so we don't need a dedicated
 * schema migration. Logo files live under `<DATA_DIR>/branding/`;
 * the kv row stores only the filename so the path stays portable
 * across container rebuilds.
 *
 * Everything reads / writes through this module so the served
 * surface (scenes, landing page, admin header) stays consistent.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config";
import { kvGet, kvSet, kvDelete } from "./db";

export interface Branding {
  /** Streamer's display name. Shown in the brand ribbon. */
  displayName: string;
  /** Optional tagline shown under the display name in the panel. */
  tagline: string | null;
  /** Brand accent colour (hex). Used as a default for scenes. */
  accent: string | null;
  /** Filename inside `<DATA_DIR>/branding/` of the uploaded logo. */
  logoFile: string | null;
  /** Public URL of the logo (or null when none uploaded). */
  logoUrl: string | null;
}

const DEFAULT_NAME = "CacheStream";

export function getBranding(): Branding {
  const displayName = kvGet("branding_display_name") || DEFAULT_NAME;
  const tagline = kvGet("branding_tagline");
  const accent  = kvGet("branding_accent");
  const logoFile = kvGet("branding_logo_file");
  return {
    displayName,
    tagline,
    accent,
    logoFile,
    logoUrl: logoFile ? `/api/branding/logo?v=${kvGet("branding_logo_v") || "1"}` : null,
  };
}

export function setBranding(patch: Partial<{
  displayName: string;
  tagline: string | null;
  accent: string | null;
}>): Branding {
  if (typeof patch.displayName === "string") {
    const trimmed = patch.displayName.trim().slice(0, 40);
    if (trimmed) kvSet("branding_display_name", trimmed);
    else kvDelete("branding_display_name");
  }
  if (patch.tagline !== undefined) {
    if (patch.tagline) kvSet("branding_tagline", patch.tagline.slice(0, 120));
    else kvDelete("branding_tagline");
  }
  if (patch.accent !== undefined) {
    if (patch.accent && /^#[0-9a-fA-F]{3,8}$/.test(patch.accent)) kvSet("branding_accent", patch.accent);
    else if (patch.accent === null) kvDelete("branding_accent");
  }
  return getBranding();
}

const ALLOWED_LOGO_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]);
const MAX_LOGO_BYTES = 4 * 1024 * 1024;

/** Persist an uploaded logo + bump the cache-buster version. */
export async function saveLogoBytes(name: string, bytes: Uint8Array): Promise<Branding> {
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_LOGO_EXT.has(ext)) {
    throw Object.assign(new Error(`logo must be PNG / JPG / WEBP / SVG / GIF`), { status: 400 });
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw Object.assign(new Error(`logo exceeds 4MB`), { status: 413 });
  }

  const dir = path.resolve(config.runtime.dataDir, "branding");
  fs.mkdirSync(dir, { recursive: true });

  // Delete any existing logo (regardless of ext) so we don't accumulate.
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith("logo.")) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }

  const file = `logo${ext}`;
  fs.writeFileSync(path.join(dir, file), bytes, { mode: 0o644 });
  kvSet("branding_logo_file", file);
  kvSet("branding_logo_v", crypto.randomBytes(4).toString("hex"));
  return getBranding();
}

export function clearLogo(): Branding {
  const dir = path.resolve(config.runtime.dataDir, "branding");
  const file = kvGet("branding_logo_file");
  if (file) {
    try { fs.unlinkSync(path.join(dir, file)); } catch {}
  }
  kvDelete("branding_logo_file");
  kvDelete("branding_logo_v");
  return getBranding();
}

/** Resolve the on-disk path to the current logo, or null. */
export function resolveLogoPath(): string | null {
  const file = kvGet("branding_logo_file");
  if (!file) return null;
  const full = path.resolve(config.runtime.dataDir, "branding", file);
  const root = path.resolve(config.runtime.dataDir, "branding");
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return fs.existsSync(full) ? full : null;
}

/** Mime type for a logo filename. SVG gets the right content-type for sharp render. */
export function logoMimeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".png":  return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".svg":  return "image/svg+xml";
    case ".gif":  return "image/gif";
    default:      return "application/octet-stream";
  }
}
