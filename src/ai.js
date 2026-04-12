import fetch from "node-fetch";
import { config } from "./config.js";
import { Logger } from "./logger.js";

const logger = new Logger("AI");

const OPENROUTER_MODEL = "google/gemini-2.0-flash-001";

const SYSTEM_PROMPT = `Ты парсер сообщений из чата водителей. Твоя задача — извлечь данные о постах ДПС.

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Игнорируй ВОПРОСЫ (например: "Где стоят?", "Как на виадуке?", "Чисто нет?", "Кольцо что?"). Если в сообщении есть вопрос о наличии ДПС — это НЕ пост.
2. Обрабатывай только УТВЕРЖДЕНИЯ (например: "ДПС на кольце", "Виадук чисто", "Работают на Гоголя").
3. "ДПС" — только если стоят сейчас.
4. "Чисто" — только если подтверждают отсутствие.

Дополнительные места г. Шумиха:
- Виадук, Автозапад, Отдел, Мир Света, Кольцо, ХПП, ЦРБ.

Верни ТОЛЬКО валидный JSON:
{ "posts": [{ "street": "название", "type": "ДПС" | "Чисто" }] }

Если сообщение — вопрос, шутка или не содержит данных о патруле — верни: { "posts": [] }`;

/**
 * @param {string} text
 * @returns {Promise<Array<{ street: string, type: "ДПС" | "Чисто" }>>}
 */
export async function parseMessageWithAI(text) {
  const start = Date.now();
  logger.log(
    `OpenRouter: request start model=${OPENROUTER_MODEL} chars=${String(text || "").length}`
  );

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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

  if (!res.ok) {
    const err = await res.text();
    logger.error(`OpenRouter: HTTP ${res.status} — ${Logger.truncate(err, 200)}`);
    throw new Error(`OpenRouter HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  const elapsed = Date.now() - start;
  logger.log(
    `OpenRouter: response OK in ${elapsed}ms, rawChars=${raw.length}`
  );
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
