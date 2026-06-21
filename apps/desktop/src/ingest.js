"use strict";

/**
 * Embedded RTMP ingest — the Electron-native replacement for the
 * Docker `ingest` service (nginx + nginx-rtmp-module).
 *
 *   OBS / phone / capture card
 *        │  rtmp://<lan-ip>:1935/live/<key>
 *        ▼
 *   node-media-server (RTMP receiver, binds all interfaces)
 *        │  on publish → spawn bundled FFmpeg, remux (-c copy)
 *        ▼
 *   <hlsDir>/<key>.m3u8 + <key>-N.ts   (flat, nginx-rtmp layout)
 *        ▲
 *        │  GET /hls/<key>.m3u8  ·  GET /stat (XML)  ·  GET /health
 *   tiny HTTP server  ◀── the web panel's /api/ingest/* routes
 *
 * The HTTP surface is byte-for-byte compatible with what the panel
 * already expects from nginx-rtmp, so none of the web app's ingest
 * routes change — they just point INGEST_HTTP_URL here instead of
 * at the `ingest:8080` compose service.
 *
 * Why not bundle nginx-rtmp? It's a compiled C module; shipping it
 * for win + linux × x64 + arm64 without Docker is a packaging
 * nightmare. node-media-server is pure JS and we already bundle a
 * static FFmpeg for the remux, so this stays cross-platform with no
 * native build step.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const KEY_RX = /^[A-Za-z0-9_-]{1,64}$/;
const SAMPLE_MS = 1000;

class IngestServer {
  /**
   * @param {object} opts
   * @param {number} opts.rtmpPort    RTMP listen port (0.0.0.0)
   * @param {number} opts.httpPort    HLS + /stat HTTP port
   * @param {string} opts.httpHost    bind host for the HTTP server
   * @param {string} opts.hlsDir      scratch dir for HLS output
   * @param {string} opts.ffmpegPath  bundled ffmpeg binary
   * @param {object} opts.logger
   */
  constructor({ rtmpPort, httpPort, httpHost = "127.0.0.1", hlsDir, ffmpegPath, logger }) {
    this.rtmpPort = rtmpPort;
    this.httpPort = httpPort;
    this.httpHost = httpHost;
    this.hlsDir = hlsDir;
    this.ffmpegPath = ffmpegPath || "ffmpeg";
    this.logger = logger || console;

    this.nms = null;
    this.httpServer = null;
    this.sampler = null;
    // key → { id, app, key, clientAddr, startedAt, lastBytes, bwIn, ffmpeg, stopping }
    this.streams = new Map();
  }

  start() {
    fs.mkdirSync(this.hlsDir, { recursive: true });
    this._startRtmp();
    this._startHttp();
    this._startSampler();
    this.logger.info?.(
      { rtmpPort: this.rtmpPort, httpPort: this.httpPort, hlsDir: this.hlsDir },
      "ingest server listening",
    );
  }

  stop() {
    if (this.sampler) { clearInterval(this.sampler); this.sampler = null; }
    for (const rec of this.streams.values()) this._killFfmpeg(rec);
    this.streams.clear();
    try { this.httpServer?.close(); } catch {}
    try { this.nms?.stop?.(); } catch {}
    this.httpServer = null;
    this.nms = null;
  }

  // ---- RTMP (node-media-server) ---------------------------------

  _startRtmp() {
    const NodeMediaServer = require("node-media-server");
    this.nms = new NodeMediaServer({
      logType: 0, // we do our own structured logging in the hooks
      rtmp: {
        port: this.rtmpPort,
        chunk_size: 1024,   // match nginx.conf — flush small + fast
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
    });

    this.nms.on("postPublish", (id, streamPath) => {
      const { app, key } = parsePath(streamPath);
      if (!key || !KEY_RX.test(key)) {
        this.logger.warn?.({ streamPath }, "ingest: rejecting publish with invalid key");
        try { this.nms.getSession(id)?.reject?.(); } catch {}
        return;
      }
      const session = this._safeSession(id);
      const clientAddr = session?.socket?.remoteAddress
        ? String(session.socket.remoteAddress).replace(/^::ffff:/, "")
        : null;
      const rec = {
        id, app, key, clientAddr,
        startedAt: Date.now(),
        lastBytes: session?.socket?.bytesRead || 0,
        bwIn: 0,
        ffmpeg: null,
        stopping: false,
      };
      this.streams.set(key, rec);
      this.logger.info?.({ key, clientAddr }, "ingest: publisher started");
      this._spawnHls(rec);
    });

    this.nms.on("donePublish", (id, streamPath) => {
      const { key } = parsePath(streamPath);
      const rec = this.streams.get(key);
      if (!rec || rec.id !== id) return;
      this.logger.info?.({ key }, "ingest: publisher stopped");
      this._killFfmpeg(rec);
      this.streams.delete(key);
      this._cleanHls(key);
    });

    this.nms.run();
  }

  _safeSession(id) {
    try { return this.nms.getSession(id); } catch { return null; }
  }

  // ---- HLS remux (bundled FFmpeg, -c copy) ----------------------

  _spawnHls(rec) {
    const playlist = path.join(this.hlsDir, `${rec.key}.m3u8`);
    const segments = path.join(this.hlsDir, `${rec.key}-%d.ts`);
    const src = `rtmp://127.0.0.1:${this.rtmpPort}/${rec.app}/${rec.key}`;

    const args = [
      "-hide_banner", "-loglevel", "warning", "-nostats",
      "-fflags", "+genpts",
      "-i", src,
      "-c", "copy",
      "-f", "hls",
      "-hls_time", "1",
      "-hls_list_size", "3",
      "-hls_flags", "delete_segments+omit_endlist+independent_segments",
      "-hls_segment_type", "mpegts",
      "-hls_segment_filename", segments,
      playlist,
    ];

    const proc = spawn(this.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    rec.ffmpeg = proc;
    proc.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line && /error|failed|cannot|invalid/i.test(line)) {
        this.logger.warn?.({ key: rec.key, ffmpeg: line }, "ingest hls ffmpeg");
      }
    });
    proc.on("exit", (code) => {
      rec.ffmpeg = null;
      // If the publisher is still up but ffmpeg fell over (e.g. it
      // raced the stream becoming playable), restart it once shortly.
      if (!rec.stopping && this.streams.get(rec.key) === rec) {
        this.logger.warn?.({ key: rec.key, code }, "ingest hls ffmpeg exited; retrying");
        setTimeout(() => {
          if (!rec.stopping && this.streams.get(rec.key) === rec && !rec.ffmpeg) {
            this._spawnHls(rec);
          }
        }, 1000);
      }
    });
  }

  _killFfmpeg(rec) {
    if (!rec) return;
    rec.stopping = true;
    const proc = rec.ffmpeg; rec.ffmpeg = null;
    if (proc) { try { proc.kill("SIGKILL"); } catch {} }
  }

  _cleanHls(key) {
    try {
      for (const name of fs.readdirSync(this.hlsDir)) {
        if (name === `${key}.m3u8` || name.startsWith(`${key}-`)) {
          try { fs.rmSync(path.join(this.hlsDir, name), { force: true }); } catch {}
        }
      }
    } catch {}
  }

  // ---- inbound bitrate sampler (for /stat bw_in) ----------------

  _startSampler() {
    this.sampler = setInterval(() => {
      for (const rec of this.streams.values()) {
        const session = this._safeSession(rec.id);
        const bytes = session?.socket?.bytesRead || rec.lastBytes;
        const delta = Math.max(0, bytes - rec.lastBytes);
        rec.lastBytes = bytes;
        // nginx-rtmp reports bw_in in bits/sec.
        rec.bwIn = Math.round((delta * 8 * 1000) / SAMPLE_MS);
      }
    }, SAMPLE_MS);
    this.sampler.unref?.();
  }

  // ---- HTTP (HLS files + /stat + /health) -----------------------

  _startHttp() {
    this.httpServer = http.createServer((req, res) => {
      const url = (req.url || "").split("?")[0];

      // CORS + no-cache, mirroring apps/ingest/nginx.conf so the
      // /scene/ingest player + the panel get identical headers.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok\n");
        return;
      }
      if (url === "/stat") {
        const xml = this._statXml();
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(xml);
        return;
      }
      if (url.startsWith("/hls/")) {
        this._serveHls(url.slice("/hls/".length), req.method || "GET", res);
        return;
      }
      res.writeHead(404); res.end();
    });
    this.httpServer.on("error", (e) =>
      this.logger.warn?.({ err: e?.message }, "ingest http server error"));
    this.httpServer.listen(this.httpPort, this.httpHost);
  }

  _serveHls(file, method, res) {
    // Flat files only — no slashes, no traversal. Matches the panel's
    // playlist-proxy whitelist (/api/ingest/playlist/[file]).
    if (!/^[A-Za-z0-9_\-.]+\.(m3u8|ts)$/.test(file)) {
      res.writeHead(400); res.end(); return;
    }
    const full = path.join(this.hlsDir, file);
    const ct = file.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t";
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": ct, "Content-Length": st.size });
      if (method === "HEAD") { res.end(); return; }
      fs.createReadStream(full).on("error", () => { try { res.destroy(); } catch {} }).pipe(res);
    });
  }

  /**
   * Synthesize nginx-rtmp's <rtmp> stat XML from the live sessions,
   * limited to the fields the panel's /api/ingest/status parser
   * actually reads (application "live", per-stream name, publishing,
   * bw_in, client address, video meta).
   */
  _statXml() {
    let streams = "";
    for (const rec of this.streams.values()) {
      const session = this._safeSession(rec.id);
      const w = session?.videoWidth || 0;
      const h = session?.videoHeight || 0;
      const codec = session?.videoCodecName || session?.videoCodec || "";
      streams +=
        `<stream>` +
          `<name>${esc(rec.key)}</name>` +
          `<bw_in>${rec.bwIn || 0}</bw_in>` +
          `<bytes_in>${rec.lastBytes || 0}</bytes_in>` +
          `<client><address>${esc(rec.clientAddr || "")}</address></client>` +
          (w && h
            ? `<meta><video><width>${w}</width><height>${h}</height><codec>${esc(String(codec))}</codec></video></meta>`
            : ``) +
          `<publishing/><active/>` +
        `</stream>`;
    }
    return `<?xml version="1.0" encoding="utf-8"?>` +
      `<rtmp><server><application><name>live</name><live>${streams}</live></application></server></rtmp>`;
  }
}

function parsePath(streamPath) {
  // "/live/<key>" → { app: "live", key: "<key>" }
  const parts = String(streamPath || "").split("/").filter(Boolean);
  return { app: parts[0] || "live", key: parts[1] || "" };
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { IngestServer };
