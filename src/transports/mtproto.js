import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Raw } from "telegram/events/Raw.js";
import { UpdateConnectionState } from "telegram/network/index.js";
import { config, normalizeChatId } from "../config.js";
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
    message.includes("AUTH_KEY_UNREGISTERED")
  );
}

async function warmupDialogs(client, sessionName) {
  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    logger.log(`[${sessionName}] Dialog cache warmup complete: ${dialogs.length} dialogs loaded`);
  } catch (err) {
    logger.warn(`[${sessionName}] Dialog cache warmup failed: ${err.message}`);
  }
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
    logger.verbose(
      `No fresh messages within maxMsgAgeSeconds (${config.maxMsgAgeSeconds}s) for ${chatId}`
    );
    return;
  }

  let processed = 0;

  for (let index = 0; index < fresh.length; index += config.historyBatchSize) {
    const batch = fresh.slice(index, index + config.historyBatchSize);
    const results = await Promise.allSettled(
      batch.map((message) => 
        withTimeout(
          processMessage(adaptMtprotoMessage(message), options),
          config.messageProcessTimeoutMs,
          `History message ${message.id}`
        ).catch(err => {
          logger.error(`Error processing history message ${message.id}: ${err.message}`);
          return false;
        })
      )
    );

    processed += results.filter(
      (result) => result.status === "fulfilled" && result.value === true
    ).length;

    // History processing is faster now
    if (index + config.historyBatchSize < fresh.length) {
      // Smallest possible yield to event loop
      await new Promise(r => setImmediate(r));
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
    state.activeSession = sessionCfg.name;
    state.activeAccountUsername = null;
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
    let pollTimer = null;
    let lastEventAt = Date.now();
    let lastLoggedState = null;
    let queueLength = 0;

    const targetChatIds = config.targetChatIds || [];
    const connectionEvent = new Raw({ types: [UpdateConnectionState] });

    const normalizedTargetIds = targetChatIds.map(normalizeChatId);

    let processingQueue = Promise.resolve();

    const onNewMessage = async (event) => {
      if (!event.message) return;

      const msgId = event.message.id;
      const text = event.message.message || "";
      let rawChatId = "unknown";
      
      try {
        const peerId = await client.getPeerId(event.message.peerId);
        rawChatId = peerId.toString();
      } catch (err) {
        rawChatId = event.message.chatId?.toString() || "unknown";
      }

      const chatId = normalizeChatId(rawChatId);
      const isTarget = normalizedTargetIds.includes(chatId);

      // WE LOG EVERYTHING AS REQUESTED
      const logPrefix = isTarget ? "TARGET" : "SKIP";
      logger.log(
        `[${sessionCfg.name}] [${logPrefix}] msgId=${msgId} chatId=${rawChatId} text="${Logger.truncate(text, 100)}"`
      );

      if (!isTarget) {
        return;
      }

      // TARGET messages update the watchdog
      lastEventAt = Date.now();
      queueLength++;

      // Sequential processing queue
      processingQueue = processingQueue.then(async () => {
        try {
          await sleep(config.messageIntervalMs);

          const adapted = adaptMtprotoMessage(event.message);
          adapted.chatId = rawChatId;

          const handled = await withTimeout(
            processMessage(adapted, {
              targetChatIds,
              chatCityMap: config.chatCityMap,
            }),
            config.messageProcessTimeoutMs,
            `Message ${msgId}`
          );
          if (handled) {
            state.lastMessageAt = new Date().toISOString();
          }
        } catch (err) {
          state.lastError = err.message;
          logger.error(`[${sessionCfg.name}] Event processing error (msgId=${msgId}): ${err.message}`);
        } finally {
          queueLength = Math.max(0, queueLength - 1);
        }
      });
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
      // Connection events DON'T update lastEventAt anymore (we want actual message activity)

      if (update.state !== lastLoggedState) {
        const label =
          update.state === UpdateConnectionState.connected
            ? "connected"
            : update.state === UpdateConnectionState.disconnected
              ? "disconnected"
              : update.state === UpdateConnectionState.broken
                ? "broken"
                : String(update.state);
        if (update.state === UpdateConnectionState.connected) {
          logger.log(`[${sessionCfg.name}] MTProto: connection state = ${label}`);
        } else if (
          update.state === UpdateConnectionState.disconnected ||
          update.state === UpdateConnectionState.broken
        ) {
          logger.warn(`[${sessionCfg.name}] MTProto: connection state = ${label}`);
        } else {
          logger.debug(`[${sessionCfg.name}] MTProto: connection state = ${label}`);
        }
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
      logger.log(`[${sessionCfg.name}] MTProto: client connected (TCP)`);

      client.addEventHandler(onConnectionState, connectionEvent);

      await warmupDialogs(client, sessionCfg.name);
      const me = await client.getMe();
      const accountLabel = me.username || me.firstName || sessionCfg.name;
      state.activeAccountUsername = me.username || null;
      state.transportHealthy = true;
      logger.log(`Successfully connected session ${sessionCfg.name} as @${accountLabel}`);

      // 1. First, register the event handlers so we don't miss anything while syncing
      client.addEventHandler(onNewMessage, new NewMessage({}));
      
      // Add a raw logger to see if ANY updates are coming from Telegram
      client.addEventHandler((update) => {
        if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
          // These are already handled by onNewMessage
          return;
        }
        // Log other types of updates for debugging
        if (update.constructor) {
          logger.debug(`[${sessionCfg.name}] Raw update: ${update.constructor.name}`);
        }
      });

      const stateResult = await client.invoke(new Api.updates.GetState());
      logger.log(`[${sessionCfg.name}] MTProto: updates state synced (pts=${stateResult.pts})`);

      // onConnectionState already added above
      logger.log(`[${sessionCfg.name}] MTProto: event handlers registered`);

      // 2. Then sync history
      logger.log(
        `[${sessionCfg.name}] MTProto: syncing chat history (${targetChatIds.length} chat(s))...`
      );
      for (const chatId of targetChatIds) {
        try {
          await processHistory(
            client,
            { ...config, chatId },
            { targetChatIds, chatCityMap: config.chatCityMap }
          );
        } catch (err) {
          logger.error(`[${sessionCfg.name}] History sync failed for ${chatId}: ${err.message}`);
        }
      }
      logger.log(`[${sessionCfg.name}] MTProto: chat history sync finished`);

      // 3. Keep-alive probe (Watchdog)
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
          logger.warn(`[${sessionCfg.name}] Watchdog probe failed: ${err.message}`);
          requestRestart(err);
        }
      }, config.connectionProbeIntervalMs);

      // 4. ACTIVE POLLING (The "Genius" fallback)
      // Every 45 seconds, manually check history just in case event stream stalled
      pollTimer = setInterval(async () => {
        if (stopRequested || !client.connected) return;
        
        logger.verbose(`[${sessionCfg.name}] [Active Polling] Checking ${targetChatIds.length} chats for updates...`);
        for (const chatId of targetChatIds) {
          try {
            await processHistory(
              client,
              { ...config, chatId, historyLimit: 10 }, // Check last 10 messages
              { targetChatIds, chatCityMap: config.chatCityMap }
            );
          } catch (err) {
            logger.warn(`[${sessionCfg.name}] Active Polling failed for ${chatId}: ${err.message}`);
          }
        }
      }, 45000);

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
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        client.removeEventHandler(onNewMessage);
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

      logger.log(`Starting failover chain with ${config.sessions.length} sessions...`);
      let index = 0;

      while (!stopRequested) {
        const sessionCfg = config.sessions[index];
        let outcome;
        try {
          outcome = await runSession(sessionCfg, index);
        } catch (err) {
          outcome = {
            reason: err,
            switchAccount: true,
          };
        }
        if (stopRequested) break;

        const reason = outcome?.reason?.message || "unknown reason";
        const isFatal = Boolean(outcome?.switchAccount);
        const nextIndex = (index + 1) % config.sessions.length;
        const nextSession = config.sessions[nextIndex];

        if (isFatal) {
          logger.error(
            `Session "${sessionCfg.name}" failed fatally: ${reason}. Switching to "${nextSession.name}".`
          );
        } else {
          logger.warn(
            `Session "${sessionCfg.name}" stopped: ${reason}. Switching to "${nextSession.name}".`
          );
        }

        state.lastFailoverAt = new Date().toISOString();
        index = nextIndex;
        await sleep(config.reconnectDelayMs);
      }
    },
    async stop() {
      stopRequested = true;
    },
  };
}
