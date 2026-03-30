import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import "dotenv/config";

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

if (!apiId || !apiHash) {
  console.error("❌ API_ID и API_HASH должны быть в .env файле!");
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Введите номер телефона: "),
    password: async () => await input.text("Введите пароль (если есть): "),
    phoneCode: async () => await input.text("Введите код из Telegram: "),
    onError: (err) => console.log(err),
  });

  console.log("\n✅ Вы успешно вошли!");
  console.log("-------------------------------------------");
  console.log("ТВОЯ СЕССИЯ (скопируй её в .env как STRING_SESSION):");
  console.log(client.session.save());
  console.log("-------------------------------------------");
  process.exit(0);
})();
