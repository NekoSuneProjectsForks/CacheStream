"use strict";

/**
 * Launch the bundled Next.js standalone panel as a child Node
 * process and wait for it to answer /api/health.
 *
 * We use Electron's `utilityProcess.fork`, which runs the script on
 * Electron's own bundled Node runtime — so the native better-sqlite3
 * binary inside the web bundle only has to match ONE ABI (Electron's),
 * which is exactly what scripts/build-web.mjs rebuilds it against.
 */

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { utilityProcess } = require("electron");

/**
 * @param {object} opts
 * @param {string} opts.bundleDir   build/web (contains server.js)
 * @param {number} opts.port        web server port
 * @param {string} opts.hostname    bind address (default 0.0.0.0 so the
 *                                   panel is reachable from your phone)
 * @param {object} opts.env         extra env (token, dirs, audio, etc.)
 * @param {(line:string)=>void} opts.onLog
 */
function startWebServer({ bundleDir, port, hostname = "0.0.0.0", env, onLog = () => {} }) {
  const serverJs = path.join(bundleDir, "server.js");

  // Fail fast (and loud) rather than forking a missing file and letting
  // the health probe hang for 30s. In dev this means you forgot to
  // build the panel; `npm run dev` now auto-builds it via predev, but a
  // bare `electron .` can still land here.
  if (!fs.existsSync(serverJs)) {
    const err = new Error(
      `Web panel bundle not found at ${serverJs}.\n` +
      `Build it first:  cd apps/desktop && npm run build-web`,
    );
    err.code = "WEB_BUNDLE_MISSING";
    return { child: null, ready: Promise.reject(err) };
  }

  const child = utilityProcess.fork(serverJs, [], {
    // Next's standalone server resolves .next + node_modules relative
    // to its own location, so cwd must be the bundle dir.
    cwd: bundleDir,
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      // Bind on all interfaces so the mobile control panel + any LAN
      // device can reach it. The health probe below still uses
      // loopback, which a 0.0.0.0 bind also answers.
      HOSTNAME: hostname,
      ...env,
    },
  });

  child.stdout?.on("data", (d) => onLog(`[web] ${d.toString().trimEnd()}`));
  child.stderr?.on("data", (d) => onLog(`[web!] ${d.toString().trimEnd()}`));

  const ready = waitForHealth(port, 30_000, child);
  return { child, ready };
}

function waitForHealth(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    // If the panel process dies before answering /api/health, surface
    // that immediately instead of waiting out the full timeout.
    child?.once?.("exit", (code) => {
      done(reject, new Error(`web server process exited (code ${code}) before becoming healthy`));
    });

    const tick = () => {
      if (settled) return;
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return done(resolve, true);
          retry();
        }
      );
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() > deadline) return reject(new Error("web server did not become healthy in time"));
      setTimeout(tick, 400);
    };
    tick();
  });
}

module.exports = { startWebServer };
