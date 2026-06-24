"use strict";

/**
 * Standalone entry point for the OAuth2 relay (the "public" hosted instance,
 * or a self-hosted "local" one). For embedding inside another app, require
 * ./server and call createServer({ config, logger }).listen() directly.
 */

// Auto-load a .env file if present (Node 20.12+/22+/24). Lets the relay pick
// up keys on hosts that don't pass --env-file (e.g. a Pterodactyl egg). Real
// process env still wins for anything already set. Must run before ./config.
try { if (typeof process.loadEnvFile === "function") process.loadEnvFile(); }
catch { /* no .env file — use the real environment */ }

const { config } = require("./config");
const { createServer } = require("./server");
const { listConfigured } = require("./providers");

function ts() { return new Date().toISOString(); }
const logger = {
  info: (o, m) => console.log(ts(), "INFO ", m || "", o ? JSON.stringify(o) : ""),
  warn: (o, m) => console.warn(ts(), "WARN ", m || "", o ? JSON.stringify(o) : ""),
  error: (o, m) => console.error(ts(), "ERROR", m || "", o ? JSON.stringify(o) : ""),
};

const providers = listConfigured();
if (providers.length === 0) {
  logger.warn({}, "no providers configured — set RELAY_<PROVIDER>_CLIENT_ID/_CLIENT_SECRET (env or .env). Starting anyway.");
}

const { listen } = createServer({ config, logger });
listen()
  .then(() => logger.info({ port: config.port, publicUrl: config.publicUrl || "(derived from Host)", providers, node: process.version }, "oauth relay ready"))
  .catch((err) => { logger.error({ err: err.message }, "failed to start"); process.exit(1); });

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
