import fetch from "node-fetch";
import { adaptBotApiMessage } from "../messages.js";
import { processMessage } from "../processor.js";
import { getWebhookUrl } from "../config.js";
import { Logger } from "../logger.js";

const logger = new Logger("Webhook");

async function telegramApi(config, method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.apiTimeoutMs),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `Telegram API HTTP ${res.status}`);
  }

  return data.result;
}

export function createWebhookTransport({ config, state }) {
  let monitorTimer = null;
  let restartingWebhook = false;

  async function ensureWebhook({ expectedUrl, reason, dropPendingUpdates = false }) {
    if (restartingWebhook) return;
    restartingWebhook = true;
    try {
      logger.warn(`Re-registering webhook (${reason})`);
      await telegramApi(config, "setWebhook", {
        url: expectedUrl,
        secret_token: config.webhookSecretToken || undefined,
        allowed_updates: config.webhookAllowedUpdates,
        drop_pending_updates: dropPendingUpdates,
      });
      logger.log("Webhook re-registered successfully");
    } finally {
      restartingWebhook = false;
    }
  }

  async function monitorWebhook(expectedUrl) {
    if (!config.webhookMonitorEnabled || config.webhookMonitorIntervalMs <= 0) return;

    monitorTimer = setInterval(async () => {
      try {
        const info = await telegramApi(config, "getWebhookInfo");
        const hasDeliveryError = Boolean(info.last_error_date || info.last_error_message);
        const urlMismatch = info.url !== expectedUrl;

        if (!info.url || urlMismatch || hasDeliveryError) {
          await ensureWebhook({
            expectedUrl,
            reason: !info.url
              ? "missing webhook URL in Telegram"
              : urlMismatch
                ? `URL mismatch (telegram="${info.url}", expected="${expectedUrl}")`
                : `delivery error: ${info.last_error_message || "unknown"}`,
            dropPendingUpdates: false,
          });
        }
      } catch (err) {
        state.lastError = err.message;
        logger.error(`Webhook monitor failed: ${err.message}`);
      }
    }, config.webhookMonitorIntervalMs);

    if (typeof monitorTimer.unref === "function") {
      monitorTimer.unref();
    }
  }

  return {
    async start() {
      if (!config.telegramBotToken) {
        throw new Error("TELEGRAM_BOT_TOKEN or TG_TOKEN is required for webhook mode");
      }

      const webhookUrl = getWebhookUrl();
      if (!webhookUrl) {
        throw new Error("WEBHOOK_PUBLIC_URL is required for webhook mode");
      }

      const me = await telegramApi(config, "getMe");
      state.activeAccount = me.username || me.first_name || "telegram-bot";
      state.activeSession = "BOT_API_WEBHOOK";
      state.activeAccountUsername = me.username || null;

      if (config.webhookSetOnStart) {
        await ensureWebhook({
          expectedUrl: webhookUrl,
          reason: "startup",
          dropPendingUpdates: config.webhookDropPendingUpdates,
        });
      }

      state.transportHealthy = true;
      logger.log(`Webhook activated: ${webhookUrl}`);
      logger.log(`Connected as @${state.activeAccount}`);
      await monitorWebhook(webhookUrl);
    },
    async stop() {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
      state.transportHealthy = false;
    },
    async handleUpdate(update) {
      const message =
        update?.message ||
        update?.channel_post ||
        update?.edited_message ||
        update?.edited_channel_post;

      if (!message) return;

      const text = message.text || message.caption || "";
      const chat = message.chat || {};
      logger.log(
        `Webhook: update message_id=${message.message_id} chat_id=${chat.id} type=${chat.type || "unknown"} from=${message.from?.username || message.from?.id || "—"} len=${text.length} text="${Logger.truncate(text, 400)}"`
      );

      const handled = await processMessage(adaptBotApiMessage(message));
      if (handled) {
        state.lastMessageAt = new Date().toISOString();
      }
    },
  };
}

