"use strict";

const { buildConfig } = require("./config");
const { createLogger } = require("./logger");
const { Streamer } = require("./stream");
const { createApi } = require("./api");
const { ThermalMonitor } = require("./thermal");

async function main() {
  // Bootstrap logger so auto-profile detection has somewhere to
  // emit its findings before we know the final log level. The
  // real logger is rebuilt below once config is loaded.
  const bootLogger = createLogger(process.env.LOG_LEVEL || "info").child({ module: "boot" });
  const config = buildConfig({ logger: bootLogger });
  const logger = createLogger(config.runtime.logLevel);

  logger.info(
    {
      resolution: `${config.video.width}x${config.video.height}`,
      fps: config.video.fps,
      codec: config.video.codec,
      defaultScene: config.scene.defaultUrl,
      apiPort: config.api.port,
      autoStart: config.runtime.autoStart,
      profileMode: config.runtime.profileMode,
      profileCategory: config.runtime.autoProfile?.category || "manual",
    },
    "streamer booting"
  );

  const streamer = new Streamer({
    config,
    logger: logger.child({ module: "stream" }),
  });

  const thermal = new ThermalMonitor({
    config,
    streamer,
    logger: logger.child({ module: "thermal" }),
  });
  thermal.start();
  streamer.thermal = thermal; // exposed via /status

  const api = createApi({
    streamer,
    config,
    logger: logger.child({ module: "api" }),
  });
  await api.listen();

  if (config.runtime.autoStart) {
    streamer.start().catch((err) =>
      logger.error({ err }, "auto-start failed (will reconnect)")
    );
  }

  const shutdown = async (signal) => {
    logger.info({ signal }, "shutting down");
    try { thermal.stop(); } catch {}
    try { await streamer.stop(); } catch (err) { logger.warn({ err }, "stop error"); }
    await api.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
}

main().catch((err) => {
  console.error("streamer failed to start:", err);
  process.exit(1);
});
