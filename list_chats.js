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
  
  console.log("\n--- СПИСОК ТВОИХ ЧАТОВ ---");
  for (const dialog of dialogs) {
    const title = dialog.title || "Без названия";
    const id = dialog.id.toString();
    console.log(`${title} | ID: ${id}`);
  }
  console.log("---------------------------\n");
  
  console.log("✅ Готово! Найди нужный чат в списке, скопируй его ID в .env и заново запусти npm start.");
  process.exit(0);
})();
