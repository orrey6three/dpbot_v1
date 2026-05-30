import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import "dotenv/config";

const suffix = (process.argv[2] || "").trim();
const suffixKey = suffix ? `_${suffix.replace(/^_+/, "")}` : "";

const apiId = parseInt(process.env[`API_ID${suffixKey}`] || process.env.API_ID);
const apiHash = process.env[`API_HASH${suffixKey}`] || process.env.API_HASH;
const sessionValue = process.env[`STRING_SESSION${suffixKey}`] || process.env.STRING_SESSION || "";
const stringSession = new StringSession(sessionValue);

if (!apiId || !apiHash || !sessionValue) {
  console.error(
    `❌ Заполни API_ID${suffixKey}, API_HASH${suffixKey} и STRING_SESSION${suffixKey} (или базовые API_ID/API_HASH/STRING_SESSION) в .env!`
  );
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log("🚀 Подключаемся...");
  await client.connect();

  const dialogs = await client.getDialogs({ limit: 200 });
  
  const envTargets = {
    CHAT_SHUMIKHA_ID: process.env.CHAT_SHUMIKHA_ID,
    CHAT_SHCHUCHYE_ID: process.env.CHAT_SHCHUCHYE_ID,
    CHAT_MISHKINO_ID: process.env.CHAT_MISHKINO_ID,
  };

  console.log("\n--- СПИСОК ГРУПП / КАНАЛОВ (для .env) ---");
  for (const dialog of dialogs) {
    if (!dialog.isGroup && !dialog.isChannel) continue;
    const title = dialog.title || "Без названия";
    const id = dialog.id.toString();
    const envHit = Object.entries(envTargets)
      .filter(([, v]) => v && id.replace(/^-100/, "") === String(v).replace(/^-100/, ""))
      .map(([k]) => k);
    const mark = envHit.length ? `  ← .env ${envHit.join(", ")}` : "";
    console.log(`${title} | ID: ${id}${mark}`);
  }
  console.log("---------------------------");
  console.log("Ожидаемые в .env:");
  for (const [key, val] of Object.entries(envTargets)) {
    console.log(`  ${key}=${val || "(не задан)"}`);
  }
  console.log(
    "\n✅ Скопируй ID в .env. Каждая STRING_SESSION должна быть участником всех целевых чатов, иначе будет CHANNEL_INVALID."
  );
  process.exit(0);
})();
