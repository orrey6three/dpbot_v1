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
      const res = await fetch(url, { ...options, timeout: config.apiTimeoutMs });
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
 * Отправляет новый пост на бэкенд.
 * @param {PostPayload} payload
 * @returns {Promise<object>} ответ сервера
 */
export async function createPost(payload) {
  const start = Date.now();
  const res = await fetchWithRetry(
    config.apiUrl,
    {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-token":  config.botToken,
      },
      body: JSON.stringify({
        token: config.botToken,
        ...payload,
      }),
    },
    { retries: 3, backoffMs: 500 }
  );

  const data = await res.json();
  const duration = Date.now() - start;

  if (!res.ok) {
    logger.error(`Failed to create post: ${data.error || `HTTP ${res.status}`}`);
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  logger.debug(`Post created successfully in ${duration}ms (id=${data.post?.id})`);
  return data;
}
