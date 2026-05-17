"use strict";

/**
 * Thermal monitor.
 *
 * Polls /sys/class/thermal/thermal_zone0/temp every 10 s. On hosts
 * that don't expose it (most x86 servers in Docker, macOS), the
 * monitor is a no-op.
 *
 * Behaviour:
 *   - Crosses `throttleC` from below → ask the streamer to drop
 *     into a thermal-safe profile (720p / lower bitrate / lower
 *     screencast quality). Only one drop happens per heat cycle;
 *     we don't keep stepping down.
 *   - Falls back below `recoverC` → restore the original profile.
 *
 * The streamer responds by hot-restarting the FFmpeg processes
 * with the new settings — Twitch sees a quick reconnect (RTMP
 * handles this gracefully). The broadcast doesn't drop entirely.
 *
 * If hardware encoding is in use we keep the broadcast at its
 * configured resolution / fps and only drop screencast quality
 * and bitrate slightly — the HW encoder doesn't generate heat
 * the same way x264 does.
 */

const fs = require("node:fs");

const THERMAL_PATH = "/sys/class/thermal/thermal_zone0/temp";

class ThermalMonitor {
  constructor({ config, streamer, logger }) {
    this.config = config;
    this.streamer = streamer;
    this.logger = logger;
    this.timer = null;
    this.state = "normal"; // 'normal' | 'throttled'
    this.lastTempC = null;
    this.originalVideo = null;
  }

  start() {
    if (this.timer) return;
    if (!this.config.runtime.thermalMonitor) return;
    if (!fs.existsSync(THERMAL_PATH)) {
      this.logger.debug("no thermal sensor; monitor inactive");
      return;
    }
    this.logger.info({
      sensor: THERMAL_PATH,
      throttleC: this.config.runtime.thermalThrottleC,
      recoverC:  this.config.runtime.thermalRecoverC,
    }, "thermal monitor started");
    this.timer = setInterval(() => { this._tick().catch(() => {}); }, 10_000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  status() {
    return {
      enabled: this.config.runtime.thermalMonitor && !!this.timer,
      state: this.state,
      lastTempC: this.lastTempC,
      throttleC: this.config.runtime.thermalThrottleC,
      recoverC:  this.config.runtime.thermalRecoverC,
    };
  }

  async _tick() {
    const raw = await fs.promises.readFile(THERMAL_PATH, "utf8").catch(() => "");
    const tempC = Number.parseInt(raw.trim(), 10) / 1000;
    if (!Number.isFinite(tempC)) return;
    this.lastTempC = Math.round(tempC * 10) / 10;

    const throttle = this.config.runtime.thermalThrottleC;
    const recover  = this.config.runtime.thermalRecoverC;

    if (this.state === "normal" && tempC >= throttle) {
      this.logger.warn({ tempC: this.lastTempC, throttleC: throttle },
                       "host hot — dropping to thermal-safe profile");
      this.originalVideo = { ...this.streamer.config.video };
      this._applyThermalSafe();
      this.state = "throttled";
      return;
    }

    if (this.state === "throttled" && tempC <= recover) {
      this.logger.info({ tempC: this.lastTempC, recoverC: recover },
                       "host cooled — restoring original profile");
      if (this.originalVideo) {
        Object.assign(this.streamer.config.video, this.originalVideo);
      }
      this._restartIfRunning();
      this.state = "normal";
      this.originalVideo = null;
    }
  }

  _applyThermalSafe() {
    const v = this.streamer.config.video;
    const isHw = v.codec && v.codec !== "libx264";

    if (isHw) {
      // HW encoders aren't the heat source; just lighten the
      // screencast capture cost.
      v.screencastQuality = Math.min(v.screencastQuality, 55);
      v.bitrateKbps = Math.min(v.bitrateKbps, 3500);
      v.maxrateKbps = Math.min(v.maxrateKbps, 3500);
      v.bufsizeKbps = Math.min(v.bufsizeKbps, 7000);
    } else {
      v.width = 1280;
      v.height = 720;
      v.fps = Math.min(v.fps, 30);
      v.bitrateKbps = Math.min(v.bitrateKbps, 2500);
      v.maxrateKbps = Math.min(v.maxrateKbps, 2500);
      v.bufsizeKbps = Math.min(v.bufsizeKbps, 5000);
      v.preset = "ultrafast";
      v.screencastQuality = 55;
    }
    this._restartIfRunning();
  }

  _restartIfRunning() {
    // restart() tears down + relaunches the FFmpeg pipeline,
    // picking up our mutated `config.video` on the way back up.
    // If we're idle this is a cheap no-op.
    if (this.streamer.state === "running" || this.streamer.state === "reconnecting") {
      this.streamer.restart().catch((err) =>
        this.logger.warn({ err }, "thermal restart failed")
      );
    }
  }
}

module.exports = { ThermalMonitor };
