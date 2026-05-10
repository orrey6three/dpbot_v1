import "dotenv/config";

function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    console.error(`❌ Отсутствует обязательная переменная окружения: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : fallback;
}

function optionalNumber(name, fallback) {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalBoolean(name, fallback = false) {
  const raw = optionalEnv(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function trimSlashes(value) {
  return value.replace(/\/+$/, "");
}

function ensureLeadingSlash(value) {
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

export function normalizeChatId(value) {
  return String(value || "").trim().replace(/^-100/, "");
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getGroqModelChain() {
  const defaultPrimary = "llama-3.3-70b-versatile";
  const csv = optionalEnv("GROQ_MODELS");
  if (csv) {
    const ids = [...new Set(splitCsv(csv))];
    return ids.length ? ids : [defaultPrimary];
  }
  const primary = optionalEnv("GROQ_MODEL", defaultPrimary);
  const fallbacks = splitCsv(optionalEnv("GROQ_MODEL_FALLBACKS", "llama-3.1-8b-instant"));
  const chain = [...new Set([primary, ...fallbacks].filter(Boolean))];
  return chain.length ? chain : [defaultPrimary];
}

function getTargetChats() {
  const namedChats = [
    { city: "Шумиха", id: optionalEnv("CHAT_SHUMIKHA_ID") },
    { city: "Щучье", id: optionalEnv("CHAT_SHCHUCHYE_ID") },
    { city: "Мишкино", id: optionalEnv("CHAT_MISHKINO_ID") },
  ].filter((item) => item.id);

  const fallbackChatIds = splitCsv(optionalEnv("CHAT_ID", "-1002027583613"));
  const fallbackCities = splitCsv(optionalEnv("CITY_NAME", optionalEnv("DEFAULT_CITY", "Шумиха")));

  const uniqueTargetChatIds = [...new Set(namedChats.length ? 
    namedChats.map((item) => String(item.id).trim()) : 
    fallbackChatIds.map((id) => String(id).trim())
  )];

  const targetChatIds = uniqueTargetChatIds;
  const chatCityMap = {};
  
  if (namedChats.length) {
    namedChats.forEach((item) => {
      const rawId = String(item.id).trim();
      const normalizedId = normalizeChatId(item.id);
      chatCityMap[rawId] = item.city;
      chatCityMap[normalizedId] = item.city;
    });
  } else {
    targetChatIds.forEach((id, idx) => {
      const city = fallbackCities[idx] || fallbackCities[0] || "Шумиха";
      chatCityMap[id] = city;
      chatCityMap[normalizeChatId(id)] = city;
    });
  }

  return { targetChatIds, chatCityMap };
}

function getSessions() {
  const sessions = [];
  const keys = Object.keys(process.env).filter((key) => key.startsWith("STRING_SESSION"));

  keys.sort((a, b) => {
    if (a === "STRING_SESSION") return -1;
    if (b === "STRING_SESSION") return 1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    const stringSession = optionalEnv(key);
    if (!stringSession) continue;

    const suffix = key.replace("STRING_SESSION", "");
    const enabledKey = suffix ? `SESSION_ENABLED${suffix}` : "SESSION_ENABLED";
    const enabled = optionalBoolean(enabledKey, true);
    if (!enabled) continue;

    const apiIdKey = suffix ? `API_ID${suffix}` : "API_ID";
    const apiHashKey = suffix ? `API_HASH${suffix}` : "API_HASH";
    const apiId = optionalNumber(apiIdKey, optionalNumber("API_ID", NaN));
    const apiHash = optionalEnv(apiHashKey, optionalEnv("API_HASH"));

    sessions.push({
      name: key,
      stringSession,
      apiId,
      apiHash,
    });
  }

  return sessions;
}

const telegramBotToken = optionalEnv("TELEGRAM_BOT_TOKEN", optionalEnv("TG_TOKEN"));
const webhookPublicUrl = trimSlashes(optionalEnv("WEBHOOK_PUBLIC_URL", optionalEnv("APP_URL")));
const requestedMode = optionalEnv("TELEGRAM_MODE").toLowerCase();
const mode = requestedMode || (telegramBotToken && webhookPublicUrl ? "webhook" : "mtproto");

const port = optionalNumber("PORT", optionalNumber("WEBHOOK_PORT", 3000));
const healthPath = ensureLeadingSlash(optionalEnv("HEALTH_PATH", "/health"));
const statusPath = ensureLeadingSlash(optionalEnv("STATUS_PATH", "/status"));
const webhookPath = ensureLeadingSlash(optionalEnv("WEBHOOK_PATH", "/telegram/webhook"));
const webhookSecretToken = optionalEnv("WEBHOOK_SECRET_TOKEN", optionalEnv("BOT_TOKEN"));
const targetChats = getTargetChats();

const sessions = getSessions();

const groqModelChain = getGroqModelChain();

export const config = {
  mode,
  sessions,

  apiId: optionalNumber("API_ID", NaN),
  apiHash: optionalEnv("API_HASH"),
  stringSession: optionalEnv("STRING_SESSION"),

  telegramBotToken,
  webhookPublicUrl,
  webhookPath,
  webhookSecretToken,
  webhookAllowedUpdates: ["message", "channel_post"],
  webhookDropPendingUpdates: optionalBoolean("WEBHOOK_DROP_PENDING_UPDATES", false),
  webhookSetOnStart: optionalBoolean("WEBHOOK_SET_ON_START", true),
  webhookMonitorEnabled: optionalBoolean("WEBHOOK_MONITOR_ENABLED", true),
  webhookMonitorIntervalMs: optionalNumber("WEBHOOK_MONITOR_INTERVAL_MS", 5 * 60 * 1000),
  webhookMaxBodyBytes: optionalNumber("WEBHOOK_MAX_BODY_BYTES", 512 * 1024),

  httpPort: port,
  healthPath,
  statusPath,

  chatId: optionalEnv("CHAT_ID", "-1002027583613"),
  targetChatIds: targetChats.targetChatIds,
  chatCityMap: targetChats.chatCityMap,

  apiUrl: optionalEnv("API_URL", "http://localhost:3000/api/patrol"),
  botToken: optionalEnv("BOT_TOKEN", "change-me-bot-secret"),

  groqKey: requiredEnv("GROQ_API_KEY"),
  groqModel: groqModelChain[0] ?? "llama-3.3-70b-versatile",
  groqModelChain,
  groqJsonMode: optionalBoolean("GROQ_JSON_MODE", true),
  groqMaxRounds: optionalNumber("GROQ_MAX_ROUNDS", 5),
  groq429FailoverDelayMs: optionalNumber("GROQ_429_FAILOVER_DELAY_MS", 15000),
  groqTransientFailoverDelayMs: optionalNumber("GROQ_TRANSIENT_FAILOVER_DELAY_MS", 5000),
  groqRateLimitCooldownMs: optionalNumber("GROQ_RATE_LIMIT_COOLDOWN_MS", 30000),
  groqRateLimitCooldownMaxMs: optionalNumber("GROQ_RATE_LIMIT_COOLDOWN_MAX_MS", 180000),
  yandexKey: requiredEnv("YANDEX_MAPS_API_KEY"),

  defaultCity: optionalEnv("DEFAULT_CITY", "Шумиха"),

  maxMsgAgeSeconds: optionalNumber("MAX_MSG_AGE_SECONDS", 2 * 60 * 60),
  historyLimit: optionalNumber("HISTORY_LIMIT", 100),
  historyBatchSize: optionalNumber("HISTORY_BATCH_SIZE", 5),

  connectionGraceMs: optionalNumber("CONNECTION_GRACE_MS", 15000),
  connectionProbeIntervalMs: optionalNumber("CONNECTION_PROBE_INTERVAL_MS", 60000),
  connectionProbeTimeoutMs: optionalNumber("CONNECTION_PROBE_TIMEOUT_MS", 10000),
  reconnectDelayMs: optionalNumber("RECONNECT_DELAY_MS", 10000),

  processedCacheLimit: optionalNumber("PROCESSED_CACHE_LIMIT", 5000),
  processedCacheTtlMs: optionalNumber("PROCESSED_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000),
  stateFilePath: optionalEnv("STATE_FILE_PATH", ".runtime/bot-state.json"),
  apiTimeoutMs: optionalNumber("API_TIMEOUT_MS", 30000),
  messageProcessTimeoutMs: optionalNumber("MESSAGE_PROCESS_TIMEOUT_MS", 120000),
  messageIntervalMs: optionalNumber("MESSAGE_INTERVAL_MS", 3000),
};

export function getWebhookUrl() {
  if (!config.webhookPublicUrl) return "";
  return new URL(config.webhookPath, `${config.webhookPublicUrl}/`).toString();
}
