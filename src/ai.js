import fetch from "node-fetch";
import { config } from "./config.js";
import { Logger } from "./logger.js";

const logger = new Logger("AI");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_REQUEST_GAP_MS = Number.parseInt(process.env.AI_MIN_GAP_MS || "", 10) || 1500;
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
Номера машин: часто пишут просто бортовой номер (3 цифры), например: 575, 544, 432 и т.д. Если видишь 3 цифры в контексте дороги — это ДПС.
Глаголы (= стоят/работают): стоят, работают, ловят, тормозят, палят, дежурят, ждут, караулят, ставят, проверяют, останавливают, шмонают, досматривают, записывают, мерят скорость, раскатывают, пасутся, крутятся, высматривают
Предупреждения: аккуратнее, осторожно, внимание, аккурат, акуратней, будьте осторожны, не гони, тише, сбавь
Эмодзи: 👮, 🚔, 🚓, ⚠️, 🔴, ❗, 🚨

═══════════════════════════════════════
СИНОНИМЫ «ЧИСТО» (= патруля НЕТ)
═══════════════════════════════════════
чисто, чист, свободно, нету, нет никого, пусто, пустой, убрались, уехали, слиняли, нет, нема, чистяк, всё ок, свободна, норм, ноль, 0

═══════════════════════════════════════
ИЗВЕСТНЫЕ МЕСТА г. Шумиха и окрестности
═══════════════════════════════════════
Ориентиры: Виадук, Автозапад, Отдел, Мир Света, Кольцо (круговая), ХПП, ЦРБ (цэрэбэ, церебе, больница), Мост, Пост, Заправка, Переезд, Объездная, Трасса, Выезд, Въезд, Кирпичный, Развилка, Церковь, Кладбище, Элеватор, Рынок, Вокзал, Парк, Стадион, Площадь
Магазины: Чижик, Пятёрочка (Пятак), Монетка, КБ (Красное и Белое), Магнит, Метрополис, Низкоцен, Доброцен, Светофор
Улицы: Ленина, Гоголя, Советская, Карла Маркса, Кирова, Мичурина, Пролетарская, Калинина, Октябрьская, Энергетиков, Белоносова, Коваленко, Куйбышева, Ломоносова, Пушкина

═══════════════════════════════════════
ПРАВИЛА КЛАССИФИКАЦИИ
═══════════════════════════════════════

1. УТВЕРЖДЕНИЯ (= пост) — обрабатывай:
   - Любое сообщение, где УТВЕРЖДАЕТСЯ что патруль стоит/работает/ловит где-то.
   - Сообщение может НЕ содержать слова "ДПС" — если есть место + действие/предупреждение, это пост.
   - Даже одно слово-место (например "кольцо", "ленина", "виадук") БЕЗ глагола — это пост ДПС, если это ответ или утверждение (не вопрос).
   - Предупреждения ("аккуратнее на Ленина") = ДПС.
   - Упоминание 3-х цифр (номера машины) рядом с местом = ДПС.

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
   - "на кольце" → "Кольцо", "у поста" → "Пост", "на мосту" → "Мост", "у чижика" → "Чижик", "у церкви" → "Церковь"

5. МНОЖЕСТВЕННЫЕ ТОЧКИ:
   - Если упоминается несколько мест — создай отдельный пост для каждого.
   - "На Ленина и кольце стоят" → два поста.

═══════════════════════════════════════
ПРИМЕРЫ (вход → выход)
═══════════════════════════════════════

"ДПС на Ленина" → { "posts": [{ "street": "Ленина", "type": "ДПС" }] }
"575 возле чижика раскатывают" → { "posts": [{ "street": "Чижик", "type": "ДПС" }] }
"Монетка на белоносова чисто" → { "posts": [{ "street": "Белоносова", "type": "Чисто" }] }
"Кб на Коваленко чисто" → { "posts": [{ "street": "Коваленко", "type": "Чисто" }] }
"544 кольцо" → { "posts": [{ "street": "Кольцо", "type": "ДПС" }] }
"аккуратнее виадук" → { "posts": [{ "street": "Виадук", "type": "ДПС" }] }
"менты у цэрэбэхи" → { "posts": [{ "street": "ЦРБ", "type": "ДПС" }] }
"виадук чисто" → { "posts": [{ "street": "Виадук", "type": "Чисто" }] }
"у чижика чисто" → { "posts": [{ "street": "Чижик", "type": "Чисто" }] }
"Где стоят?" → { "posts": [] }

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
const RETRY_BASE_DELAY_MS = 3000;

