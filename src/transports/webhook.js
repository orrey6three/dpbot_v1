import fetch from "node-fetch";
import { adaptBotApiMessage } from "../messages.js";
import { processMessage } from "../processor.js";
import { getWebhookUrl } from "../config.js";

async function telegramApi(config, method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `Telegram API HTTP ${res.status}`);
  }

  return data.result;
}

export function createWebhookTransport({ config, state }) {
  return {
    async start() {
      if (!config.telegramBotToken) {
        throw new Error("Для webhook режима нужен TELEGRAM_BOT_TOKEN или TG_TOKEN");
      }

      const webhookUrl = getWebhookUrl();
      if (!webhookUrl) {
        throw new Error("Для webhook режима нужен WEBHOOK_PUBLIC_URL");
      }

      const me = await telegramApi(config, "getMe");
      state.activeAccount = me.username || me.first_name || "telegram-bot";

      if (config.webhookSetOnStart) {
        await telegramApi(config, "setWebhook", {
          url: webhookUrl,
          secret_token: config.webhookSecretToken || undefined,
          allowed_updates: config.webhookAllowedUpdates,
          drop_pending_updates: config.webhookDropPendingUpdates,
        });
      }

      state.transportHealthy = true;
      console.log(`✅ Webhook активирован: ${webhookUrl}`);
      console.log(`🤖 Подключен как бот: ${state.activeAccount}`);
    },
    async stop() {
      state.transportHealthy = false;
    },
    async handleUpdate(update) {
      const message =
        update?.message ||
        update?.channel_post ||
        update?.edited_message ||
        update?.edited_channel_post;

      if (!message) return;

      const handled = await processMessage(adaptBotApiMessage(message));
      if (handled) {
        state.lastMessageAt = new Date().toISOString();
      }
    },
  };
}

