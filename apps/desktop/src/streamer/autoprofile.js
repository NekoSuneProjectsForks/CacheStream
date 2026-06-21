"use strict";

/**
 * Auto-adaptive CPU profile.
 *
 * Detects the host (CPU model, cores, arch, RAM, Pi presence,
 * hardware encoder availability) and produces a tuned encoder
 * profile so a fresh `docker compose up` works well on
 * anything from a Raspberry Pi 4 to a 16-core server.
 *
 * Why this exists:
 *   - The streamer's default profile is 1080p30 @ 4500 kbps with
 *     libx264 `veryfast`, which saturates a Pi 4 (it can't
 *     actually keep up with 1080p30 software-encoded x264).
 *   - On a real server the same defaults are wasteful — we have
 *     plenty of headroom for higher-quality settings.
 *
 * The profile is picked once at boot and exposed via
 * `pickAutoProfile(logger)`. Live throttling (e.g. when a Pi
 * thermal-throttles) happens in thermal.js.
 *
 * Operator overrides always win: any STREAM_* env var set to a
 * non-default value is respected (see config.js — this module
 * just supplies the defaults config.js uses when env vars are
 * absent or `auto`).
 */

const fs = require("node:fs");
const os = require("node:os");
const { execSync, spawnSync } = require("node:child_process");

// ---- Host detection --------------------------------------------

function readFile(path) {
  try { return fs.readFileSync(path, "utf8"); } catch { return ""; }
}

function detectHost() {
  const arch = os.arch(); // "x64", "arm64", "arm"
  const cores = os.cpus()?.length || 1;
  const cpuModel = os.cpus()?.[0]?.model || "unknown";
  const totalMemGB = Math.round(os.totalmem() / (1024 ** 3) * 10) / 10;

  // /proc/cpuinfo tells us if we're on a Pi (and which model).
  const cpuinfo = readFile("/proc/cpuinfo");
  const piModel = (cpuinfo.match(/Model\s*:\s*(.+)/i) || [])[1] || null;
  const isPi = /raspberry pi/i.test(piModel || "") || /BCM\d+/i.test(cpuModel);

  // Pi 5 dropped the v4l2m2m H.264 encoder block — the BCM2712 has
  // no fixed-function H.264 hardware. We must NOT pick h264_v4l2m2m
  // on a Pi 5 even though the FFmpeg binary still lists it.
  // Also check the Hardware field (BCM2712) as a fallback in case
  // the Model string is absent or formatted differently in future firmware.
  const isPi5 = /raspberry pi 5/i.test(piModel || "") || /BCM2712/i.test(cpuinfo);

  // Generic "weak ARM box" detector: ARM with <= 4 cores or <= 4 GB RAM.
  const isWeakArm = (arch === "arm" || arch === "arm64") && (cores <= 4 || totalMemGB <= 4);

  return { arch, cores, cpuModel, totalMemGB, piModel, isPi, isPi5, isWeakArm };
}

// ---- Hardware encoder probing ----------------------------------

// FFMPEG_PATH lets the Electron desktop build point at its bundled
// static binary (there's no ffmpeg on PATH on Windows). In Docker it's
// unset and we fall back to the PATH `ffmpeg`.
function ffmpegBin() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function ffmpegEncoders() {
  try {
    // Quote the path so spaces in a Windows install dir survive the
    // shell. `2>NUL`/`2>/dev/null` differ per-OS, so just drop the
    // redirect and let stderr flow to our (ignored) parent stderr.
    const out = execSync(`"${ffmpegBin()}" -hide_banner -encoders`, {
      encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"],
    });
    return out;
  } catch {
    return "";
  }
}

/**
 * Authoritatively test whether an encoder actually works on THIS
 * machine by encoding a few frames of a test pattern. This is the only
 * reliable cross-platform (Windows / macOS / Linux) way to tell a real
 * GPU encoder (NVIDIA NVENC, AMD AMF, Intel QSV, Apple VideoToolbox)
 * from one that ffmpeg merely lists as compiled-in. The Linux-only
 * /dev/nvidia* + /dev/dri device checks this replaces never matched on
 * Windows, so the desktop app always fell back to CPU libx264.
 *
 * spawnSync WITHOUT a shell so the bundled ffmpeg path (which may
 * contain spaces) is passed verbatim as argv[0].
 */
