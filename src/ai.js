import fetch from "node-fetch";
import { config } from "./config.js";
import { Logger } from "./logger.js";

const logger = new Logger("AI");

const OPENROUTER_MODEL = "google/gemini-2.0-flash-001:free";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Rate-limiter: serializes AI requests + enforces min gap ──────────
const MIN_REQUEST_GAP_MS = 5000;       // 5s gap for OpenRouter free tier
let _lastRequestAt = 0;
let _queue = Promise.resolve();

function enqueue(fn) {
  const task = _queue.then(async () => {
    const now = Date.now();
    const wait = MIN_REQUEST_GAP_MS - (now - _lastRequestAt);
    if (wait > 0) await sleep(wait);
    _lastRequestAt = Date.now();
    return fn();
  });
  _queue = task.catch(() => {});
  return task;
}

const SYSTEM_PROMPT = `Ты — интеллектуальный парсер сообщений из чатов водителей. Твоя задача — понять СМЫСЛ сообщения и извлечь информацию о патрулях (ДПС/ГАИ/полиции) или их отсутствии.

═══════════════════════════════════════
КОНТЕКСТ
═══════════════════════════════════════
Водители в чатах пишут неформально, коротко, с ошибками, сленгом, без знаков препинания. Они предупреждают друг друга о патрулях ДПС. Ты должен понимать ВСЕ формы таких сообщений.

═══════════════════════════════════════
СИНОНИМЫ ДПС (все означают наличие патруля)
═══════════════════════════════════════
Прямые: ДПС, дпс, ГИБДД, гибдд, ГАИ, гаи, патруль
Сленг: менты, мент, гаишники, гайцы, гаёвые, полиция, дэпсники, дпсники, экипаж, засада, ловушка
Глаголы (= стоят/работают): стоят, работают, ловят, тормозят, палят, дежурят, ждут, караулят, ставят, проверяют, останавливают, шмонают, досматривают, записывают, мерят скорость
Предупреждения: аккуратнее, осторожно, внимание, аккурат, акуратней, будьте осторожны, не гони, тише, сбавь
Эмодзи: 👮, 🚔, 🚓, ⚠️, 🔴, ❗, 🚨

═══════════════════════════════════════
СИНОНИМЫ «ЧИСТО» (= патруля НЕТ)
═══════════════════════════════════════
чисто, чист, свободно, нету, нет никого, пусто, пустой, убрались, уехали, слиняли, нет, нема, чистяк, всё ок, свободна, норм, ноль, 0

═══════════════════════════════════════
ИЗВЕСТНЫЕ МЕСТА г. Шумиха
═══════════════════════════════════════
Виадук, Автозапад, Отдел, Мир Света, Кольцо (круговая), ХПП, ЦРБ (цэрэбэ, церебе, больница), Мост, Пост, Заправка, Переезд, Объездная, Трасса, Выезд, Въезд, Кирпичный, Развилка
Улицы: Ленина, Гоголя, Советская, Карла Маркса, Кирова, Мичурина, Пролетарская, Калинина, Октябрьская, Энергетиков

═══════════════════════════════════════
ПРАВИЛА КЛАССИФИКАЦИИ
═══════════════════════════════════════

1. УТВЕРЖДЕНИЯ (= пост) — обрабатывай:
   - Любое сообщение, где УТВЕРЖДАЕТСЯ что патруль стоит/работает/ловит где-то.
   - Сообщение может НЕ содержать слова "ДПС" — если есть место + действие/предупреждение, это пост.
   - Даже одно слово-место (например "кольцо", "ленина", "виадук") БЕЗ глагола — это пост ДПС, если это ответ или утверждение (не вопрос).
   - Предупреждения ("аккуратнее на Ленина") = ДПС.

2. ВОПРОСЫ — НЕ обрабатывай:
   - Содержат вопросительный знак "?" 
   - Начинаются с "где", "как", "что", "есть ли", "кто-нибудь видел"
   - Спрашивают о ситуации: "Как на кольце?", "Чисто нет?", "Что на виадуке?"
   - ИСКЛЮЧЕНИЕ: риторический вопрос с утверждением ("Кто там на Ленина стоит а?" — это утверждение о наличии)

3. ШУТКИ/ОФФТОП — НЕ обрабатывай:
   - Сообщения не связанные с дорожной обстановкой вообще.

4. НОРМАЛИЗАЦИЯ МЕСТ:
   - Исправляй очевидные ошибки: "ленена" → "Ленина", "виодук" → "Виадук", "цэрэбэ" → "ЦРБ", "церебе" → "ЦРБ"
   - Пиши названия с заглавной буквы
   - "на кольце" → "Кольцо", "у поста" → "Пост", "на мосту" → "Мост"

5. МНОЖЕСТВЕННЫЕ ТОЧКИ:
   - Если упоминается несколько мест — создай отдельный пост для каждого.
   - "На Ленина и кольце стоят" → два поста.

═══════════════════════════════════════
ПРИМЕРЫ (вход → выход)
═══════════════════════════════════════

"ДПС на Ленина" → { "posts": [{ "street": "Ленина", "type": "ДПС" }] }
"на ленина" → { "posts": [{ "street": "Ленина", "type": "ДПС" }] }
"ленина стоят" → { "posts": [{ "street": "Ленина", "type": "ДПС" }] }
"Кольцо" → { "posts": [{ "street": "Кольцо", "type": "ДПС" }] }
"аккуратнее виадук" → { "posts": [{ "street": "Виадук", "type": "ДПС" }] }
"менты у цэрэбэхи" → { "posts": [{ "street": "ЦРБ", "type": "ДПС" }] }
"👮 мост" → { "posts": [{ "street": "Мост", "type": "ДПС" }] }
"Работают на Гоголя" → { "posts": [{ "street": "Гоголя", "type": "ДПС" }] }
"гаи ленина гоголя" → { "posts": [{ "street": "Ленина", "type": "ДПС" }, { "street": "Гоголя", "type": "ДПС" }] }
"осторожно на кольце ловят" → { "posts": [{ "street": "Кольцо", "type": "ДПС" }] }
"виадук чисто" → { "posts": [{ "street": "Виадук", "type": "Чисто" }] }
"на кольце нет никого" → { "posts": [{ "street": "Кольцо", "type": "Чисто" }] }
"уехали с ленина" → { "posts": [{ "street": "Ленина", "type": "Чисто" }] }
"Где стоят?" → { "posts": [] }
"Как на виадуке?" → { "posts": [] }
"Чисто нет?" → { "posts": [] }
"привет всем" → { "posts": [] }
"когда дождь кончится" → { "posts": [] }

═══════════════════════════════════════
ФОРМАТ ОТВЕТА
═══════════════════════════════════════
Верни ТОЛЬКО валидный JSON, без пояснений:
{ "posts": [{ "street": "НазваниеМеста", "type": "ДПС" | "Чисто" }] }

Если сообщение — вопрос, шутка, оффтоп или невозможно определить место — верни:
{ "posts": [] }`;

