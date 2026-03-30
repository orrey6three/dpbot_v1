import "dotenv/config";

function require_env(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Отсутствует обязательная переменная окружения: ${name}`);
    process.exit(1);
  }
  return val.trim();
}

const API_ID_RAW = parseInt(process.env.API_ID, 10);
if (!process.env.API_ID || isNaN(API_ID_RAW)) {
  console.error("❌ API_ID должен быть числом и задан в .env");
  process.exit(1);
}

export const config = {
  // Telegram MTProto
  apiId:         API_ID_RAW,
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
