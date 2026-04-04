# DPS45 Telegram Bot

Бот слушает сообщения в Telegram и создает метки на карте DPS45.

## Что теперь умеет рантайм

- `mtproto` режим для текущей схемы со `STRING_SESSION`: бот держит watchdog, отслеживает потерю соединения, сам переподнимается и отдает `/health`.
- `webhook` режим для обычного Bot API: если есть `TELEGRAM_BOT_TOKEN` или `TG_TOKEN` и публичный `WEBHOOK_PUBLIC_URL`, бот сам зарегистрирует webhook и будет принимать апдейты по HTTP.
- В обоих режимах есть HTTP сервер со статусом:
  - `GET /health`
  - `GET /status`
- У обработанных сообщений теперь есть постоянный кэш на диске, чтобы после рестарта не гонять одни и те же сообщения повторно.

Режим выбирается автоматически:

- если заданы `TELEGRAM_BOT_TOKEN` или `TG_TOKEN` и `WEBHOOK_PUBLIC_URL` -> `webhook`
- иначе -> `mtproto`

При необходимости режим можно принудительно задать переменной `TELEGRAM_MODE`.

## Деплой

Контейнер поднимает HTTP сервер на порту `PORT` (по умолчанию `3001`).

В Docker добавлены:

- `EXPOSE 3001`
- `HEALTHCHECK` на `/health`

В `docker-compose.yml` добавлен проброс порта:

```yaml
ports:
  - "${PORT:-3001}:${PORT:-3001}"
```

И volume для постоянного state-файла:

```yaml
volumes:
  - bot_runtime:/app/.runtime
```

## Переменные окружения

Обязательные для обработки сообщений:

- `OPENROUTER_API_KEY`
- `YANDEX_MAPS_API_KEY`
- `API_URL`
- `BOT_TOKEN`
- `CHAT_ID`

### MTProto режим

Нужны:

- `API_ID`
- `API_HASH`
- `STRING_SESSION`

Дополнительно можно указать несколько сессий:

- `STRING_SESSION`
- `STRING_SESSION_2`
- `API_ID_2`
- `API_HASH_2`

### Webhook режим

Нужны:

- `TELEGRAM_BOT_TOKEN` или `TG_TOKEN`
- `WEBHOOK_PUBLIC_URL`

Необязательные:

- `WEBHOOK_PATH` по умолчанию `/telegram/webhook`
- `WEBHOOK_SECRET_TOKEN` по умолчанию берется из `BOT_TOKEN`
- `WEBHOOK_DROP_PENDING_UPDATES=false`
- `PORT=3001`

## Постоянный кэш обработанных сообщений

По умолчанию бот хранит обработанные message id в файле:

```text
.runtime/bot-state.json
```

Это нужно, чтобы после рестарта уже обработанные сообщения не проходили повторно.

Если ты запускаешь через `docker compose`, этот файл переживает пересоздание контейнера за счет volume `bot_runtime`.

При необходимости путь можно поменять переменной:

```env
STATE_FILE_PATH=.runtime/bot-state.json
```

Пример:

```env
TELEGRAM_MODE=webhook
TG_TOKEN=123456:telegram-bot-token
WEBHOOK_PUBLIC_URL=https://bot.example.com
PORT=3001
```

Webhook будет зарегистрирован на:

```text
https://bot.example.com/telegram/webhook
```

## Важно для webhook режима

- У сервера должен быть публичный HTTPS URL.
- Бот должен быть добавлен в нужный чат.
- Если это группа, у бота должен быть доступ к сообщениям.
  Обычно для этого отключают privacy mode через BotFather или выдают нужные права.

## Локальный запуск

```bash
npm install
npm start
```

## Полезные эндпоинты

- `/health` -> 200 когда транспорт жив, 503 если соединение потеряно
- `/status` -> подробный JSON по текущему состоянию рантайма
