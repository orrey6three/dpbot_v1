import { TelegramClient } from "telegram";
import { StringSession }  from "telegram/sessions/index.js";
import { NewMessage }     from "telegram/events/index.js";
import { config }         from "./src/config.js";
import { processMessage } from "./src/processor.js";

// ─── HISTORY ──────────────────────────────────────────────────────────────────

async function processHistory(client) {
  console.log(`📦 Читаю историю чата ${config.chatId} (последние 2ч, до ${config.historyLimit} сообщений)...`);
  let messages;
  try {
    messages = await client.getMessages(config.chatId, { limit: config.historyLimit });
  } catch (err) {
    console.error("❌ Не удалось получить историю:", err.message);
    return;
  }

  const cutoff = Math.floor(Date.now() / 1000) - config.maxMsgAgeSeconds;
  const fresh  = messages.filter((m) => m.date >= cutoff).reverse();

  if (!fresh.length) {
    console.log("ℹ️  Свежих сообщений за последние 2ч нет.");
    return;
  }

  let processed = 0;
  for (let i = 0; i < fresh.length; i += config.historyBatchSize) {
    const batch   = fresh.slice(i, i + config.historyBatchSize);
    const results = await Promise.allSettled(batch.map(processMessage));
    processed    += results.filter((r) => r.status === "fulfilled" && r.value === true).length;
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
    // Если ошибка фатальная в рантайме, GramJS обычно отключает клиент или кидает в логи
    console.error("[EVENT ERROR]", err.message);
  }
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────

let currentClient = null;
let shutting_down = false;

async function shutdown(signal) {
  if (shutting_down) return;
  shutting_down = true;
  console.log(`\n🛑 ${signal} получен, завершаю работу...`);
  try {
    if (currentClient) await currentClient.disconnect();
  } catch (_) {}
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function runBot(index = 0) {
  if (!config.sessions.length) {
    console.error("⚠️  Сессии не найдены! Запусти: node login.js");
    process.exit(1);
  }

  if (index >= config.sessions.length) {
    console.error("❌ Все доступные аккаунты не работают (баны или ошибки).");
    process.exit(1);
  }

  const sessionCfg = config.sessions[index];
  console.log(`\n🚀 Пытаюсь запустить [${index + 1}/${config.sessions.length}]: ${sessionCfg.name}...`);

  currentClient = new TelegramClient(
    new StringSession(sessionCfg.stringSession),
    sessionCfg.apiId,
    sessionCfg.apiHash,
    { connectionRetries: 5 }
  );

  try {
    await currentClient.connect();
    const me = await currentClient.getMe();
    console.log(`✅ Подключен как: ${me.username || me.firstName}`);

    await processHistory(currentClient);

    currentClient.addEventHandler(onNewMessage, new NewMessage({}));
    console.log("📡 Слушаю новые сообщения. Ctrl+C для остановки.\n");

    // Обработка критических ошибок соединения
    currentClient.addEventHandler((update) => {
        // Здесь можно добавить логику отслеживания дисконнекта
    });

  } catch (err) {
    console.error(`❌ Ошибка на аккаунте ${sessionCfg.name}:`, err.message);

    const isFatal = err.message.includes("SESSION_REVOKED") || 
                    err.message.includes("USER_DEACTIVATED") ||
                    err.message.includes("AUTH_KEY_UNREGISTERED");

    if (isFatal) {
      console.log("⚠️  Сессия мертва или аккаунт забанен. Пробую следующий...");
      try { await currentClient.disconnect(); } catch (_) {}
      return runBot(index + 1);
    } else {
      console.log("🔄 Техническая ошибка, попробую перезапустить через 10 сек...");
      await new Promise(r => setTimeout(r, 10000));
      return runBot(index);
    }
  }
}

runBot(0).catch(err => {
  console.error("💥 Критическая ошибка основного цикла:", err);
  process.exit(1);
});