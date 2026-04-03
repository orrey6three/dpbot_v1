import "dotenv/config";

function require_env(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Отсутствует обязательная переменная окружения: ${name}`);
    process.exit(1);
  }
  return val.trim();
}

/**
 * Ищет все переменные STRING_SESSION* и формирует массив сессий.
 */
function getSessions() {
  const sessions = [];
  const keys = Object.keys(process.env).filter((k) => k.startsWith("STRING_SESSION"));

  // Сортируем: сначала основной STRING_SESSION, потом остальные
  keys.sort((a, b) => {
    if (a === "STRING_SESSION") return -1;
    if (b === "STRING_SESSION") return 1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    const sessionStr = process.env[key].trim();
    if (!sessionStr) continue;

    // Пытаемся найти специфичные API_ID / API_HASH для этой сессии (например STRING_SESSION_2 -> API_ID_2)
    // Если их нет — берем глобальные
    const suffix = key.replace("STRING_SESSION", "");
    const apiIdKey = suffix ? `API_ID${suffix}` : "API_ID";
    const apiHashKey = suffix ? `API_HASH${suffix}` : "API_HASH";

    sessions.push({
      name: key,
      stringSession: sessionStr,
      apiId: parseInt(process.env[apiIdKey] || process.env.API_ID, 10),
      apiHash: process.env[apiHashKey] || process.env.API_HASH,
    });
  }

  return sessions;
}

const sessions = getSessions();

export const config = {
  // Список всех доступных аккаунтов
  sessions,

  // Telegram MTProto (по умолчанию для основного клиента)
  apiId:         parseInt(process.env.API_ID, 10),
  apiHash:       require_env("API_HASH"),
  stringSession: (process.env.STRING_SESSION || "").trim(),

  // Целевой чат (ID берём из list_chats.js)
  chatId:        (process.env.CHAT_ID || "-1002027583613").trim(),

  // Бэкенд API
  apiUrl:        (process.env.API_URL || "http://localhost:3000/api/patrol").trim(),
  botToken:      (process.env.BOT_TOKEN || "change-me-bot-secret").trim(),

  // Внешние сервисы
  openrouterKey: require_env("OPENROUTER_API_KEY"),
  yandexKey:     require_env("YANDEX_MAPS_API_KEY"),

  // Домен по умолчанию
  defaultCity:   process.env.DEFAULT_CITY || "Шумиха",

  // Ограничения
  maxMsgAgeSeconds: 2 * 60 * 60, // 2 часа
  historyLimit:     100,
  historyBatchSize: 5,            // параллельно обрабатываем по 5 сообщений из истории
};
