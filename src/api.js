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
  const requestBody = {
    token: config.botToken,
    ...payload,
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
    logger.error(`Failed to create post: ${errorMsg}${errorDetails} | Payload: ${JSON.stringify(payload)}`);
    throw new Error(`${errorMsg}${errorDetails}`);
  }

  logger.debug(`Post created successfully in ${duration}ms (id=${data.post?.id})`);
  return data;
}

/**
 * Удаляет или скрывает пост на бэкенде.
 * @param {string} postId
 * @returns {Promise<boolean>}
 */
export async function deletePost(postId) {
  if (!postId) return false;
  const start = Date.now();
  try {
    const res = await fetchWithRetry(
      `${config.apiUrl}?id=${postId}&token=${config.botToken}`,
      {
        method:  "DELETE",
        headers: {
          "x-bot-token": config.botToken,
        },
      },
      { retries: 2, backoffMs: 300 }
    );

    const duration = Date.now() - start;
    if (!res.ok) {
      const text = await res.text();
      logger.warn(`Failed to delete post ${postId}: HTTP ${res.status} — ${text}`);
      return false;
    }

    logger.debug(`Post ${postId} deleted successfully in ${duration}ms`);
    return true;
  } catch (err) {
    logger.error(`Error deleting post ${postId}: ${err.message}`);
    return false;
  }
}
