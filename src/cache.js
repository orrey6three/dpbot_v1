/**
 * MessageCache — хранит текст и parentId для построения цепочек ответов.
 * ProcessedCache — дедупликация: не обрабатывать одно сообщение дважды.
 */

export class MessageCache {
  constructor(limit = 200) {
    this.limit = limit;
    /** @type {Map<string, { text: string, parentId: number|null }>} */
    this.cache = new Map();
    this.keys  = [];
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

  /**
   * Возвращает массив текстов от корня цепочки до startMsgId.
   */
  getChain(chatId, startMsgId) {
    let currentId = startMsgId;
    const chain   = [];
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

/**
 * ProcessedCache — хранит ID сообщений, которые уже были обработаны.
 * Предотвращает дублирование при перезапуске в рамках 2-часового окна.
 */
export class ProcessedCache {
  constructor() {
    /** @type {Set<string>} */
    this.ids = new Set();
  }

  has(chatId, msgId) {
    return this.ids.has(`${chatId}:${msgId}`);
  }

  add(chatId, msgId) {
    this.ids.add(`${chatId}:${msgId}`);
  }
}
