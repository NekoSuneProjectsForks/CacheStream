/**
 * Centralised, validated runtime config for the web app.
 *
 * Loaded once at module init. Throws synchronously on missing
 * required vars so a misconfigured deploy fails fast rather
 * than silently misbehaving in OAuth.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var: ${name}. Copy .env.example to .env.`
    );
  }
  return v.trim();
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function toBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  const s = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

// At build time inside the Docker `builder` stage we don't
// have a real .env, so we relax validation for `next build`.
// All access happens at request time anyway.
const buildPhase = process.env.NEXT_PHASE === "phase-production-build";

function safeRequired(name: string, fallback: string): string {
  if (buildPhase) return process.env[name]?.trim() || fallback;
  return required(name);
}

const port = Number.parseInt(process.env.WEB_PORT || "7788", 10);
const publicUrl = (optional("PUBLIC_URL", `http://localhost:${port}`)).replace(
  /\/+$/,
  ""
);

export const config = {
  web: {
    port,
    publicUrl,
    trustProxy: toBool(process.env.TRUST_PROXY, false),
  },
  oauth: {
    clientId:     safeRequired("TWITCH_CLIENT_ID", "build-placeholder"),
    clientSecret: safeRequired("TWITCH_CLIENT_SECRET", "build-placeholder"),
    sessionSecret: safeRequired("SESSION_SECRET", "build-placeholder-build-placeholder-build-placeholder-build-placeholder"),
    redirectUri: `${publicUrl}/api/auth/twitch/callback`,
    // v1.2 scopes — broadcaster management, chat, mod actions,
    // EventSub subscriptions. Anyone with a v1.1 session is
    // missing most of these; we detect that and force re-login.
    scopes: [
      "user:read:email",
      "channel:manage:broadcast",
      "channel:read:subscriptions",
      "bits:read",
      "moderation:read",
      "moderator:manage:banned_users",
      "moderator:manage:chat_messages",
      "moderator:read:followers",
      "chat:read",
      "chat:edit",
    ],
    initialOwnerLogin: optional("INITIAL_OWNER_LOGIN").toLowerCase() || null,
  },
  streamer: {
    url: optional("STREAMER_URL", "http://streamer:7789").replace(/\/+$/, ""),
    token: safeRequired("INTERNAL_API_TOKEN", "build-placeholder"),
  },
  scene: {
    defaultUrl: optional("DEFAULT_SCENE_URL", `http://localhost:${port}/scene`),
  },
  runtime: {
    dataDir: optional("DATA_DIR", "data"),
    logLevel: optional("LOG_LEVEL", "info"),
  },
  music: {
    // Path inside the web container where MP3/OGG/FLAC live.
    // Compose mounts ./media/music here from the host.
    libraryDir: optional("MUSIC_LIBRARY_DIR", "/app/media/music"),
  },
  vods: {
    // Path inside the web container where VOD video files live.
    // Compose mounts ./media/vods here from the host (read-write
    // on web, read-only on streamer).
    libraryDir: optional("VOD_LIBRARY_DIR", "/app/media/vods"),
  },
} as const;

export type Config = typeof config;
