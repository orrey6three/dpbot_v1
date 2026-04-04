import { config } from "./src/config.js";
import { createServer } from "./src/server.js";
import { createMtprotoTransport } from "./src/transports/mtproto.js";
import { createWebhookTransport } from "./src/transports/webhook.js";

const state = {
  mode: config.mode,
  transportHealthy: false,
  activeAccount: null,
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
  console.log(`\n🛑 ${signal} получен, завершаю работу...`);

  try {
    await transport.stop?.();
  } catch (err) {
    console.error("❌ Ошибка при остановке транспорта:", err.message);
  }

  try {
    await server.stop();
  } catch (err) {
    console.error("❌ Ошибка при остановке HTTP сервера:", err.message);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  console.log(`🚦 Режим запуска: ${config.mode}`);
  await server.start();
  await transport.start();

  if (config.mode === "webhook") {
    console.log("📨 Ожидаю входящие webhook запросы...\n");
    await new Promise(() => {});
  }
}

main().catch((err) => {
  state.lastError = err.message;
  console.error("💥 Критическая ошибка основного цикла:", err);
  process.exit(1);
});

