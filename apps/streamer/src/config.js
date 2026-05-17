"use strict";

const { pickAutoProfile } = require("./autoprofile");

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = false) {
  if (value == null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no",  "n", "off"].includes(s)) return false;
  return fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Build the runtime config.
 *
 * Layer order (highest wins):
 *   1. STREAM_PROFILE=auto  → host-detected defaults
 *      In auto mode the picked profile WINS over stale per-knob
 *      env vars. This matches the user's intent of "let it
 *      figure out", and prevents an old .env with 1080p settings
 *      from defeating auto-tuning on a Pi.
 *   2. STREAM_PROFILE=manual + explicit env var
 *   3. STREAM_PROFILE=manual + hard-coded fallback
 *
 * To override a single knob while still using auto mode, set
 *   STREAM_PROFILE=manual STREAM_WIDTH=1280 …
 * (or remove STREAM_PROFILE entirely to fall back to v1.5
 *  behaviour where individual env vars won).
 */
function buildConfig({ logger } = {}) {
  const profileMode = (process.env.STREAM_PROFILE?.trim() || "auto").toLowerCase();
  const auto = profileMode === "auto" ? pickAutoProfile(logger) : null;

  const envVal = (name) => {
    const v = process.env[name];
    return v == null || v.trim() === "" ? undefined : v.trim();
  };

  // Resolution order, highest wins:
  //   1. Explicit env var set to a non-empty value (operator
  //      override — e.g. STREAM_VIDEO_CODEC=libx264 to force off
  //      a broken HW encoder).
  //   2. Auto-profile pick for the detected host.
  //   3. Hard-coded fallback.
  // An empty-string env var is treated as "not set" so existing
  // `.env` files with blanked fields fall through cleanly.
  const pickInt = (envName, autoKey, fallback) => {
    const v = envVal(envName);
    if (v !== undefined) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
    if (auto && auto.profile[autoKey] !== undefined) return auto.profile[autoKey];
    return fallback;
  };
  const pickStr = (envName, autoKey, fallback) => {
    const v = envVal(envName);
    if (v !== undefined) return v;
    if (auto && auto.profile[autoKey] !== undefined) return String(auto.profile[autoKey]);
    return fallback;
  };

  return {
    api: {
      port: toInt(process.env.STREAMER_PORT, 7789),
      token: required("INTERNAL_API_TOKEN"),
    },
    twitch: {
      streamKey: process.env.TWITCH_STREAM_KEY?.trim() || "",
      ingestUrl: process.env.TWITCH_INGEST_URL?.trim() || "rtmp://live.twitch.tv/app",
    },
    scene: {
      defaultUrl: process.env.DEFAULT_SCENE_URL?.trim() || "http://web:7788/scene",
    },
    video: {
      width:  pickInt("STREAM_WIDTH",  "width",  1920),
      height: pickInt("STREAM_HEIGHT", "height", 1080),
      fps:    pickInt("STREAM_FPS",    "fps",    30),
      bitrateKbps: pickInt("STREAM_VIDEO_BITRATE", "bitrateKbps", 4500),
      maxrateKbps: pickInt("STREAM_VIDEO_MAXRATE", "maxrateKbps", 4500),
      bufsizeKbps: pickInt("STREAM_VIDEO_BUFSIZE", "bufsizeKbps", 9000),
      preset:     pickStr("STREAM_PRESET",    "preset",      "veryfast"),
      // 0 = let x264 pick (= num cores). Pin to 2/3 on small VPSes.
      x264Threads: pickInt("STREAM_X264_THREADS", "x264Threads", 0),
      // Tune profile. zerolatency is the legacy default but disables
      // x264 lookahead. Empty string → no -tune passed at all.
      tune: pickStr("STREAM_X264_TUNE", "tune", "zerolatency"),
      // JPEG quality CDP screencast asks Chromium for.
      screencastQuality: pickInt("STREAM_SCREENCAST_QUALITY", "screencastQuality", 70),
      // Capture every Nth frame from CDP.
      captureEveryNthFrame: Math.max(1, pickInt("STREAM_CAPTURE_EVERY_NTH", "captureEveryNthFrame", 1)),
      // Preferred codec — auto-profile may set this to a hardware
      // encoder (h264_v4l2m2m on a Pi, etc.). Operator can force
      // libx264 with STREAM_VIDEO_CODEC=libx264.
      codec: pickStr("STREAM_VIDEO_CODEC", "codec", "libx264"),
    },
    audio: {
      bitrateKbps: pickInt("STREAM_AUDIO_BITRATE", "audioBitrateKbps", 128),
    },
    runtime: {
      logLevel: process.env.LOG_LEVEL?.trim() || "info",
      reconnectDelayMs: toInt(process.env.RECONNECT_DELAY_SECONDS, 5) * 1000,
      autoStart: toBool(process.env.AUTO_START_STREAM, false),
      profileMode,
      // The full auto-profile object is exposed for /status so the
      // panel can show what the streamer auto-picked.
      autoProfile: auto ? { ...auto.profile, host: auto.host } : null,
      // Thermal monitoring is on by default but skips itself if
      // /sys/class/thermal/thermal_zone0/temp doesn't exist.
      thermalMonitor: toBool(process.env.STREAM_THERMAL_MONITOR, true),
      thermalThrottleC: toInt(process.env.STREAM_THERMAL_THROTTLE_C, 80),
      thermalRecoverC:  toInt(process.env.STREAM_THERMAL_RECOVER_C,  68),
    },
  };
}

module.exports = { buildConfig };
