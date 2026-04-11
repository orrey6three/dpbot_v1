import fs from "node:fs";
import path from "node:path";

/**
 * MessageCache — хранит текст и parentId для построения цепочек ответов.
 * ProcessedCache — дедупликация: не обрабатывать одно сообщение дважды.
 * MarkerCache — хранит ID последних созданных постов для их обновления/удаления.
 */

function resolveStoragePath(storagePath) {
  if (!storagePath) return "";
  if (path.isAbsolute(storagePath)) return storagePath;
  return path.resolve(process.cwd(), storagePath);
}

function ensureParentDir(filePath) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class MessageCache {
  constructor(limit = 200) {
    this.limit = limit;
    /** @type {Map<string, { text: string, parentId: number|null }>} */
    this.cache = new Map();
    this.keys = [];
  }

  set(chatId, msgId, text, parentId) {
    const key = `${chatId}:${msgId}`;
    if (this.cache.has(key)) return;
    this.cache.set(key, { text, parentId });
    this.keys.push(key);
    if (this.keys.length > this.limit) {
      this.cache.delete(this.keys.shift());
    }
  }

  getChain(chatId, startMsgId) {
    let currentId = startMsgId;
    const chain = [];
    const visited = new Set();
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

export class ProcessedCache {
  constructor(limit = 5000, ttlMs = 7 * 24 * 3600 * 1000, storagePath = "") {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.storagePath = resolveStoragePath(storagePath);
    /** @type {Map<string, number>} */
    this.ids = new Map();
    this.writeCount = 0;

    this.load();
    this.cleanup();
  }

  has(chatId, msgId) {
    const key = `${chatId}:${msgId}`;
    const expiresAt = this.ids.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.ids.delete(key);
      return false;
    }
    return true;
  }

  add(chatId, msgId) {
    const key = `${chatId}:${msgId}`;
    this.ids.set(key, Date.now() + this.ttlMs);
    this.writeCount += 1;

    if (this.writeCount % 50 === 0 || this.ids.size > this.limit) {
      this.cleanup();
    }

    this.persist();
  }

  cleanup(now = Date.now()) {
    for (const [key, expiresAt] of this.ids) {
      if (expiresAt <= now) {
        this.ids.delete(key);
      }
    }

    while (this.ids.size > this.limit) {
      const oldestKey = this.ids.keys().next().value;
      if (!oldestKey) break;
      this.ids.delete(oldestKey);
    }
  }

  load() {
    if (!this.storagePath) return;

    try {
      if (!fs.existsSync(this.storagePath)) return;
      const raw = fs.readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.ids) ? parsed.ids : [];

      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [key, expiresAt] = entry;
        if (typeof key !== "string" || !Number.isFinite(expiresAt)) continue;
        this.ids.set(key, expiresAt);
      }
      
      if (this.ids.size > 0) {
        console.log(`[STATE] ProcessedCache: загружено ${this.ids.size} элементов из ${path.basename(this.storagePath)}`);
      }
    } catch (err) {
      console.error("[STATE] Ошибка загрузки ProcessedCache:", err.message);
    }
  }

  persist() {
    if (!this.storagePath) return;

    try {
      ensureParentDir(this.storagePath);
      const payload = JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          ids: [...this.ids.entries()],
        },
        null,
        2
      );
      const tempPath = `${this.storagePath}.tmp`;
      fs.writeFileSync(tempPath, payload, "utf8");
      fs.renameSync(tempPath, this.storagePath);
    } catch (err) {
      console.error("[STATE] Ошибка сохранения ProcessedCache:", err.message);
    }
  }
}