function canEncode(codec) {
  try {
    const r = spawnSync(ffmpegBin(), [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=15",
      "-frames:v", "5",
      "-c:v", codec,
      "-f", "null", "-",
    ], { timeout: 8000, stdio: ["ignore", "ignore", "ignore"] });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Synchronous sleep (autoprofile runs synchronously at boot). */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/**
 * Returns the best available H.264 encoder + a friendly tag.
 *
 *   - ARM / Raspberry Pi: model-gated (Pi 4 → h264_v4l2m2m; Pi 5 has
 *     no HW H.264 block; other ARM → software). Probing v4l2m2m is
 *     unreliable, so we keep the conservative signature-based path.
 *   - x86 / x64 (desktop + servers): PROBE real GPU encoders by
 *     actually encoding a test clip — NVIDIA NVENC, AMD AMF, Intel
 *     QSV, Apple VideoToolbox — and use the first that works. This is
 *     the only cross-platform way that works on Windows (where the old
 *     /dev/nvidia* + /dev/dri checks never matched, so the desktop app
 *     was stuck on CPU libx264) and it can't pick an encoder the
 *     hardware can't actually run (the failure that caused reconnect
 *     loops on GPU-less servers).
 *
 * Operators can still force one with STREAM_VIDEO_CODEC (config.js).
 */
function pickEncoder(host) {
  const enc = ffmpegEncoders();
  const isArm = host?.arch === "arm64" || host?.arch === "arm";
  const listed = (name) => new RegExp(`^\\s*V[\\.\\w]*\\s+${name}\\b`, "m").test(enc);

  if (isArm) {
    if (host?.isPi && !host.isPi5 && listed("h264_v4l2m2m")) {
      return { codec: "h264_v4l2m2m", tag: "Raspberry Pi V4L2 M2M (HW)" };
    }
    return { codec: "libx264", tag: "libx264 (software)" };
  }

  const candidates = [
    { codec: "h264_nvenc",        tag: "NVIDIA NVENC (HW)" },
    { codec: "h264_amf",          tag: "AMD AMF (HW)" },
    { codec: "h264_qsv",          tag: "Intel Quick Sync (HW)" },
    { codec: "h264_videotoolbox", tag: "Apple VideoToolbox (HW)" },
  ].filter((c) => listed(c.codec));

  const probePass = () => {
    for (const c of candidates) {
      if (canEncode(c.codec)) return c;
    }
    return null;
  };

  // A GPU encoder can fail its first probe while the GPU is still busy
  // with Electron's own startup. If the first pass finds nothing but a
  // HW encoder IS compiled in, wait briefly and try once more before
  // settling for software — otherwise a cold boot could get stuck on
  // CPU libx264 for the whole session.
  let pick = probePass();
  if (!pick && candidates.length > 0) {
    sleepSync(1200);
    pick = probePass();
  }
  return pick || { codec: "libx264", tag: "libx264 (software)" };
}

// ---- Profile selection -----------------------------------------

/**
 * Pick reasonable encode settings for the current host.
 * Returns a "defaults" object — config.js merges these under any
 * explicit STREAM_* env vars the operator set.
 *
 * Categories:
 *   - 'pi5'       : Raspberry Pi 5 (BCM2712). No HW H.264 encoder, but
 *                   Cortex-A76 cores are fast enough for 720p30 veryfast.
 *   - 'pi'        : Raspberry Pi 4 and older. 720p30, HW encoder when available.
 *   - 'small-arm' : Weak ARM box, but not a Pi. 720p30 ultrafast.
 *   - 'modest'    : 1-2 cores x86. 720p30 veryfast.
 *   - 'standard'  : 4-8 cores x86. 1080p30 veryfast (current defaults).
 *   - 'fat'       : >8 cores x86. 1080p60 medium (no zerolatency).
 */
function pickProfile(host, encoder) {
  let category;

  if (host.isPi5) {
    category = "pi5";
  } else if (host.isPi) {
    category = "pi";
  } else if (host.isWeakArm) {
    category = "small-arm";
  } else if (host.cores <= 2) {
    category = "modest";
  } else if (host.cores >= 12) {
    category = "fat";
  } else {
    category = "standard";
  }

  // Hardware encoders skip the x264 preset / threads negotiation.
  const isHw = encoder.codec !== "libx264";

  // Base profile lookup.
  const base = {
    // Pi 5 (BCM2712, Cortex-A76 @ 2.4 GHz): no HW H.264 encoder, but the
    // faster cores handle veryfast comfortably. x264Threads=3 leaves one
    // core free for Chromium rendering and the OS.
    pi5: {
      width: 1280, height: 720, fps: 30,
      bitrateKbps: 3500, maxrateKbps: 3500, bufsizeKbps: 7000,
      audioBitrateKbps: 128,
      preset: "veryfast",
      x264Threads: 3,
      tune: "zerolatency",
      screencastQuality: 70,
      captureEveryNthFrame: 1,
    },
    pi: {
      width: 1280, height: 720, fps: 30,
      bitrateKbps: 2800, maxrateKbps: 2800, bufsizeKbps: 5600,
      audioBitrateKbps: 96,
      preset: "ultrafast",
      x264Threads: 3,
      tune: "zerolatency",
      screencastQuality: 60,
      captureEveryNthFrame: 1,
    },
    "small-arm": {
      width: 1280, height: 720, fps: 30,
      bitrateKbps: 3000, maxrateKbps: 3000, bufsizeKbps: 6000,
      audioBitrateKbps: 96,
      preset: "ultrafast",
      x264Threads: Math.max(2, host.cores - 1),
      tune: "zerolatency",
      screencastQuality: 62,
      captureEveryNthFrame: 1,
    },
    modest: {
      width: 1280, height: 720, fps: 30,
      bitrateKbps: 3500, maxrateKbps: 3500, bufsizeKbps: 7000,
      audioBitrateKbps: 128,
      preset: "veryfast",
      x264Threads: host.cores,
      tune: "zerolatency",
      screencastQuality: 70,
      captureEveryNthFrame: 1,
    },
    standard: {
      width: 1920, height: 1080, fps: 30,
      bitrateKbps: 4500, maxrateKbps: 4500, bufsizeKbps: 9000,
      audioBitrateKbps: 128,
      preset: "veryfast",
      x264Threads: 0, // auto = all cores
      tune: "zerolatency",
      screencastQuality: 70,
      captureEveryNthFrame: 1,
    },
    fat: {
      width: 1920, height: 1080, fps: 60,
      bitrateKbps: 6000, maxrateKbps: 6000, bufsizeKbps: 12000,
      audioBitrateKbps: 160,
      preset: "medium",
      x264Threads: 0,
      tune: "",                  // disable zerolatency → better quality
      screencastQuality: 78,
      captureEveryNthFrame: 1,
    },
  }[category];

  // On hardware encoders, x264 preset/threads/tune don't apply, but
  // we still pass them through so config.js shape stays the same.
  // We bump quality knobs upward since the HW encoder is much
  // cheaper than software.
  if (isHw && category === "pi") {
    base.fps = 30;
    base.bitrateKbps = 3500;
    base.screencastQuality = 70;
  }

  return { ...base, category, codec: encoder.codec, codecTag: encoder.tag };
}

// ---- Public ----------------------------------------------------

function pickAutoProfile(logger) {
  const host = detectHost();
  const encoder = pickEncoder(host);
  const profile = pickProfile(host, encoder);

  logger?.info?.({
    arch: host.arch, cores: host.cores, ramGB: host.totalMemGB,
    cpu: host.cpuModel, piModel: host.piModel,
    profile: profile.category,
    encoder: profile.codecTag,
    resolution: `${profile.width}x${profile.height}@${profile.fps}`,
    videoBitrateKbps: profile.bitrateKbps,
  }, "auto-profile picked");

  return { host, encoder, profile };
}

module.exports = { pickAutoProfile, detectHost, pickEncoder, pickProfile };
