const db = require("./database");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
  process.exit(1);
}

const bot = new Telegraf(token);

const STORAGE_PATH = path.join(__dirname, "storage.json");
const POLL_MS = 30 * 1000;

// ---------------- Storage ----------------
function loadStorage() {
  try {
    const raw = fs.readFileSync(STORAGE_PATH, "utf8");
    const data = JSON.parse(raw);
    data.priceAlerts = Array.isArray(data.priceAlerts) ? data.priceAlerts : [];
    return data;
  } catch {
    return { priceAlerts: [] };
  }
}

function saveStorage(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
}

// ---------------- Utility ----------------
async function deleteCommand(ctx) {
  try {
    if (ctx.chat.type !== "private") {
      await ctx.deleteMessage();
    }
  } catch {}
}

function formatUSD(n) {
  if (!n) return "N/A";
  const num = Number(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

// ---------------- Dex ----------------
async function fetchDex(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url);
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

function riskPercent(pair) {
  let safety = 100;
  const liq = Number(pair?.liquidity?.usd ?? 0);
  const vol24 = Number(pair?.volume?.h24 ?? 0);
  const change5m = Number(pair?.priceChange?.m5 ?? 0);

  if (liq < 20000) safety -= 30;
  else if (liq < 50000) safety -= 15;
  if (vol24 < 10000) safety -= 20;
  if (Math.abs(change5m) > 30) safety -= 10;

  safety = Math.max(0, Math.min(100, safety));
  return Math.max(0, Math.min(100, 100 - safety));
}

// ---------------- CoinGecko ----------------
const CG_IDS = {
  SOL: "solana",
  BTC: "bitcoin",
  ETH: "ethereum",
  XRP: "ripple"
};

async function fetchCoinGeckoUSD(symbol) {
  const id = CG_IDS[String(symbol).toUpperCase()];
  if (!id) return null;

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const { data } = await axios.get(url);
  return data?.[id]?.usd ?? null;
}

// ---------------- Commands ----------------
bot.start(async (ctx) => {
  await ctx.reply(
    "✅ PRIME BOT v3 (Clean Mode)\n\n" +
    "/scan <token>\n" +
    "/score <token>\n" +
    "/alert <SYMBOL> <PRICE>\n" +
    "/alerts\n" +
    "/delalert <ID>"
  );
  await deleteCommand(ctx);
});

bot.command("scan", async (ctx) => {
  const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!q) return ctx.reply("Usage: /scan <token>");

  const pairs = await fetchDex(q);
  if (!pairs.length) return ctx.reply("No results.");

  const p = pairs[0];
  const risk = riskPercent(p);

  await ctx.reply(
    `🔎 ${p.baseToken?.symbol ?? "?"}\n` +
    `Risk: ${risk}%\n` +
    `Liquidity: ${formatUSD(p.liquidity?.usd)}\n` +
    `Vol24: ${formatUSD(p.volume?.h24)}`
  );

  await deleteCommand(ctx);
});

bot.command("score", async (ctx) => {
  const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!q) return ctx.reply("Usage: /score <token>");

  const pairs = await fetchDex(q);
  if (!pairs.length) return ctx.reply("No results.");

  const p = pairs[0];
  const risk = riskPercent(p);

  await ctx.reply(`🧠 Risk: ${risk}%`);
  await deleteCommand(ctx);
});

bot.command("alert", async (ctx) => {
  const parts = ctx.message.text.split(" ").filter(Boolean);
  if (parts.length < 3) return ctx.reply("Usage: /alert SOL 85");

  const symbol = parts[1].toUpperCase();
  const target = Number(parts[2]);

  if (!CG_IDS[symbol]) return ctx.reply("Supported: SOL BTC ETH XRP");
  if (!Number.isFinite(target)) return ctx.reply("Invalid price.");

  const data = loadStorage();
  const id = Date.now().toString();

  data.priceAlerts.push({
    id,
    chatId: ctx.chat.id,
    symbol,
    target
  });

  saveStorage(data);

  await ctx.reply(`🎯 Alert set for ${symbol} @ $${target}\nID: ${id}`);
  await deleteCommand(ctx);
});

bot.command("alerts", async (ctx) => {
  const data = loadStorage();
  const mine = data.priceAlerts.filter(a => a.chatId === ctx.chat.id);

  if (!mine.length) {
    await ctx.reply("No alerts.");
  } else {
    await ctx.reply(
      mine.map(a => `#${a.id} ${a.symbol} >= $${a.target}`).join("\n")
    );
  }

  await deleteCommand(ctx);
});

bot.command("delalert", async (ctx) => {
  const parts = ctx.message.text.split(" ").filter(Boolean);
  if (parts.length < 2) return ctx.reply("Usage: /delalert <ID>");

  const id = parts[1];
  const data = loadStorage();

  data.priceAlerts = data.priceAlerts.filter(a => a.id !== id);
  saveStorage(data);

  await ctx.reply(`🗑 Removed alert ${id}`);
  await deleteCommand(ctx);
});

// ---------------- Alert Loop ----------------
async function runPriceAlerts() {
  const data = loadStorage();
  if (!data.priceAlerts.length) return;

  for (const alert of data.priceAlerts) {
    const current = await fetchCoinGeckoUSD(alert.symbol);
    if (!current) continue;

    if (current >= alert.target) {
      await bot.telegram.sendMessage(
        alert.chatId,
        `🚨 ${alert.symbol} hit $${current}\nTarget: $${alert.target}`
      );

      data.priceAlerts = data.priceAlerts.filter(a => a.id !== alert.id);
      saveStorage(data);
    }
  }
}

setInterval(runPriceAlerts, POLL_MS);

// ---------------- Launch ----------------
bot.launch();
console.log("Prime Bot v3 running (Auto Delete Enabled)");