/**
 * @param {string} text
 * @returns {Promise<Array<{ street: string, type: "ДПС" | "Чисто" }>>}
 */
const MAX_AI_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 3000;
const RETRY_429_BASE_DELAY_MS = 10000;

function isTransientStatus(status) {
  return status === 408 || status === 429 || status === 425 || (status >= 500 && status <= 599);
}

export function parseMessageWithAI(text) {
  return enqueue(() => _callOpenRouter(text));
}

async function _callOpenRouter(text) {
  const start = Date.now();
  logger.log(
    `OpenRouter: request start model=${OPENROUTER_MODEL} chars=${String(text || "").length}`
  );

  let res;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:  "POST",
        timeout: config.apiTimeoutMs,
        headers: {
          "Authorization": `Bearer ${config.openrouterKey}`,
          "Content-Type":  "application/json",
          "HTTP-Referer":  "https://dpsposts.vercel.app",
          "X-Title":       "DPS Posts Bot",
        },
        body: JSON.stringify({
          model:       OPENROUTER_MODEL,
          max_tokens:  300,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: text },
          ],
        }),
      });
    } catch (netErr) {
      lastErr = netErr;
      if (attempt < MAX_AI_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * attempt;
        logger.warn(`OpenRouter: network error (attempt ${attempt}/${MAX_AI_ATTEMPTS}) — ${netErr.message}; retry in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      const e = new Error(`OpenRouter network failure: ${netErr.message}`);
      e.transient = true;
      throw e;
    }

    if (res.ok) break;

    const errBody = await res.text();
    const transient = isTransientStatus(res.status);
    logger.error(`OpenRouter: HTTP ${res.status} — ${Logger.truncate(errBody, 200)}`);

    if (transient && attempt < MAX_AI_ATTEMPTS) {
      const delay = res.status === 429
        ? RETRY_429_BASE_DELAY_MS * attempt
        : RETRY_BASE_DELAY_MS * attempt;
      logger.warn(`OpenRouter: transient ${res.status} (attempt ${attempt}/${MAX_AI_ATTEMPTS}); retry in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    const err = new Error(`OpenRouter HTTP ${res.status}: ${errBody}`);
    err.transient = transient;
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  const elapsed = Date.now() - start;
  logger.log(`OpenRouter: response OK in ${elapsed}ms, rawChars=${raw.length}`);

  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.error(`AI: failed to parse JSON — ${Logger.truncate(cleaned, 120)}`);
    return [];
  }

  if (!Array.isArray(parsed.posts)) {
    logger.warn("AI: response had no posts array, treating as empty");
    return [];
  }

  const filtered = parsed.posts.filter(
    (p) => p.street && ["ДПС", "Чисто"].includes(p.type)
  );

  if (filtered.length > 0) {
    logger.log(
      `AI: parsed ${filtered.length} patrol entr${filtered.length === 1 ? "y" : "ies"} — ${filtered.map((p) => `${p.type}:${p.street}`).join("; ")}`
    );
  } else {
    logger.log("AI: no patrol entries extracted (irrelevant or empty posts)");
  }

  return filtered;
}
