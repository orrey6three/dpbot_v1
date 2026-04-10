import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import "dotenv/config";
import qrcode from "qrcode-terminal";

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

if (!apiId || !apiHash) {
  console.error("❌ API_ID и API_HASH должны быть в .env файле!");
  process.exit(1);
}

(async () => {
  console.log("\n🚀 Выберите способ входа:");
  console.log("1. По номеру телефона (SMS, Telegram или Email)");
  console.log("2. Через QR-код (без номера)");
  console.log("3. Через Bot Token (@BotFather)");

  const choice = await input.text("Введите номер варианта (1-3): ");

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  if (choice === "1") {
    // Вход по номеру
    await client.start({
      phoneNumber: async () => await input.text("Введите номер телефона: "),
      password: async () =>
        await input.text("Введите пароль (если включен 2FA): "),
      phoneCode: async () =>
        await input.text("Введите код (из Telegram, SMS или Почты): "),
      onError: (err) => console.error("❌ Ошибка:", err.message),
    });
  } else if (choice === "2") {
    // Вход через QR-код
    console.log("\n⏳ Подключение и генерация QR-кода...");
    try {
      await client.connect();
      await client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          onError: (err) => console.error("❌ Ошибка QR:", err.message),
          qrCode: async (code) => {
            const token = code.token.toString("base64url");
            const url = `tg://login?token=${token}`;
            console.log(
              "\n📷 Отсканируйте этот QR-код в мобильном приложении Telegram:",
            );
            console.log("(Настройки -> Устройства -> Подключить устройство)\n");
            qrcode.generate(url, { small: true });
          },
        },
      );
    } catch (err) {
      console.error("❌ Не удалось войти по QR:", err.message);
      process.exit(1);
    }
  } else if (choice === "3") {
    const botToken = await input.text("Введите Bot Token: ");
    await client.start({
      botAuthToken: botToken,
      onError: (err) => console.error("❌ Ошибка бота:", err.message),
    });
  } else {
    console.log("❌ Неверный выбор.");
    process.exit(1);
  }
  //wddd
  console.log("\n✅ Вы успешно вошли!");
  console.log("------------------------------------------");
  console.log("ТВОЯ СЕССИЯ (скопируй её в .env как STRING_SESSION):");
  console.log(client.session.save());
  console.log("------------------------------------------");
  process.exit(0);
})();
