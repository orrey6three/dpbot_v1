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

async function processHistory(client, config, options = {}) {
  const chatId = config.chatId;
  logger.log(`Reading chat history for ${chatId} (limit: ${config.historyLimit})...`);

  let messages;
  try {
    messages = await client.getMessages(chatId, { limit: config.historyLimit });
  } catch (err) {
    logger.error(`Failed to fetch history for ${chatId}: ${err.message}`);
    return;
  }

  const cutoff = Math.floor(Date.now() / 1000) - config.maxMsgAgeSeconds;
  const fresh = messages.filter((message) => message.date >= cutoff).reverse();

  if (!fresh.length) {
    logger.verbose(`No fresh messages found in the last 2 hours for ${chatId}`);
    return;
  }

  let processed = 0;

  for (let index = 0; index < fresh.length; index += config.historyBatchSize) {
    const batch = fresh.slice(index, index + config.historyBatchSize);
    const results = await Promise.allSettled(
      batch.map((message) => processMessage(adaptMtprotoMessage(message), options))
    );

    processed += results.filter(
      (result) => result.status === "fulfilled" && result.value === true
    ).length;

    if (index + config.historyBatchSize < fresh.length) {
      await sleep(300);
    }
  }

  if (processed > 0) {
    logger.log(`History processing for ${chatId} complete: ${processed} new posts created`);
  }
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

    // Создаем маппинг чат -> город для этой сессии
    const cityMappings = {};
    const targetChatIds = sessionCfg.chatIds || [];
    const cityNames = sessionCfg.cityNames || [];
    
    targetChatIds.forEach((id, idx) => {
      const normalizedId = id.replace(/^-100/, "");
      cityMappings[normalizedId] = cityNames[idx] || cityNames[0] || config.defaultCity;
    });

    const onNewMessage = async (event) => {
      lastEventAt = Date.now();
      const msgId = event.message.id;
      const chatId = event.message.chatId?.toString() || "unknown";
      logger.debug(`[${sessionCfg.name}] Incoming message: ID=${msgId} from Chat=${chatId}`);
      
      try {
        const handled = await processMessage(adaptMtprotoMessage(event.message), {
          targetChatIds,
          cityMappings,
        });
        if (handled) {
          state.lastMessageAt = new Date().toISOString();
        }
      } catch (err) {
        state.lastError = err.message;
        logger.error(`[${sessionCfg.name}] Event processing error: ${err.message}`);
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
      
      if (update.state !== lastLoggedState) {
        logger.debug(`[${sessionCfg.name}] Connection state: ${update.state}`);
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
      const accountLabel = me.username || me.firstName || sessionCfg.name;
      state.transportHealthy = true;
      logger.log(`Successfully connected session ${sessionCfg.name} as @${accountLabel}`);

      client.addEventHandler(onNewMessage, messageEvent);
      client.addEventHandler(onConnectionState, connectionEvent);

      probeTimer = setInterval(async () => {
        if (stopRequested) return;

        const idleTime = Date.now() - lastEventAt;
        if (idleTime > 10 * 60 * 1000) {
          logger.warn(`[${sessionCfg.name}] Update stream stalled. Restarting...`);
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
          lastEventAt = Date.now();
        } catch (err) {
          logger.warn(`[${sessionCfg.name}] Watchdog probe failed: ${err.message}`);
          requestRestart(err);
        }
      }, config.connectionProbeIntervalMs);

      // Обработка истории для всех чатов этой сессии
      for (const chatId of targetChatIds) {
        await processHistory(
          client,
          { ...config, chatId },
          { targetChatIds, cityMappings }
        );
      }
      
      logger.log(`[${sessionCfg.name}] Listening for new messages in ${targetChatIds.length} chats...`);

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

      logger.log(`Starting ${config.sessions.length} parallel sessions...`);

      const sessionPromises = config.sessions.map(async (sessionCfg, index) => {
        while (!stopRequested) {
          const outcome = await runSession(sessionCfg, index);
          if (stopRequested) break;

          if (outcome?.switchAccount) {
            logger.error(`Session "${sessionCfg.name}" is FATAL: ${outcome?.reason?.message}. Stopping this session worker.`);
            break; 
          } else {
            const reason = outcome?.reason?.message || "unknown reason";
            logger.warn(`Restarting session "${sessionCfg.name}" in ${config.reconnectDelayMs}ms. Reason: ${reason}`);
            await sleep(config.reconnectDelayMs);
          }
        }
      });

      await Promise.all(sessionPromises);
    },
    async stop() {
      stopRequested = true;
      // В режиме параллельных сессий currentClient хранит только последний запущенный, 
      // но runSession сам закрывает клиент в finally.
    },
  };
}
