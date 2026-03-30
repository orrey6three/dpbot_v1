import { TelegramClient } from "telegram";
import { StringSession }  from "telegram/sessions/index.js";
import { NewMessage }     from "telegram/events/index.js";
import { config }         from "./src/config.js";
import { processMessage } from "./src/processor.js";

// ─── CLIENT ───────────────────────────────────────────────────────────────────

const client = new TelegramClient(
  new StringSession(config.stringSession),
  config.apiId,
  config.apiHash,
  { connectionRetries: 5 }
);

// ─── HISTORY ──────────────────────────────────────────────────────────────────

async function processHistory() {
  console.log(`📦 Читаю историю чата ${config.chatId} (последние 2ч, до ${config.historyLimit} сообщений)...`);
  let messages;
  try {
    messages = await client.getMessages(config.chatId, { limit: config.historyLimit });
  } catch (err) {
    console.error("❌ Не удалось получить историю:", err.message);
    return;
  }

  // Фильтруем до нужного временного окна и переворачиваем (от старых к новым)
  const cutoff = Math.floor(Date.now() / 1000) - config.maxMsgAgeSeconds;
  const fresh  = messages.filter((m) => m.date >= cutoff).reverse();

  if (!fresh.length) {
    console.log("ℹ️  Свежих сообщений за последние 2ч нет.");
    return;
  }

  // Обрабатываем пакетами чтобы не залить OpenRouter rate-limit
  let processed = 0;
  for (let i = 0; i < fresh.length; i += config.historyBatchSize) {
    const batch   = fresh.slice(i, i + config.historyBatchSize);
    const results = await Promise.allSettled(batch.map(processMessage));
    processed    += results.filter((r) => r.status === "fulfilled" && r.value === true).length;
    // Небольшая пауза между пакетами
    if (i + config.historyBatchSize < fresh.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`🏁 История: ${processed} новых сообщений обработано из ${fresh.length} свежих.`);
}

// ─── EVENT HANDLER ────────────────────────────────────────────────────────────

async function onNewMessage(event) {
  try {
    await processMessage(event.message);
  } catch (err) {
    console.error("[UNHANDLED]", err);
  }
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────

let shutting_down = false;

async function shutdown(signal) {
  if (shutting_down) return;
  shutting_down = true;
  console.log(`\n🛑 ${signal} получен, завершаю работу...`);
  try {
    await client.disconnect();
  } catch (_) {}
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── STARTUP ──────────────────────────────────────────────────────────────────

(async () => {
  if (!config.stringSession) {
    console.error("⚠️  STRING_SESSION не найден! Запусти: node login.js");
    process.exit(1);
  }

  console.log("🚀 Подключение к Telegram...");
  await client.connect();
  console.log("✅ Подключен!");

  await processHistory();

  client.addEventHandler(onNewMessage, new NewMessage({}));
  console.log("📡 Слушаю новые сообщения. Ctrl+C для остановки.\n");
})();