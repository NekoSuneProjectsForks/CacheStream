"use strict";

/**
 * Upload bandwidth monitor + multistream auto-protect.
 *
 * Streaming to N destinations at once costs N × the encoded bitrate of
 * upstream bandwidth. If the house uplink can't keep up the encoder
 * stalls and every viewer sees dropped/stuttering frames. This module
 * watches the real upload capacity and tells the streamer how many
 * simultaneous outputs it can safely run.
 *
 *   - PERIODIC PROBE (default every 20 min, NOT every few seconds — a
 *     throughput probe itself uses upload, so we keep it infrequent):
 *     POST a few MB to a fast public sink (Cloudflare's speed endpoint)
 *     and time how fast the bytes drain into the socket → Mbps.
 *   - ROLLING BASELINE: the median of recent samples. A fresh sample
 *     well below the baseline (e.g. 100 → 30 Mbps) is flagged as a
 *     RAPID DROP and surfaced as a warning.
 *   - MAX STREAMS: floor(usableUp / perStreamMbps) with a safety
 *     headroom factor, so we never oversubscribe the link.
 *   - ON-DEMAND RE-TEST: the streamer can poke the monitor when relays
 *     start flapping (a live congestion signal) so we re-measure early
 *     instead of waiting for the next 20-min tick.
 *
 * Fail-open: if the probe can't reach the sink (offline / blocked) the
 * monitor reports `unknown` and never caps anything.
 */

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { EventEmitter } = require("node:events");

const DEFAULTS = {
  // Upload target. By default we measure against a nearby Ookla
  // (speedtest.net) server — fetch the server list, pick the closest, and
  // POST to its upload endpoint. `BANDWIDTH_PROBE_URL` forces a specific
  // sink; Cloudflare is the fallback if the Ookla list is unreachable.
  probeUrlOverride: process.env.BANDWIDTH_PROBE_URL || "",
  serverListUrl: "https://www.speedtest.net/api/js/servers?engine=js&https_functional=true&limit=10",
  fallbackUrl: "https://speed.cloudflare.com/__up",
  serverTtlMs: 60 * 60 * 1000,  // re-pick a speedtest.net server hourly
  intervalMs: 20 * 60 * 1000,   // 20 minutes
  probeBytes: 8 * 1024 * 1024,  // 8 MB
  maxProbeMs: 12_000,           // give up (and use what drained) after 12s
  minRetestGapMs: 60_000,       // don't re-probe more than once a minute
  historyLen: 8,                // samples kept for the baseline median
  safety: 0.8,                  // use ≤80% of measured up for streams
  dropFactor: 0.55,             // sample < baseline×this ⇒ "rapid drop"
};

class BandwidthMonitor extends EventEmitter {
  /**
   * @param {object}   o
   * @param {object}   o.logger
   * @param {() => number} o.perStreamMbps  encoded Mbps of ONE output
   * @param {() => number} o.enabledCount    how many outputs are wanted
   * @param {boolean}  [o.autoProtect=true]  enforce the max-streams cap
   */
  constructor({ logger, perStreamMbps, enabledCount, autoProtect = true, ...opt } = {}) {
    super();
    this.logger = logger || console;
    this.perStreamMbps = perStreamMbps || (() => 0);
    this.enabledCount = enabledCount || (() => 0);
    this.autoProtect = autoProtect !== false;
    this.opt = { ...DEFAULTS, ...opt };

    this.samples = [];           // [{ mbps, at }]
    this.upMbps = null;          // latest sample (null = unknown)
    this.baselineMbps = null;    // median of recent samples
    this.warning = null;         // human string or null
    this.lastProbeAt = 0;
    this.probing = false;
    this.timer = null;
    // Resolved speedtest.net upload endpoint (cached for serverTtlMs).
    this._probeUrl = "";
    this._probeUrlAt = 0;
    this._probeLabel = null;     // e.g. "speedtest.net — Sponsor · City"
  }

  /**
   * Begin periodic probing. The periodic probe only runs when multistream is
   * actually active (2+ enabled outputs) — that's the only time the
   * max-streams cap matters, and it keeps the probe (which runs on the same
   * thread as frame capture) off the back of single-output streamers. A
   * manual "Re-test now" always probes regardless.
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.enabledCount() >= 2) this.probe();
    }, this.opt.intervalMs);
    if (this.timer.unref) this.timer.unref();   // never keep the app alive
    // One probe shortly after boot if already multistreaming.
    setTimeout(() => { if (this.enabledCount() >= 2) this.probe(); }, 4000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setAutoProtect(on) {
    const next = on !== false;
    if (next === this.autoProtect) return;
    this.autoProtect = next;
    this._recompute();
    this.emit("change");
  }

  /** A live congestion hint (e.g. relays flapping) — re-probe early. */
  noteCongestion(reason) {
    const since = Date.now() - this.lastProbeAt;
    if (since < this.opt.minRetestGapMs || this.probing) return;
    this.logger.info?.({ reason }, "bandwidth: congestion noticed, re-testing");
    this.probe();
  }

