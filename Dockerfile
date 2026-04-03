FROM node:18-slim

# Устанавливаем часовой пояс (полезно для логов бота)
ENV TZ=Europe/Moscow

WORKDIR /app

# Сначала копируем только файлы зависимостей (для кэширования слоев)
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --production

# Копируем ВЕСЬ остальной код проекта
COPY . .

# Если бот запускается командой node bot.js
CMD ["node", "bot.js"]