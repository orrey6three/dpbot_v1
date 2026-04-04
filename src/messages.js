/**
 * @param {import("telegram").Api.Message} message
 */
export function adaptMtprotoMessage(message) {
  return {
    id: message.id,
    chatId: String(message.chatId ?? ""),
    chatUsername: "",
    text: message.message || "",
    date: message.date,
    replyToMessageId: message.replyTo?.replyToMsgId ?? null,
    async getChatUsername() {
      const chat = await message.getChat();
      return chat?.username || "";
    },
    async getReplyText() {
      const parent = await message.getReplyMessage();
      return parent?.message || null;
    },
    async getAuthor() {
      const sender = await message.getSender();
      if (!sender) return "Аноним";
      return sender.username || sender.firstName || "Аноним";
    },
  };
}

export function adaptBotApiMessage(message) {
  const text = message.text || message.caption || "";
  const from = message.from || {};
  const chat = message.chat || {};

  return {
    id: message.message_id,
    chatId: String(chat.id ?? ""),
    chatUsername: chat.username || "",
    text,
    date: message.date,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    async getChatUsername() {
      return chat.username || "";
    },
    async getReplyText() {
      return message.reply_to_message?.text || message.reply_to_message?.caption || null;
    },
    async getAuthor() {
      return from.username || [from.first_name, from.last_name].filter(Boolean).join(" ") || "Аноним";
    },
  };
}