  /** Force an immediate re-test (UI "Re-test now"), honouring the min gap. */
  retest() {
    if (this.probing) return;
    if (Date.now() - this.lastProbeAt < 5000) return;  // debounce double-clicks
    this.probe();
  }

  /**
   * Max simultaneous outputs the link can carry, or null if unknown.
   * Always ≥1 when we have a measurement (one stream is the floor).
   */
  maxStreams() {
    if (this.upMbps == null) return null;
    const per = this.perStreamMbps();
    if (!per || per <= 0) return null;
    const usable = this.upMbps * this.opt.safety;
    return Math.max(1, Math.floor(usable / per));
  }

  status() {
    const per = this.perStreamMbps();
    const max = this.maxStreams();
    const usable = this.upMbps == null ? null : +(this.upMbps * this.opt.safety).toFixed(1);
    return {
      autoProtect: this.autoProtect,
      upMbps: this.upMbps,
      baselineMbps: this.baselineMbps,
      usableMbps: usable,
      perStreamMbps: per ? +per.toFixed(2) : null,
      maxStreams: max,
      wanted: this.enabledCount(),
      warning: this.warning,
      probing: this.probing,
      lastProbeAt: this.lastProbeAt || null,
      intervalMs: this.opt.intervalMs,
      server: this._probeLabel,
      samples: this.samples.slice(-this.opt.historyLen),
    };
  }

  // ---- probe -----------------------------------------------------

  /**
   * Resolve the upload endpoint: a forced override, else a nearby
   * speedtest.net (Ookla) server (cached hourly), else Cloudflare.
   */
  async _resolveProbeUrl() {
    if (this.opt.probeUrlOverride) {
      this._probeLabel = "custom (BANDWIDTH_PROBE_URL)";
      return this.opt.probeUrlOverride;
    }
    if (this._probeUrl && Date.now() - this._probeUrlAt < this.opt.serverTtlMs) {
      return this._probeUrl;
    }
    try {
      const picked = await resolveSpeedtestServer(this.opt.serverListUrl, this.logger);
      if (picked) {
        this._probeUrl = picked.url;
        this._probeLabel = picked.label;
        this._probeUrlAt = Date.now();
        return this._probeUrl;
      }
    } catch (err) {
      this.logger.warn?.({ err: err?.message }, "bandwidth: speedtest.net server list failed");
    }
    // Couldn't reach the Ookla list — use the fallback this once (don't cache
    // it, so the next probe retries speedtest.net).
    this._probeLabel = "cloudflare (fallback)";
    return this._probeUrl || this.opt.fallbackUrl;
  }

  async probe() {
    if (this.probing) return;
    this.probing = true;
    this.emit("change");
    try {
      const probeUrl = await this._resolveProbeUrl();
      const mbps = await measureUpload({ ...this.opt, probeUrl }, this.logger);
      this.lastProbeAt = Date.now();
      if (mbps == null) {
        this.logger.warn?.("bandwidth: probe unreachable; not capping");
        // Keep the last known value; just clear any over-capacity warning
        // we can't currently justify. Don't fabricate a cap.
        this.probing = false;
        this._recompute();
        this.emit("sample", { mbps: null });
        this.emit("change");
        return;
      }
      this.samples.push({ mbps: +mbps.toFixed(1), at: this.lastProbeAt });
      if (this.samples.length > this.opt.historyLen * 2) {
        this.samples = this.samples.slice(-this.opt.historyLen);
      }
      this.upMbps = +mbps.toFixed(1);
      this.baselineMbps = median(this.samples.map((s) => s.mbps));
      this.probing = false;
      this._recompute();
      this.logger.info?.(
        { upMbps: this.upMbps, baselineMbps: this.baselineMbps, maxStreams: this.maxStreams() },
        "bandwidth: probe",
      );
      this.emit("sample", { mbps: this.upMbps });
      this.emit("change");
    } catch (err) {
      this.probing = false;
      this.logger.warn?.({ err: err?.message }, "bandwidth: probe error");
      this.emit("change");
    }
  }

