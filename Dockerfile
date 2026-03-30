FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy bot code
COPY bot.js ./

# Set environment variables (should be provided at runtime)
# ENV TG_TOKEN=...
# ENV BOT_TOKEN=...
# ENV API_URL=...
# ENV CHAT_ID=...
# ENV OPENROUTER_API_KEY=...
# ENV YANDEX_MAPS_API_KEY=...

CMD ["node", "bot.js"]
