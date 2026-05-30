import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Raw } from "telegram/events/Raw.js";
import { UpdateConnectionState } from "telegram/network/index.js";
import { chatIdsMatch, config, normalizeChatId } from "../config.js";
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

function isChatAccessError(error) {
  const message = error?.message || "";
  return (
    message.includes("Could not find the input entity") ||
    error?.errorMessage === "CHANNEL_INVALID" ||
    error?.errorMessage === "CHANNEL_PRIVATE" ||
    error?.errorMessage === "CHAT_ID_INVALID"
  );
}

async function warmupDialogs(client, sessionName, targetChatIds = []) {
  try {
    const normalizedTargets = new Set(targetChatIds.map(normalizeChatId));
    const groups = [];

    function extractGroups(dialogs) {
      for (const dialog of dialogs) {
        const entity = dialog.entity;
        if (!entity || (!dialog.isGroup && !dialog.isChannel)) continue;
        const markedId = entity.className === "Channel"
          ? `-100${entity.id}`
          : `-${entity.id}`;
        if (!groups.some(g => g.markedId === markedId)) {
          const isTarget = normalizedTargets.has(normalizeChatId(markedId));
          groups.push({ markedId, title: entity.title || "?", isTarget });
        }
      }
    }

    let dialogs = await client.getDialogs({ limit: 200 });
    extractGroups(dialogs);

    let missing = targetChatIds.filter(
      (id) => !groups.some((g) => normalizeChatId(g.markedId) === normalizeChatId(id))
    );

    if (missing.length > 0) {
      logger.log(`[${sessionName}] Top 200 dialogs loaded. Missing some target chats, checking archived folders...`);
      const archivedDialogs = await client.getDialogs({ limit: 200, folder: 1 });
      extractGroups(archivedDialogs);
      missing = targetChatIds.filter(
        (id) => !groups.some((g) => normalizeChatId(g.markedId) === normalizeChatId(id))
      );
    }

    if (missing.length > 0) {
      logger.log(`[${sessionName}] Still missing ${missing.length} target chats. Fetching all dialogs (this may take a moment)...`);
      const allDialogs = await client.getDialogs({ limit: undefined });
      extractGroups(allDialogs);
      missing = targetChatIds.filter(
        (id) => !groups.some((g) => normalizeChatId(g.markedId) === normalizeChatId(id))
      );
    }

    logger.log(`[${sessionName}] Dialog cache warmup complete: ${groups.length} groups/channels loaded`);

    if (groups.length) {
      logger.log(`[${sessionName}] --- Groups/channels in account ---`);
      for (const g of groups) {
        const mark = g.isTarget ? "TARGET" : "      ";
        logger.log(`[${sessionName}]   [${mark}] ${g.markedId} "${g.title}"`);
      }
      logger.log(`[${sessionName}] --- end groups (${groups.length}) ---`);
    }

    if (missing.length) {
      logger.warn(
        `[${sessionName}] Target chats NOT FOUND in dialogs: ${missing.join(", ")}. Check .env chat IDs!`
      );
    }

    return {
      groups,
      accessibleMarkedIds: groups
        .filter((g) => targetChatIds.some((id) => chatIdsMatch(g.markedId, id)))
        .map((g) => g.markedId),
    };
  } catch (err) {
    logger.warn(`[${sessionName}] Dialog cache warmup failed: ${err.message}`);
    return { groups: [], accessibleMarkedIds: [] };
  }
}

