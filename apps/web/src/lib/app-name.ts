/**
 * App display name for the web panel + scenes.
 *
 * The desktop app resolves the name from the repo (default "CacheStream")
 * and passes it into the web server process as APP_NAME, so the whole
 * suite renames when the repo is renamed — matching the desktop installer
 * / window title. Everything that needs a *default* brand or page title
 * reads it here.
 *
 * Note: APP_NAME is a server-side runtime env var. In the browser it
 * isn't present, so client components fall back to "CacheStream"; the
 * server-rendered titles + the branding API (which uses this as the
 * default displayName) carry the real name.
 */
export function appName(): string {
  return (typeof process !== "undefined" && process.env.APP_NAME?.trim()) || "CacheStream";
}
