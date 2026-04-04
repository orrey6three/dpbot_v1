import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Raw } from "telegram/events/Raw.js";
import { UpdateConnectionState } from "telegram/network/index.js";
import { adaptMtprotoMessage } from "../messages.js";
import { processMessage } from "../processor.js";
import { Logger } from "../logger.js";

const logger = new Logger("MTProto");

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
    message.includes("AUTH_KEY_UNREGISTERED") ||
    message.includes("AUTH_KEY_DUPLICATED")
  );
}

async function processHistory(client, config) {
  logger.log(`Reading chat history for ${config.chatId} (limit: ${config.historyLimit})...`);

  let messages;
  try {
    messages = await client.getMessages(config.chatId, { limit: config.historyLimit });
  } catch (err) {
    logger.error(`Failed to fetch history: ${err.message}`);
    return;
  }

  const cutoff = Math.floor(Date.now() / 1000) - config.maxMsgAgeSeconds;
  const fresh = messages.filter((message) => message.date >= cutoff).reverse();

  if (!fresh.length) {
    logger.verbose("No fresh messages found in the last 2 hours");
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

  logger.log(`History processing complete: ${processed} new posts created`);
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

    logger.log(`Starting account [${index + 1}/${config.sessions.length}]: ${sessionCfg.name}`);

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
    let lastEventAt = Date.now();
    let lastLoggedState = null;

    const messageEvent = new NewMessage({});
    const connectionEvent = new Raw({ types: [UpdateConnectionState] });

    const onNewMessage = async (event) => {
      lastEventAt = Date.now();
      const msgId = event.message.id;
      const chatId = event.message.chatId?.toString() || "unknown";
      logger.debug(`Incoming message received: ID=${msgId} from Chat=${chatId}`);
      
      try {
        const handled = await processMessage(adaptMtprotoMessage(event.message));
        if (handled) {
          state.lastMessageAt = new Date().toISOString();
        }
      } catch (err) {
        state.lastError = err.message;
        logger.error(`Event processing error: ${err.message}`);
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
      lastEventAt = Date.now();
      
      // Логируем только если состояние реально изменилось, чтобы не спамить
      if (update.state !== lastLoggedState) {
        logger.debug(`Connection state: ${update.state}`);
        lastLoggedState = update.state;
      }

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
      logger.log(`Successfully connected as @${state.activeAccount}`);

      client.addEventHandler(onNewMessage, messageEvent);
      client.addEventHandler(onConnectionState, connectionEvent);

      probeTimer = setInterval(async () => {
        if (stopRequested) return;

        // Если не было ВООБЩЕ никаких событий (даже пингов) более 10 минут
        const idleTime = Date.now() - lastEventAt;
        if (idleTime > 10 * 60 * 1000) {
          logger.warn(`Update stream stalled (no events for ${Math.floor(idleTime/1000)}s). Restarting...`);
          requestRestart(new Error("Update stream stalled"));
          return;
        }

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
          // GetState прошел успешно - это тоже событие активности
          lastEventAt = Date.now();
        } catch (err) {
          logger.warn(`Watchdog probe failed: ${err.message}`);
          requestRestart(err);
        }
      }, config.connectionProbeIntervalMs);

      await processHistory(client, config);
      logger.log("Listening for new messages...");

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
          logger.warn(`Session "${config.sessions[index].name}" is unavailable (banned or active elsewhere). Switching...`);
          index += 1;
        } else {
          const reason = outcome?.reason?.message || "unknown reason";
          logger.warn(`Restarting session in ${config.reconnectDelayMs}ms. Reason: ${reason}`);
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
