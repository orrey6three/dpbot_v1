import fetch from "node-fetch";
import { config } from "./config.js";

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
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        const delay = backoffMs * 2 ** attempt;
        console.warn(`[API] Retry ${attempt + 1}/${retries - 1} after ${delay}ms...`);
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
