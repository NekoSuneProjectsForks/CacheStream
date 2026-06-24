"use strict";

/**
 * Standalone entry point for the OAuth2 relay (the "public" hosted instance,
 * or a self-hosted "local" one). For embedding inside another app, require
 * ./server and call createServer({ config, logger }).listen() directly.
 */

const { config } = require("./config");
const { createServer } = require("./server");

function ts() { return new Date().toISOString(); }
const logger = {
  info: (o, m) => console.log(ts(), "INFO ", m || "", o ? JSON.stringify(o) : ""),
  warn: (o, m) => console.warn(ts(), "WARN ", m || "", o ? JSON.stringify(o) : ""),
  error: (o, m) => console.error(ts(), "ERROR", m || "", o ? JSON.stringify(o) : ""),
};

const { listen } = createServer({ config, logger });
listen().catch((err) => { logger.error({ err: err.message }, "failed to start"); process.exit(1); });

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
