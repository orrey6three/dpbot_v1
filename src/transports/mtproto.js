import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Raw } from "telegram/events/Raw.js";
import { UpdateConnectionState } from "telegram/network/index.js";
import { adaptMtprotoMessage } from "../messages.js";
import { processMessage } from "../processor.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isFatalSessionError(error) {
  const message = error?.message || "";
  return (
    message.includes("SESSION_REVOKED") ||
    message.includes("USER_DEACTIVATED") ||
    message.includes("AUTH_KEY_UNREGISTERED")
  );
}

async function processHistory(client, config) {
  console.log(
    `📦 Читаю историю чата ${config.chatId} (последние 2ч, до ${config.historyLimit} сообщений)...`
  );

  let messages;
  try {
    messages = await client.getMessages(config.chatId, { limit: config.historyLimit });
  } catch (err) {
    console.error("❌ Не удалось получить историю:", err.message);
    return;
  }

  const cutoff = Math.floor(Date.now() / 1000) - config.maxMsgAgeSeconds;
  const fresh = messages.filter((message) => message.date >= cutoff).reverse();

  if (!fresh.length) {
    console.log("ℹ️  Свежих сообщений за последние 2ч нет.");
    return;
  }

  let processed = 0;

  for (let index = 0; index < fresh.length; index += config.historyBatchSize) {
    const batch = fresh.slice(index, index + config.historyBatchSize);
    const results = await Promise.allSettled(
      batch.map((message) => processMessage(adaptMtprotoMessage(message)))
    );

    processed += results.filter(
      (result) => result.status === "fulfilled" && result.value === true
    ).length;

    if (index + config.historyBatchSize < fresh.length) {
      await sleep(300);
    }
  }

  console.log(`🏁 История: ${processed} новых сообщений обработано из ${fresh.length} свежих.`);
}

export function createMtprotoTransport({ config, state }) {
  let stopRequested = false;
  let currentClient = null;

  async function stopCurrentClient() {
    if (!currentClient) return;
    try {
      await currentClient.disconnect();
    } catch (_) {}
    currentClient = null;
  }

  async function runSession(sessionCfg, index) {
    if (!sessionCfg.stringSession || !Number.isFinite(sessionCfg.apiId) || !sessionCfg.apiHash) {
      throw new Error(`Некорректные настройки для ${sessionCfg.name}`);
    }

    console.log(`\n🚀 Пытаюсь запустить [${index + 1}/${config.sessions.length}]: ${sessionCfg.name}...`);

    const client = new TelegramClient(
      new StringSession(sessionCfg.stringSession),
      sessionCfg.apiId,
      sessionCfg.apiHash,
      {
        connectionRetries: 5,
        reconnectRetries: Infinity,
        autoReconnect: true,
        retryDelay: config.reconnectDelayMs,
      }
    );

    currentClient = client;
    state.activeAccount = sessionCfg.name;
    state.transportHealthy = false;

    const lifecycle = (() => {
      let settled = false;
      let resolvePromise;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      return {
        promise,
        resolve(payload) {
          if (settled) return;
          settled = true;
          resolvePromise(payload);
        },
      };
    })();

    let reconnectTimer = null;
    let probeTimer = null;

    const messageEvent = new NewMessage({});
    const connectionEvent = new Raw({ types: [UpdateConnectionState] });

    const onNewMessage = async (event) => {
      try {
        const handled = await processMessage(adaptMtprotoMessage(event.message));
        if (handled) {
          state.lastMessageAt = new Date().toISOString();
        }
      } catch (err) {
        state.lastError = err.message;
        console.error("[EVENT ERROR]", err.message);
      }
    };

    const requestRestart = (reason, options = {}) => {
      if (stopRequested) return;
      if (reason?.message) {
        state.lastError = reason.message;
      }
      lifecycle.resolve({
        reason,
        switchAccount: options.switchAccount || false,
      });
    };

    const onConnectionState = (update) => {
      if (update.state === UpdateConnectionState.connected) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        state.transportHealthy = true;
        return;
      }

      if (
        update.state === UpdateConnectionState.disconnected ||
        update.state === UpdateConnectionState.broken
      ) {
        state.transportHealthy = false;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!client.connected) {
              requestRestart(new Error("MTProto соединение потеряно"));
            }
          }, config.connectionGraceMs);
        }
      }
    };

    try {
      await client.connect();
      const me = await client.getMe();
      state.activeAccount = me.username || me.firstName || sessionCfg.name;
      state.transportHealthy = true;
      console.log(`✅ Подключен как: ${state.activeAccount}`);

      client.addEventHandler(onNewMessage, messageEvent);
      client.addEventHandler(onConnectionState, connectionEvent);

      probeTimer = setInterval(async () => {
        if (stopRequested) return;
        if (!client.connected) {
          requestRestart(new Error("MTProto клиент потерял соединение"));
          return;
        }

        try {
          await withTimeout(
            client.invoke(new Api.updates.GetState()),
            config.connectionProbeTimeoutMs,
            "updates.GetState"
          );
        } catch (err) {
          console.error("[WATCHDOG]", err.message);
          requestRestart(err);
        }
      }, config.connectionProbeIntervalMs);

      await processHistory(client, config);

      console.log("📡 Слушаю новые сообщения. Ctrl+C для остановки.\n");

      const outcome = await lifecycle.promise;
      return outcome;
    } catch (err) {
      if (err?.message) {
        state.lastError = err.message;
      }
      return {
        reason: err,
        switchAccount: isFatalSessionError(err),
      };
    } finally {
      state.transportHealthy = false;
      if (probeTimer) clearInterval(probeTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        client.removeEventHandler(onNewMessage, messageEvent);
        client.removeEventHandler(onConnectionState, connectionEvent);
      } catch (_) {}
      try {
        await client.disconnect();
      } catch (_) {}
      if (currentClient === client) {
        currentClient = null;
      }
    }
  }

  return {
    async start() {
      if (!config.sessions.length) {
        throw new Error("Сессии не найдены. Запусти: node login.js");
      }

      let index = 0;

      while (!stopRequested) {
        if (index >= config.sessions.length) {
          throw new Error("Все доступные аккаунты не работают (баны или ошибки).");
        }

        const outcome = await runSession(config.sessions[index], index);
        if (stopRequested) return;

        if (outcome?.switchAccount) {
          console.log("⚠️  Сессия мертва или аккаунт забанен. Пробую следующий...");
          index += 1;
        } else {
          const reason = outcome?.reason?.message || "неизвестная ошибка";
          console.log(`🔄 Перезапускаю MTProto через ${config.reconnectDelayMs}мс: ${reason}`);
          await sleep(config.reconnectDelayMs);
        }
      }
    },
    async stop() {
      stopRequested = true;
      await stopCurrentClient();
    },
  };
}
