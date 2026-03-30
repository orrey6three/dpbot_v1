import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import fetch from "node-fetch";
import "dotenv/config";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_ID            = parseInt(process.env.API_ID);
const API_HASH          = process.env.API_HASH;
const STRING_SESSION    = process.env.STRING_SESSION;

const BOT_TOKEN         = process.env.BOT_TOKEN         || "change-me-bot-secret";
const API_URL           = process.env.API_URL            || "https://dpsposts.vercel.app/api/patrol";
const CHAT_ID           = process.env.CHAT_ID           || "-5289298159";
const YANDEX_MAPS_API_KEY = process.env.YANDEX_MAPS_API_KEY;
const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY || "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";
const DEFAULT_CITY      = process.env.DEFAULT_CITY      || "Шумиха";

// ── Простейший кэш сообщений для отслеживания цепочки ответов ──
class MessageCache {
  constructor(limit = 100) {
    this.limit = limit;
    this.cache = new Map(); // "chatId:msgId" -> { text, parentId }
    this.keys = [];
  }
  set(chatId, msgId, text, parentId) {
    const key = `${chatId}:${msgId}`;
    if (this.cache.has(key)) return;
    this.cache.set(key, { text, parentId });
    this.keys.push(key);
    if (this.keys.length > this.limit) {
      const oldKey = this.keys.shift();
      this.cache.delete(oldKey);
    }
  }
  getChain(chatId, startMsgId) {
    let currentId = startMsgId;
    let chain = [];
    let visited = new Set();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const data = this.cache.get(`${chatId}:${currentId}`);
      if (!data) break;
      chain.unshift(data.text);
      currentId = data.parentId;
    }
    return chain;
  }
}
const msgCache = new MessageCache(200);

if (!API_ID || !API_HASH || !YANDEX_MAPS_API_KEY) {
  console.error("❌ API_ID, API_HASH или YANDEX_MAPS_API_KEY не найдены!");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(STRING_SESSION || ""), API_ID, API_HASH, {
  connectionRetries: 5,
});

// ─── AI PARSING ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты парсер сообщений из чата водителей города Шумиха (Россия).
Люди пишут про посты ДПС и патрули на улицах. Твоя задача — извлечь структурированные данные.

Правила определения типа:
- "ДПС" — если сообщение говорит что ДПС/гаишники/полиция/пост/экипаж СТОЯТ или ЕСТЬ на улице
- "Чисто" — если сообщение говорит что ДПС убрали/уехали/нет/чисто/свободно

В городе есть статичные посты. Если люди описывают одно из этих мест (даже сокращенно, например "виадук", "монетка", "белоносова", "автозапад"), в поле street укажи именно это каноничное название:
- Виадук
- Автозапад
- Отдел
- Мир Света
- Угол Ленина/Гоголя
- Монетка Белоносова
- Квартал Новостроек
- Победы/Молодёжи
- Советская/Гоголя
- Кольцо
- Начало Каменской
- ХПП

Для остальных адресов: переделывай названия зданий (школы, больницы, магазины, предприятия) в название **улицы**, на которой они находятся в г. Шумиха Курганской области (например, "школа 3" -> "Ленина", "школа 4" -> "Гоголя", "ЦРБ" -> "Кирова"). Ты умный ИИ, используй свои знания географии. Если не уверен или не знаешь улицу здания — пиши заведение/дом как есть (например, "Минимаркет" или "Ленина 42").

**Важно (Контекст цепочки сообщений):**
Если на вход подается несколько предложений через точку (результат склейки цепочки ответов), то:
1. Ищи название улицы/места в **любой** части текста.
2. Тип ("ДПС" или "Чисто") определяй по **последнему** (самому свежему) смысловому утверждению в цепочке.
   Например: "Монетка чисто. Схуяли? Стоят!" -> Тип должен быть "ДПС", так как "Стоят" — это последнее уточнение.

Верни ТОЛЬКО валидный JSON без каких-либо пояснений и markdown-блоков, строго такого формата:
{
  "posts": [
    { "street": "название улицы", "type": "ДПС" }
  ]
}

Если улицы/базы нет или сообщение нерелевантно (вопрос, флуд, приветствие) — верни:
{ "posts": [] }`;

async function parseMessageWithAI(text) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://dpsposts.vercel.app",
      "X-Title": "DPS Posts Bot",
    },
    body: JSON.stringify({
      model: "google/gemini-2.0-flash-001",
      max_tokens: 300,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("[AI] Не удалось распарсить JSON:", cleaned);
    return [];
  }

  if (!Array.isArray(parsed.posts)) return [];
  return parsed.posts.filter(p => p.street && ["ДПС", "Чисто"].includes(p.type));
}

// ─── GEOCODING ────────────────────────────────────────────────────────────────

async function geocodeStreet(street, city = DEFAULT_CITY) {
  try {
    const query = encodeURIComponent(`${city}, ${street}`);
    const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${YANDEX_MAPS_API_KEY}&format=json&geocode=${query}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Yandex HTTP ${res.status}`);

    const data = await res.json();
    const members = data.response?.GeoObjectCollection?.featureMember;
    if (!members?.length) return null;

    const pos = members[0].GeoObject.Point.pos;
    const [lon, lat] = pos.split(" ").map(Number);
    return [lat, lon];
  } catch (err) {
    console.error(`[GEO ERR] "${street}":`, err.message);
    return null;
  }
}

