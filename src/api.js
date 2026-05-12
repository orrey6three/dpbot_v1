import fetch from "node-fetch";
import { config } from "./config.js";
import { Logger } from "./logger.js";

const logger = new Logger("BackendAPI");

/**
 * HTTP-запрос с автоматическим retry и exponential backoff.
 * @param {string} url
 * @param {object} options - fetch options
 * @param {{ retries?: number, backoffMs?: number }} retryOptions
 */
async function fetchWithRetry(url, options, { retries = 3, backoffMs = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const signal = options.signal ?? AbortSignal.timeout(config.apiTimeoutMs);
      const res = await fetch(url, { ...options, signal });
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        const delay = backoffMs * 2 ** attempt;
        logger.warn(`Retry ${attempt + 1}/${retries - 1} after ${delay}ms... (Error: ${err.message})`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/**
 * @typedef {{ street: string, city: string, type: string, comment: string, coords: [number, number] | null, author: string }} PostPayload
 */

/**
 * Бэкенд ждёт одну пару `[lat, lon]`. Схлопываем случайное `[[lat, lon]]` с геокодера/старого кода.
 * @param {unknown} coords
 * @returns {[number, number] | null | undefined}
 */
function flatCoords(coords) {
  if (coords == null) return coords;
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const a = coords[0];
  const b = coords[1];
  if (typeof a === "number" && typeof b === "number") return [a, b];
  if (Array.isArray(a) && a.length >= 2 && typeof a[0] === "number" && typeof a[1] === "number") {
    return [a[0], a[1]];
  }
  return coords;
}

/**
 * Отправляет новый пост на бэкенд.
 * @param {PostPayload} payload
 * @returns {Promise<object>} ответ сервера
 */
export async function createPost(payload) {
  const start = Date.now();
  const requestBody = {
    token: config.botToken,
    ...payload,
    coords: flatCoords(payload.coords),
  };

  const res = await fetchWithRetry(
    config.apiUrl,
    {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-token":  config.botToken,
      },
      body: JSON.stringify(requestBody),
    },
    { retries: 3, backoffMs: 500 }
  );

  let data;
  const rawText = await res.text();
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    data = { error: rawText };
  }

  const duration = Date.now() - start;

  if (!res.ok) {
    const errorMsg = data.error || data.message || rawText || `HTTP ${res.status}`;
    const errorDetails = data.details ? ` (${data.details})` : "";
    logger.debug(`createPost rejected | street=${payload.street} | ${JSON.stringify(requestBody)}`);
    throw new Error(`${errorMsg}${errorDetails}`);
  }

  logger.debug(`Post created successfully in ${duration}ms (id=${data.post?.id})`);
  return data;
}
