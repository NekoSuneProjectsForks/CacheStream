"use strict";

/**
 * Minimal HTTP control API for the streamer.
 *
 * Uses Node's built-in http module — Express would be overkill
 * for ~7 endpoints, and avoiding it keeps the worker image
 * lighter. All endpoints require the INTERNAL_API_TOKEN as a
 * bearer token in the Authorization header, except /health.
 *
 *   GET  /health                  → 200 ok (no auth)
 *   GET  /status                  → current Streamer state
 *   POST /start                   → start the pipeline
 *   POST /stop                    → stop the pipeline
 *   POST /restart                 → tear down + start again
 *   POST /scene   { url }         → load a new scene URL
 *   POST /overlays { overlays }   → replace overlay layer set
 */

const http = require("node:http");

function createApi({ streamer, config, logger }) {
  const expected = `Bearer ${config.api.token}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://internal");

    // Liveness (no auth) so docker-compose healthcheck can use it.
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true });
    }

    // Constant-time-ish bearer check.
    const auth = req.headers["authorization"];
    if (!auth || auth.length !== expected.length || !safeEq(auth, expected)) {
      return send(res, 401, { error: "unauthorized" });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return send(res, 200, streamer.status());
    }

    if (req.method === "POST" && url.pathname === "/start") {
      return streamer.start()
        .then(() => send(res, 200, streamer.status()))
        .catch((err) => send(res, 400, { error: err.message }));
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      return streamer.stop()
        .then(() => send(res, 200, streamer.status()))
        .catch((err) => send(res, 500, { error: err.message }));
    }

    if (req.method === "POST" && url.pathname === "/restart") {
      return streamer.restart()
        .then(() => send(res, 200, streamer.status()))
        .catch((err) => send(res, 500, { error: err.message }));
    }

    if (req.method === "POST" && url.pathname === "/scene") {
      return readJson(req).then((body) =>
        streamer.setScene(body?.url)
          .then(() => send(res, 200, streamer.status()))
      ).catch((err) => send(res, 400, { error: err.message }));
    }

    if (req.method === "POST" && url.pathname === "/overlays") {
      return readJson(req).then((body) =>
        streamer.setOverlays(body?.overlays || [])
          .then(() => send(res, 200, streamer.status()))
      ).catch((err) => send(res, 400, { error: err.message }));
    }

    if (req.method === "POST" && url.pathname === "/vod/play") {
      return readJson(req).then((body) =>
        streamer.playVod(body)
          .then(() => send(res, 200, streamer.status()))
      ).catch((err) => send(res, 400, { error: err.message }));
    }

    if (req.method === "POST" && url.pathname === "/vod/stop") {
      return streamer.stopVod()
        .then(() => send(res, 200, streamer.status()))
        .catch((err) => send(res, 500, { error: err.message }));
    }

    if (req.method === "POST" && url.pathname === "/ingest") {
      return readJson(req).then((body) =>
        streamer.setIngest(body)
          .then(() => send(res, 200, streamer.status()))
      ).catch((err) => send(res, 400, { error: err.message }));
    }

    send(res, 404, { error: "not_found" });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.listen(config.api.port, "0.0.0.0", () => {
          logger.info({ port: config.api.port }, "streamer api listening");
          resolve(server);
        });
        server.on("error", reject);
      });
    },
    close() { return new Promise((r) => server.close(() => r())); },
  };
}

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // 64KB cap — overlays are small JSON, anything bigger is suspect.
      if (size > 64 * 1024) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function safeEq(a, b) {
  // crypto.timingSafeEqual requires equal length; the length
  // check above guarantees that, so this is a stricter compare.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports = { createApi };
