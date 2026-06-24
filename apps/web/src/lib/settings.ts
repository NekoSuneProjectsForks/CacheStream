/**
 * Panel-managed settings.
 *
 * Lives on top of the existing `kv` table. Values that USED to be
 * required in .env are now stored here and edited via the setup
 * wizard / panel forms. Reads cascade:
 *
 *   1. kv (panel-set value)         ← source of truth
 *   2. process.env legacy fallback  ← v1.6 .env users still work
 *   3. hard-coded default           ← used by the wizard pre-fill
 *
 * That gives us a clean migration path: existing deployments with
 * old `.env` files keep working unchanged; new deployments use the
 * wizard and never touch .env at all.
 *
 * The setup wizard writes everything through `setSetting`, which
 * persists to kv and (for OAuth credentials) reloads any worker
 * that depended on the previous value.
 */

import crypto from "node:crypto";
import { kvGet, kvSet, kvDelete } from "./db";

/**
 * Every setting we can read OR write. Keys are flat strings to keep
 * the kv schema portable. Each entry documents its source of truth
 * (panel vs env), default behaviour, and any side effects.
 */
const SETTINGS = {
  // ---- Bootstrap (still env-only) ----------------------------------
  // PUBLIC_URL, WEB_PORT, TRUST_PROXY, DATA_DIR, INTERNAL_API_TOKEN
  // stay in env because they're needed before SQLite is even open.
  // (Not part of this module — see lib/config.ts.)

  // ---- OAuth dev app (panel-managed via setup wizard) -------------
  twitch_client_id: {
    envKey: "TWITCH_CLIENT_ID",
    default: "",
    sensitive: false,
  },
  twitch_client_secret: {
    envKey: "TWITCH_CLIENT_SECRET",
    default: "",
    sensitive: true,
  },

  // ---- Kick OAuth app (multi-platform) ---------------------------
  kick_client_id: {
    envKey: "KICK_CLIENT_ID",
    default: "",
    sensitive: false,
  },
  kick_client_secret: {
    envKey: "KICK_CLIENT_SECRET",
    default: "",
    sensitive: true,
  },

  // ---- OAuth relay (broker) mode ---------------------------------
  // "public" — log in through the hosted relay (no per-user keys).
  // "local"  — direct OAuth with the user's OWN client id + secret
  //            (entered below). Default public.
  oauth_relay_mode: {
    envKey: "OAUTH_RELAY_MODE",
    default: "public",
    sensitive: false,
  },

  // ---- Session signing (auto-generated on first boot) -------------
  session_secret: {
    envKey: "SESSION_SECRET",
    default: "", // see `getOrCreateSessionSecret` below
    sensitive: true,
  },

  // ---- Streamer encoder overrides (optional, normally auto) -------
  // Each maps to a STREAM_* env var for back-compat.
  stream_width:               { envKey: "STREAM_WIDTH",            default: "", sensitive: false },
  stream_height:              { envKey: "STREAM_HEIGHT",           default: "", sensitive: false },
  stream_fps:                 { envKey: "STREAM_FPS",              default: "", sensitive: false },
  stream_bitrate_kbps:        { envKey: "STREAM_VIDEO_BITRATE",    default: "", sensitive: false },
  stream_max_bitrate_kbps:    { envKey: "STREAM_VIDEO_MAXRATE",    default: "", sensitive: false },
  stream_buf_kbps:            { envKey: "STREAM_VIDEO_BUFSIZE",    default: "", sensitive: false },
  stream_audio_bitrate_kbps:  { envKey: "STREAM_AUDIO_BITRATE",    default: "", sensitive: false },
  stream_preset:              { envKey: "STREAM_PRESET",           default: "", sensitive: false },
  stream_codec:               { envKey: "STREAM_VIDEO_CODEC",      default: "", sensitive: false },
  stream_x264_threads:        { envKey: "STREAM_X264_THREADS",     default: "", sensitive: false },
  stream_x264_tune:           { envKey: "STREAM_X264_TUNE",        default: "", sensitive: false },
  stream_screencast_quality:  { envKey: "STREAM_SCREENCAST_QUALITY", default: "", sensitive: false },
  stream_capture_every_nth:   { envKey: "STREAM_CAPTURE_EVERY_NTH", default: "", sensitive: false },
  stream_profile_mode:        { envKey: "STREAM_PROFILE",          default: "auto", sensitive: false },

  // ---- Runtime behaviour (optional) -------------------------------
  log_level:                  { envKey: "LOG_LEVEL",                default: "info",  sensitive: false },
  reconnect_delay_seconds:    { envKey: "RECONNECT_DELAY_SECONDS",  default: "5",     sensitive: false },
  auto_start_stream:          { envKey: "AUTO_START_STREAM",        default: "false", sensitive: false },

  // ---- Setup state ------------------------------------------------
  setup_complete:             { envKey: "",  default: "0",  sensitive: false },
  setup_started_at:           { envKey: "",  default: "",   sensitive: false },
} as const;

export type SettingKey = keyof typeof SETTINGS;

/** Read a setting. kv > env > default. */
export function getSetting<K extends SettingKey>(key: K): string {
  const v = kvGet(key);
  if (v != null && v !== "") return v;
  const meta = SETTINGS[key];
  if (meta.envKey) {
    const env = process.env[meta.envKey]?.trim();
    if (env) return env;
  }
  return meta.default;
}

/** Write a setting. Empty / null deletes the kv row → falls back to env / default. */
export function setSetting<K extends SettingKey>(key: K, value: string | null): void {
  if (value == null || value === "") {
    kvDelete(key);
  } else {
    kvSet(key, value);
  }
}

/**
 * Read-many. Returns an object keyed by setting name with the
 * resolved value for each. Doesn't expose `sensitive` values
 * (they get returned as a single bullet character) — callers
 * that need the raw value should call `getSetting` directly.
 */
export function getPublicSettings(): Record<SettingKey, string> {
  const out = {} as Record<SettingKey, string>;
  for (const key of Object.keys(SETTINGS) as SettingKey[]) {
    const v = getSetting(key);
    out[key] = SETTINGS[key].sensitive && v ? "•".repeat(8) : v;
  }
  return out;
}

/**
 * SESSION_SECRET self-generates on first use if neither kv nor env
 * has provided one. We persist the generated value so cookies stay
 * valid across container restarts (a fresh secret every boot would
 * log everyone out every restart).
 */
export function getOrCreateSessionSecret(): string {
  let s = getSetting("session_secret");
  if (s) return s;
  s = crypto.randomBytes(48).toString("hex");
  setSetting("session_secret", s);
  return s;
}

/** True once the wizard has completed all required steps. */
export function isSetupComplete(): boolean {
  // Also treat presence of TWITCH_CLIENT_ID in env as "setup done"
  // so existing v1.6 .env deployments don't get the wizard.
  if (getSetting("setup_complete") === "1") return true;
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) return true;
  return false;
}

export function markSetupComplete(): void {
  setSetting("setup_complete", "1");
}

/** The minimum a fresh deploy needs before the wizard can mark itself done. */
export function setupRequirements(): {
  hasPublicUrl: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasSessionSecret: boolean;
  hasOwnerLogin: boolean;
} {
  return {
    hasPublicUrl:     !!process.env.PUBLIC_URL?.trim(),
    hasClientId:      !!getSetting("twitch_client_id"),
    hasClientSecret:  !!getSetting("twitch_client_secret"),
    hasSessionSecret: !!getSetting("session_secret"),
    // Owner is tracked separately in the existing owner row.
    // The wizard hands off to the OAuth flow which creates it.
    hasOwnerLogin:    false,
  };
}