// ─── API CALL ─────────────────────────────────────────────────────────────────

async function createPost({ street, city, type, comment, coords, author }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-token": BOT_TOKEN,
    },
    body: JSON.stringify({
      token: BOT_TOKEN,
      street,
      city,
      type,
      comment,
      coords,
      author,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── MESSAGE PROCESSING ───────────────────────────────────────────────────────

async function processMessage(message) {
  if (!message || !message.message) return;
  
  const chatId = (message.chatId || message.peerId?.channelId || message.peerId?.chatId || "").toString();
  const chat = await message.getChat();
  
  // 1. ФИЛЬТОР ПО ВРЕМЕНИ (максимум 2 часа назад)
  const now = Math.floor(Date.now() / 1000);
  const msgAge = now - message.date;
  if (msgAge > 7200) return;

  // 2. ПРОВЕРКА CHAT_ID
  const targetIdStr = CHAT_ID.toString().replace('-100', '');
  const currentChatIdStr = chatId ? chatId.replace('-100', '') : '';

  const isTargetChat = 
    currentChatIdStr === targetIdStr || 
    (chat.username && chat.username.toLowerCase() === targetIdStr.replace('@', '').toLowerCase()) ||
    (chatId.toString() === CHAT_ID.toString());

  if (!isTargetChat) return;

  let text = message.message;
  // console.log(`[DEBUG] Обработка сообщения из целевого чата: "${text.substring(0, 30)}..."`);

  const msgId = message.id;
  const replyTo = message.replyTo;
  const parentId = replyTo ? replyTo.replyToMsgId : null;

  msgCache.set(chatId, msgId, text, parentId);

  if (parentId) {
    const chain = msgCache.getChain(chatId, msgId);
    if (chain.length > 1) {
      text = chain.join(". ");
    } else {
      try {
        const parentMsg = await message.getReplyMessage();
        if (parentMsg && parentMsg.message) {
          text = `${parentMsg.message}. ${text}`;
        }
      } catch (e) {}
    }
  }

  let authorName = "Аноним";
  try {
    const sender = await message.getSender();
    if (sender) {
      authorName = sender.username ? sender.username : (sender.firstName || "Аноним");
    }
  } catch (e) {}

  let posts;
  try {
    posts = await parseMessageWithAI(text);
  } catch (err) {
    console.error(`[AI ERR] "${text.substring(0, 30)}":`, err.message);
    return;
  }

  if (!posts.length) {
    // console.log(`[SKIP] AI не нашел меток в сообщении от ${authorName}`);
    return;
  }

  console.log(`[MSG] "${text.substring(0, 50)}..." от ${authorName}`);
  console.log(`[AI] Найдено меток: ${posts.length}`, posts);

  for (const { street, type } of posts) {
    const coords = await geocodeStreet(street);
    try {
      const result = await createPost({
        street,
        city: DEFAULT_CITY,
        type,
        comment: text,
        coords,
        author: authorName
      });
      console.log(`[OK] id=${result.post?.id} type=${type} street=${street}`);
    } catch (err) {
      console.error(`[ERR] API error for "${street}":`, err.message);
    }
  }
}

async function handleNewMessage(event) {
  await processMessage(event.message);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("🚀 Подключение к Telegram...");
  await client.connect();
  
  if (!process.env.STRING_SESSION) {
    console.log("⚠️ STRING_SESSION не найден! Запусти login.js.");
    process.exit(1);
  }

  console.log("✅ Успешное подключение!");

  console.log(`📦 Проверяю историю чата ${CHAT_ID} (новые за 2ч)...`);
  try {
    const history = await client.getMessages(CHAT_ID, { limit: 100 });
    let count = 0;
    for (const msg of history.reverse()) {
      const now = Math.floor(Date.now() / 1000);
      if (now - msg.date < 7200) {
        await processMessage(msg);
        count++;
      }
    }
    console.log(`🏁 Запущено: ${count} сообщений из истории обработано.`);
  } catch (e) {
    console.error("❌ Ошибка истории:", e.message);
  }

  client.addEventHandler(handleNewMessage, new NewMessage({}));
  console.log(`📡 Слушаю новые сообщения...`);
})();