import { config } from "./config.js";
import { MessageCache, ProcessedCache } from "./cache.js";
import { parseMessageWithAI } from "./ai.js";
import { geocodeStreet } from "./geocoder.js";
import { createPost } from "./api.js";
import { Logger } from "./logger.js";

const logger = new Logger("Processor");

const msgCache = new MessageCache(200);
const processedCache = new ProcessedCache(
  config.processedCacheLimit,
  config.processedCacheTtlMs,
  config.stateFilePath
);

function normalizeId(id) {
  return String(id).replace(/^-100/, "");
}

async function isTargetChat(message) {
  const target = normalizeId(config.chatId);
  const current = normalizeId(message.chatId ?? "");
  if (current === target) return true;
  const chatUsername = message.chatUsername || (await message.getChatUsername?.()) || "";
  if (chatUsername && chatUsername.toLowerCase() === target.replace("@", "").toLowerCase()) {
    return true;
  }
  return false;
}

async function resolveText(message) {
  const chatId = normalizeId(message.chatId ?? "");
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
 * @returns {Promise<boolean>}
 */
export async function processMessage(message) {
  if (!message?.text) return false;

  const chatId = normalizeId(message.chatId ?? "");
  if (processedCache.has(chatId, message.id)) return false;

  const ageSeconds = Math.floor(Date.now() / 1000) - message.date;
  if (ageSeconds > config.maxMsgAgeSeconds) return false;

  if (!(await isTargetChat(message))) return false;

  const author = await resolveAuthor(message);
  const text = await resolveText(message);
  
  logger.log(`Processing message from ${author}: "${text.slice(0, 50)}..."`);

  processedCache.add(chatId, message.id);

  let posts;
  try {
    posts = await parseMessageWithAI(text);
  } catch (err) {
    logger.error(`AI Analysis failed: ${err.message}`);
    return false;
  }

  if (!posts.length) {
    logger.verbose("No relevant tags found in the message");
    return false;
  }

  logger.log(`Found ${posts.length} entries. Starting geocoding and post creation...`);

  const results = await Promise.allSettled(
    posts.map(async ({ street, type }) => {
      const coords = await geocodeStreet(street);
      const result = await createPost({
        street,
        city: config.defaultCity,
        type,
        comment: text,
        coords,
        author,
      });
      return { street, type, id: result.post?.id };
    })
  );

  let successCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      successCount++;
      logger.verbose(`Created post id=${result.value.id} [${result.value.type}] ${result.value.street}`);
    } else {
      logger.error(`Post creation error: ${result.reason?.message}`);
    }
  }

  if (successCount > 0) {
    logger.log(`Successfully handled ${successCount}/${posts.length} entries`);
  }

  return true;
}
