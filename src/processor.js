import { config, normalizeChatId } from "./config.js";
import { MessageCache, ProcessedCache } from "./cache.js";
import { parseMessageWithAI } from "./ai.js";
import { geocodeStreet } from "./geocoder.js";
import { createPost } from "./api.js";
import { Logger } from "./logger.js";

const logger = new Logger("Processor");
const MAX_MESSAGE_LOG_CHARS = Number.parseInt(process.env.LOG_MESSAGE_MAX_CHARS || "", 10) || 500;

const msgCache = new MessageCache(200);
const processedCache = new ProcessedCache(
  config.processedCacheLimit,
  config.processedCacheTtlMs,
  config.stateFilePath
);

// Using normalizeChatId from config.js


async function resolveText(message) {
  const chatId = normalizeChatId(message.chatId ?? "");
  const text = message.text;
  const parentId = message.replyToMessageId ?? null;

  msgCache.set(chatId, message.id, text, parentId);

  if (!parentId) return text;

  const chain = msgCache.getChain(chatId, message.id);
  if (chain.length > 1) {
    return chain.join(". ");
  }

  try {
    const parentText = await message.getReplyText();
    if (parentText) {
      return `${parentText}. ${text}`;
    }
  } catch (_) {}

  return text;
}

async function resolveAuthor(message) {
  try {
    const author = await message.getAuthor();
    return author || "Аноним";
  } catch (_) {
    return "Аноним";
  }
}

/**
 * @typedef {{
 *   id: number,
 *   chatId: string,
 *   chatUsername: string,
 *   text: string,
 *   date: number,
 *   replyToMessageId: number | null,
 *   getReplyText: () => Promise<string | null>,
 *   getAuthor: () => Promise<string>,
 *   getChatUsername?: () => Promise<string>,
 * }} NormalizedMessage
 */

/**
 * @param {NormalizedMessage} message
 * @param {{ targetChatIds?: string[], chatCityMap?: Record<string, string> }} options
 * @returns {Promise<boolean>}
 */
export async function processMessage(message, options = {}) {
  const rawChatId = String(message.chatId ?? "");
  const chatId = normalizeChatId(rawChatId);

  if (!message?.text) {
    logger.verbose(
      `Processor: skip empty text msgId=${message.id} chatId=${rawChatId}`
    );
    return false;
  }

  if (processedCache.has(chatId, message.id)) {
    logger.verbose(
      `Processor: skip already processed msgId=${message.id} chatId=${chatId}`
    );
    return false;
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - message.date;
  if (ageSeconds > config.maxMsgAgeSeconds) {
    logger.verbose(
      `Processor: skip too old msgId=${message.id} ageSec=${ageSeconds} max=${config.maxMsgAgeSeconds}`
    );
    return false;
  }

  const targetIds = (options.targetChatIds || config.targetChatIds || [config.chatId]).map(normalizeChatId);
  const isTarget = targetIds.includes(chatId);

  if (!isTarget) {
    return false;
  }

  const author = await resolveAuthor(message);
  const text = await resolveText(message);
  const cityName =
    options.chatCityMap?.[rawChatId] ||
    options.chatCityMap?.[chatId] ||
    config.chatCityMap?.[rawChatId] ||
    config.chatCityMap?.[chatId] ||
    config.defaultCity;
  const textPreview = Logger.truncate(text, MAX_MESSAGE_LOG_CHARS);

  logger.log(
    `Processor: handling msgId=${message.id} chatId=${rawChatId} norm=${chatId} city=${cityName} author=${author} replyTo=${message.replyToMessageId ?? "—"} text="${textPreview}"`
  );

  let posts;
  try {
    posts = await parseMessageWithAI(text);
  } catch (err) {
    logger.error(`Processor: OpenRouter / AI failed — ${err.message}`);
    if (!err.transient) {
      processedCache.add(chatId, message.id);
    } else {
      logger.warn(`Processor: leaving msgId=${message.id} unprocessed due to transient AI error — will retry on next sighting`);
    }
    return false;
  }

  if (!posts.length) {
    processedCache.add(chatId, message.id);
    logger.log(
      `Processor: done msgId=${message.id} — no API posts (AI returned no patrol rows)`
    );
    return false;
  }

  logger.log(
    `Processor: geocode + createPost for ${posts.length} row(s) msgId=${message.id}`
  );

  const results = await Promise.allSettled(
    posts.map(async ({ street, type }) => {
      const coords = await geocodeStreet(street, cityName);
      const result = await createPost({
        street,
        city: cityName,
        type,
        comment: text,
        coords,
        author,
        date: message.date,
      });

      return { street, type, id: result.post?.id };
    })
  );

  let successCount = 0;
  const failures = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const street = posts[i]?.street ?? "?";
    if (result.status === "fulfilled") {
      successCount++;
      logger.log(
        `Processor: post OK msgId=${message.id} postId=${result.value.id} type=${result.value.type} street=${result.value.street}`
      );
    } else {
      const msg = result.reason?.message ?? String(result.reason);
      failures.push({ street, msg });
    }
  }

  if (failures.length) {
    const byMsg = new Map();
    for (const { street, msg } of failures) {
      if (!byMsg.has(msg)) byMsg.set(msg, []);
      byMsg.get(msg).push(street);
    }
    for (const [msg, streets] of byMsg) {
      logger.warn(
        `Processor: post FAILED msgId=${message.id} streets=[${streets.join(", ")}] — ${msg}`
      );
    }
  }

  if (successCount === posts.length) {
    processedCache.add(chatId, message.id);
    logger.log(
      `Processor: finished msgId=${message.id} — saved ${successCount}/${posts.length} post(s)`
    );
    return true;
  }

  if (successCount === 0) {
    logger.warn(
      `Processor: msgId=${message.id} — all ${posts.length} post(s) failed; not marking processed so it can retry`
    );
    return false;
  }

  logger.warn(
    `Processor: msgId=${message.id} — partial success ${successCount}/${posts.length}; not marking processed (retry may duplicate saved posts)`
  );
  return true;
}
