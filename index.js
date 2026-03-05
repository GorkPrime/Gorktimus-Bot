const TelegramBot = require("node-telegram-bot-api");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

console.log("✅ Booting bot...");
console.log("✅ Token length:", token.length);

const bot = new TelegramBot(token, { polling: true });

bot.on("polling_error", (err) => {
  console.error("❌ polling_error:", err?.message || err);
});

bot.on("webhook_error", (err) => {
  console.error("❌ webhook_error:", err?.message || err);
});

bot.on("message", async (msg) => {
  console.log("📩 MESSAGE:", {
    from: msg.from?.username,
    chatId: msg.chat?.id,
    text: msg.text,
  });

  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "✅ Gorktimus is receiving messages.");
});

bot.onText(/\/start/, async (msg) => {
  console.log("🟢 /start hit");
  await bot.sendMessage(msg.chat.id, "🛡️ Gorktimus Prime ONLINE.");
});

console.log("✅ Bot launched, waiting for messages...");