/** Ошибки, при которых пробуем следующую модель в цепочке */
function shouldFailOverToNextModel(status) {
  return (
    status === 429 ||
    status === 408 ||
    status === 425 ||
    status === 500 ||
    status === 502 ||
    status === 503
  );
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status === 425 || (status >= 500 && status <= 599);
}

/** @param {Response} res */
function retryAfterMsFromResponse(res) {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return null;
  const sec = Number.parseInt(raw, 10);
  if (!Number.isFinite(sec) || sec < 1) return null;
  return Math.min(sec * 1000, 600_000);
}

async function llmChatCompletion(model, text) {
  const body = {
    model,
    max_tokens: 512,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
  };
  if (config.openrouterJsonMode) {
    body.response_format = { type: "json_object" };
  }
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${config.openrouterKey}`,
    "Content-Type": "application/json",
  };
  if (config.openrouterHttpReferer) {
    headers["HTTP-Referer"] = config.openrouterHttpReferer;
  }
  headers["X-Title"] = config.openrouterAppTitle || "DPS Telegram bot";
  return fetch(config.openrouterChatUrl, {
    method: "POST",
    signal: AbortSignal.timeout(config.apiTimeoutMs),
    headers,
    body: JSON.stringify(body),
  });
}

async function parseLlmSuccessResponse(res, start) {
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
    const preview =
      cleaned.length <= 200 ? JSON.stringify(cleaned) : Logger.truncate(cleaned, 120);
    logger.error(`AI: failed to parse JSON — len=${cleaned.length} body=${preview}`);
    const e = new Error("OpenRouter: invalid JSON in model response");
    e.transient = true;
    throw e;
  }

  if (!Array.isArray(parsed.posts)) {
    logger.warn("AI: response had no posts array");
    const e = new Error("OpenRouter: response missing posts array");
    e.transient = true;
    throw e;
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

export function parseMessageWithAI(text) {
  return enqueue(() => _callLlm(text));
}

async function _callLlm(text) {
  const start = Date.now();
  const models = config.openrouterModelChain;
  const maxRounds = config.llmMaxRounds;
  let lastFailure = { status: 0, body: "" };

  roundLoop: for (let round = 1; round <= maxRounds; round++) {
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      const isLastInRound = mi === models.length - 1;
      logger.log(
        `OpenRouter: model=${model} round=${round}/${maxRounds} chars=${String(text || "").length}`
      );

      let res;
      try {
        res = await llmChatCompletion(model, text);
      } catch (netErr) {
        logger.warn(`OpenRouter: network error — ${netErr.message}`);
        if (round >= maxRounds) {
          const e = new Error(`OpenRouter network failure: ${netErr.message}`);
          e.transient = true;
          throw e;
        }
        await sleep(RETRY_BASE_DELAY_MS * round);
        continue roundLoop;
      }

      if (res.ok) {
        return await parseLlmSuccessResponse(res, start);
      }

      const retryAfterMs = retryAfterMsFromResponse(res);
      const errBody = await res.text();
      lastFailure = { status: res.status, body: errBody };
      logger.error(`OpenRouter: HTTP ${res.status} — ${Logger.truncate(errBody, 200)}`);

      if (shouldFailOverToNextModel(res.status)) {
        if (res.status === 429 && !isLastInRound) {
          const waitMs = retryAfterMs ?? config.llm429FailoverDelayMs;
          logger.warn(
            `OpenRouter: HTTP 429 on ${model} — waiting ${waitMs}ms before next model${retryAfterMs ? " (Retry-After)" : ""}`
          );
          await sleep(waitMs);
        } else if (res.status !== 429 && !isLastInRound) {
          const d = config.llmTransientFailoverDelayMs;
          logger.warn(`OpenRouter: HTTP ${res.status} on ${model} — waiting ${d}ms before next model`);
          await sleep(d);
        } else {
          logger.warn(
            `OpenRouter: failover after HTTP ${res.status} on ${model} → cooldown or next round`
          );
        }
        continue;
      }

      const err = new Error(`OpenRouter HTTP ${res.status}: ${errBody}`);
      err.transient = isTransientStatus(res.status);
      err.status = res.status;
      throw err;
    }

    if (round < maxRounds) {
      const delay = Math.min(
        config.llmRateLimitCooldownMs * round,
        config.llmRateLimitCooldownMaxMs
      );
      logger.warn(
        `OpenRouter: all ${models.length} model(s) exhausted (last HTTP ${lastFailure.status}), cooldown ${delay}ms`
      );
      await sleep(delay);
    }
  }

  const err = new Error(`OpenRouter HTTP ${lastFailure.status}: ${lastFailure.body}`);
  err.transient = isTransientStatus(lastFailure.status);
  err.status = lastFailure.status;
  throw err;
}
