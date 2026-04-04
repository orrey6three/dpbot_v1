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

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "bot.js"]