async function processHistory(client, config, options = {}) {
  const chatId = config.chatId;
  logger.log(`Reading chat history for ${chatId} (limit: ${config.historyLimit})...`);

  let messages;
  try {
    const entity = await client.getEntity(chatId);
    messages = await client.getMessages(entity, { limit: config.historyLimit });
  } catch (err) {
    if (isChatAccessError(err)) {
      logger.warn(
        `Skip history for ${chatId}: this account is not in the chat (${err.errorMessage || err.message})`
      );
      return;
    }
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

    let sessionTargetChats = targetChatIds;
    let normalizedTargetIds = targetChatIds.map(normalizeChatId);

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

      if (!isTarget) return;

      logger.log(
        `[${sessionCfg.name}] [TARGET] msgId=${msgId} chatId=${rawChatId} text="${Logger.truncate(text, 100)}"`
      );

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

      const warmup = await warmupDialogs(client, sessionCfg.name, targetChatIds);
      sessionTargetChats = targetChatIds.filter((id) =>
        warmup.accessibleMarkedIds.some((mid) => chatIdsMatch(mid, id))
      );
      normalizedTargetIds = sessionTargetChats.map(normalizeChatId);

      const skipped = targetChatIds.filter(
        (id) => !sessionTargetChats.some((ok) => chatIdsMatch(ok, id))
      );
      if (skipped.length) {
        logger.warn(
          `[${sessionCfg.name}] Chats skipped (not in this account's dialogs): ${skipped.join(", ")} — add the account to the chat or disable the session`
        );
      }
      if (!sessionTargetChats.length) {
        logger.warn(
          `[${sessionCfg.name}] No target chats available for this session; only failover / reconnect will run`
        );
      }

      const me = await client.getMe();
      const accountLabel = me.username || me.firstName || sessionCfg.name;
      state.activeAccountUsername = me.username || null;
      state.transportHealthy = true;
      logger.log(`Successfully connected session ${sessionCfg.name} as @${accountLabel}`);

      // 1. First, register the event handlers so we don't miss anything while syncing
      client.addEventHandler(onNewMessage, new NewMessage({}));
      
      const stateResult = await client.invoke(new Api.updates.GetState());
      logger.log(`[${sessionCfg.name}] MTProto: updates state synced (pts=${stateResult.pts})`);

      logger.log(`[${sessionCfg.name}] MTProto: event handlers registered`);

      // 2. Then sync history
      logger.log(
        `[${sessionCfg.name}] MTProto: syncing chat history (${sessionTargetChats.length}/${targetChatIds.length} chat(s))...`
      );
      for (const chatId of sessionTargetChats) {
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

      // 4. Опрос истории по таймеру (страховка от залипшего стрима апдейтов gramjs)
      if (config.mtprotoHistoryPollIntervalMs > 0) {
        logger.log(`[${sessionCfg.name}] History polling enabled: every ${config.mtprotoHistoryPollIntervalMs / 1000}s`);
        pollTimer = setInterval(async () => {
          if (stopRequested || !client.connected) return;

          logger.log(
            `[${sessionCfg.name}] [History poll] Checking ${sessionTargetChats.length} chats (limit=${config.mtprotoHistoryPollLimit})...`
          );
          for (const chatId of sessionTargetChats) {
            try {
              await processHistory(
                client,
                {
                  ...config,
                  chatId,
                  historyLimit: config.mtprotoHistoryPollLimit,
                },
                { targetChatIds, chatCityMap: config.chatCityMap }
              );
            } catch (err) {
              logger.warn(`[${sessionCfg.name}] History poll failed for ${chatId}: ${err.message}`);
            }
          }
        }, config.mtprotoHistoryPollIntervalMs);

        if (typeof pollTimer.unref === "function") {
          pollTimer.unref();
        }
      }

      logger.log(
        `[${sessionCfg.name}] Listening for new messages in ${sessionTargetChats.length} chat(s)...`
      );

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

      const singleSession = config.sessions.length === 1;
      logger.log(
        singleSession
          ? `MTProto: single session mode (${config.sessions[0].name}), reconnect delay ${config.reconnectDelayMs}ms`
          : `Starting failover chain with ${config.sessions.length} sessions...`
      );
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

        if (singleSession) {
          logger.warn(
            `Session "${sessionCfg.name}" stopped: ${reason}. Reconnecting in ${config.reconnectDelayMs}ms...`
          );
        } else if (isFatal) {
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
