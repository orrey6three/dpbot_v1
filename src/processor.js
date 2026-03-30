import { config }           from "./config.js";
import { MessageCache, ProcessedCache } from "./cache.js";
import { parseMessageWithAI }           from "./ai.js";
import { geocodeStreet }                from "./geocoder.js";
import { createPost }                   from "./api.js";

const msgCache       = new MessageCache(200);
const processedCache = new ProcessedCache();

/**
 * Нормализует chatId для сравнения с config.chatId.
 * GramJS может вернуть ID в разных форматах (-100XXX, -XXX, XXX).
 */
function normalizeId(id) {
  return String(id).replace(/^-100/, "");
}

/**
 * Определяет, относится ли сообщение к целевому чату.
 */
function isTargetChat(message, chat) {
  const target  = normalizeId(config.chatId);
  const current = normalizeId(message.chatId ?? "");
  if (current === target) return true;
  if (chat.username && chat.username.toLowerCase() === target.replace("@", "").toLowerCase()) return true;
  return false;
}

/**
 * Восстанавливает текст с учётом цепочки ответов.
 * @returns {Promise<string>}
 */
async function resolveText(message, chatId) {
  let text = message.message;

  const replyTo = message.replyTo;
  const parentId = replyTo?.replyToMsgId ?? null;
  msgCache.set(chatId, message.id, text, parentId);

  if (!parentId) return text;

  const chain = msgCache.getChain(chatId, message.id);
  if (chain.length > 1) {
    return chain.join(". ");
  }

  // В кэше нет — пробуем запросить у Telegram
  try {
    const parent = await message.getReplyMessage();
    if (parent?.message) {
      return `${parent.message}. ${text}`;
    }
  } catch (_) {}

  return text;
}

/**
 * Получает имя отправителя.
 * @returns {Promise<string>}
 */
async function resolveAuthor(message) {
  try {
    const sender = await message.getSender();
    if (!sender) return "Аноним";
    return sender.username || sender.firstName || "Аноним";
  } catch (_) {
    return "Аноним";
  }
}

/**
 * Основная точка обработки одного сообщения.
 * Возвращает false если сообщение было пропущено, true — если обработано.
 * @param {import("telegram").Api.Message} message
 * @returns {Promise<boolean>}
 */
export async function processMessage(message) {
  if (!message?.message) return false;

  // 1. Дедупликация
  const chatId = String(message.chatId ?? "");
  if (processedCache.has(chatId, message.id)) return false;

  // 2. Фильтр по времени
  const ageSeconds = Math.floor(Date.now() / 1000) - message.date;
  if (ageSeconds > config.maxMsgAgeSeconds) return false;

  // 3. Проверка целевого чата
  let chat;
  try {
    chat = await message.getChat();
  } catch (_) {
    return false;
  }
  if (!isTargetChat(message, chat)) return false;

  // Помечаем как обрабатываемое ДО async-операций, чтобы не было race condition
  processedCache.add(chatId, message.id);

  // 4. Восстановление контекста цепочки
  const text   = await resolveText(message, chatId);
  const author = await resolveAuthor(message);

  // 5. AI-парсинг
  let posts;
  try {
    posts = await parseMessageWithAI(text);
  } catch (err) {
    console.error(`[AI ERR] "${text.slice(0, 30)}...":`, err.message);
    return false;
  }

  if (!posts.length) return false;

  console.log(`[MSG] "${text.slice(0, 60)}..." от ${author}`);
  console.log(`[AI] ${posts.length} метка(ок):`, posts.map((p) => `${p.type}:${p.street}`).join(", "));

  // 6. Геокодинг + создание постов — параллельно для всех улиц
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

  for (const r of results) {
    if (r.status === "fulfilled") {
      console.log(`[OK] id=${r.value.id} ${r.value.type}:${r.value.street}`);
    } else {
      console.error(`[ERR]`, r.reason?.message);
    }
  }

  return true;
}
