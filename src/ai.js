import fetch from "node-fetch";
import { config } from "./config.js";

const SYSTEM_PROMPT = `Ты парсер сообщений из чата водителей города Шумиха (Россия).
Люди пишут про посты ДПС и патрули на улицах. Твоя задача — извлечь структурированные данные.

Правила определения типа:
- "ДПС" — если сообщение говорит что ДПС/гаишники/полиция/пост/экипаж СТОЯТ или ЕСТЬ на улице
- "Чисто" — если сообщение говорит что ДПС убрали/уехали/нет/чисто/свободно

В городе есть статичные посты. Если люди описывают одно из этих мест (даже сокращенно), в поле street укажи именно это каноничное название:
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

Для остальных адресов: переделывай названия зданий в название улицы, на которой они находятся в г. Шумиха Курганской области (например, "школа 3" -> "Ленина", "школа 4" -> "Гоголя", "ЦРБ" -> "Кирова"). Если не знаешь — пиши как есть.

Если на вход подается несколько предложений (цепочка ответов):
1. Ищи улицу в любой части текста.
2. Тип определяй по последнему смысловому утверждению.

Верни ТОЛЬКО валидный JSON без markdown-блоков:
{ "posts": [{ "street": "название улицы", "type": "ДПС" }] }

Если нерелевантно — верни: { "posts": [] }`;

/**
 * @param {string} text
 * @returns {Promise<Array<{ street: string, type: "ДПС" | "Чисто" }>>}
 */
export async function parseMessageWithAI(text) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${config.openrouterKey}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  "https://dpsposts.vercel.app",
      "X-Title":       "DPS Posts Bot",
    },
    body: JSON.stringify({
      model:       "google/gemini-2.0-flash-001",
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
    throw new Error(`OpenRouter HTTP ${res.status}: ${err}`);
  }

  const data    = await res.json();
  const raw     = data.choices?.[0]?.message?.content?.trim() || "";
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("[AI] Failed to parse JSON:", cleaned);
    return [];
  }

  if (!Array.isArray(parsed.posts)) return [];
  return parsed.posts.filter(
    (p) => p.street && ["ДПС", "Чисто"].includes(p.type)
  );
}