  /** Recompute the warning string from the latest numbers. */
  _recompute() {
    const prev = this.warning;
    this.warning = null;
    if (this.upMbps == null) { if (prev) this.emit("change"); return; }

    const per = this.perStreamMbps();
    const usable = this.upMbps * this.opt.safety;
    const wanted = this.enabledCount();
    const max = this.maxStreams();

    // Rapid drop vs the rolling baseline (needs a few samples to be real).
    if (this.samples.length >= 3 && this.baselineMbps &&
        this.upMbps < this.baselineMbps * this.opt.dropFactor) {
      this.warning =
        `Upload dropped to ~${this.upMbps} Mbps (was ~${Math.round(this.baselineMbps)} Mbps). ` +
        (this.autoProtect && max != null && wanted > max
          ? `Holding outputs at ${max} until it recovers.`
          : `Consider reducing active outputs.`);
    } else if (per > 0 && wanted > 0 && wanted * per > usable) {
      // Over-subscribed: more outputs enabled than the link can carry.
      this.warning =
        `${wanted} outputs need ~${(wanted * per).toFixed(1)} Mbps but only ` +
        `~${usable.toFixed(1)} Mbps is usable. ` +
        (this.autoProtect && max != null
          ? `Auto-protect is holding at ${max}.`
          : `Frames may drop — enable auto-protect or reduce outputs.`);
    }
    if (this.warning && this.warning !== prev) {
      this.emit("warning", this.warning);
    }
  }
}

/**
 * Pick a nearby speedtest.net (Ookla) server and return its upload endpoint
 * + a human label. The server-list `url` field IS the upload.php endpoint;
 * the list is distance-sorted so the first entry is the closest.
 */
async function resolveSpeedtestServer(listUrl, logger) {
  const json = await httpGetJson(listUrl, 8000);
  if (!Array.isArray(json) || !json.length) return null;
  for (const s of json) {
    let u = s.url || (s.host ? `http://${s.host}/speedtest/upload.php` : null);
    if (!u) continue;
    u = u.replace(/^http:\/\//i, "https://");   // the list was filtered https_functional
    const label = [s.sponsor, s.name, s.country].filter(Boolean).join(" · ") || s.host || "server";
    logger?.info?.({ server: label, url: u }, "bandwidth: using speedtest.net server");
    return { url: u, label: `speedtest.net — ${label}` };
  }
  return null;
}

/** Minimal JSON GET with a hard timeout + response-size cap. */
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { return reject(new Error("bad url")); }
    const mod = target.protocol === "http:" ? http : https;
    const req = mod.get(url, { headers: { "user-agent": "CacheStream", accept: "application/json" } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        data += c;
        if (data.length > 1_000_000) { req.destroy(); reject(new Error("response too large")); }
      });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

/**
 * Push bytes to a sink and measure the drain rate. Returns Mbps, or null
 * if the request never connected / sent nothing.
 */
function measureUpload(opt, logger) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(opt.probeUrl); } catch { return resolve(null); }
    const mod = target.protocol === "http:" ? http : https;
    const chunk = Buffer.alloc(64 * 1024);   // 64 KB of zeros, reused

    const req = mod.request(
      {
        method: "POST",
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: target.pathname + target.search,
        // Ookla's upload.php expects a form content-type; harmless for the
        // Cloudflare fallback (it reads the body length either way).
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "CacheStream" },
      },
      (res) => { res.on("data", () => {}); res.on("end", () => {}); },
    );

    let sent = 0;
    let startedAt = 0;
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      clearTimeout(killer);
      try { req.destroy(); } catch {}
      if (!ok || !sent || !startedAt) return resolve(null);
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed <= 0) return resolve(null);
      resolve((sent * 8) / (elapsed * 1e6));   // bits / s → Mbps
    };

    const killer = setTimeout(() => finish(true), opt.maxProbeMs);

    req.on("error", () => finish(false));
    req.socket?.on?.("error", () => finish(false));

    const pump = () => {
      if (done) return;
      while (sent < opt.probeBytes) {
        if (startedAt === 0) startedAt = Date.now();
        if (Date.now() - startedAt >= opt.maxProbeMs) return finish(true);
        sent += chunk.length;
        if (!req.write(chunk)) { req.once("drain", pump); return; }
      }
      finish(true);   // sent the whole probe — measure & stop
    };

    req.on("socket", (s) => {
      if (s.connecting) s.once("connect", pump); else pump();
    });
  });
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : +((a[m - 1] + a[m]) / 2).toFixed(1);
}

module.exports = { BandwidthMonitor, measureUpload };
