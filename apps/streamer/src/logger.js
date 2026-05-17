"use strict";

const pino = require("pino");

function createLogger(level = "info") {
  const isProd = process.env.NODE_ENV === "production";
  return pino({
    level,
    base: { app: "streamer" },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isProd
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,app" },
        },
  });
}

module.exports = { createLogger };
