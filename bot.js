import { config } from "./src/config.js";
import { createServer } from "./src/server.js";
import { createMtprotoTransport } from "./src/transports/mtproto.js";
import { createWebhookTransport } from "./src/transports/webhook.js";
import { Logger } from "./src/logger.js";

const logger = new Logger("Main");

const state = {
  mode: config.mode,
  transportHealthy: false,
  activeAccount: null,
  activeSession: null,
  activeAccountUsername: null,
  lastFailoverAt: null,
  lastMessageAt: null,
  lastWebhookAt: null,
  lastError: null,
  startedAt: new Date().toISOString(),
};

const transport =
  config.mode === "webhook"
    ? createWebhookTransport({ config, state })
    : createMtprotoTransport({ config, state });

const server = createServer({
  config,
  state,
  onWebhookUpdate: transport.handleUpdate,
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`${signal} received, shutting down...`);

  try {
    await transport.stop?.();
  } catch (err) {
    logger.error(`Error during transport shutdown: ${err.message}`);
  }

  try {
    await server.stop();
  } catch (err) {
    logger.error(`Error during HTTP server shutdown: ${err.message}`);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  if (/TIMEOUT/i.test(msg) && /updates\.js/.test(reason?.stack || "")) {
    logger.warn(`Swallowed telegram updates loop TIMEOUT (library will auto-recover): ${msg}`);
    return;
  }
  logger.error(`Unhandled rejection: ${msg}`);
  if (reason?.stack) logger.error(reason.stack);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  if (err.stack) logger.error(err.stack);
  process.exit(1);
});

async function main() {
  logger.log(`Starting bot in ${config.mode} mode`);
  await server.start();
  await transport.start();

  if (config.mode === "webhook") {
    logger.log("Waiting for incoming webhook requests...");
    await new Promise(() => {});
  }
}

main().catch((err) => {
  state.lastError = err.message;
  logger.error("Critical error in main loop:", err.stack);
  process.exit(1);
});

