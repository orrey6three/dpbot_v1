import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import "dotenv/config";

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.STRING_SESSION || "");

if (!apiId || !apiHash || !process.env.STRING_SESSION) {
  console.error("❌ Заполни API_ID, API_HASH и STRING_SESSION в .env!");
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log("🚀 Подключаемся...");
  await client.connect();

  const dialogs = await client.getDialogs();
  
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
