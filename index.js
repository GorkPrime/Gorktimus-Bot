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

const WATCHLIST_PATH = path.join(__dirname, "watchlist.json");
const POLL_MS = 60 * 1000;

// --- DexScreener fetch ---
async function fetchDex(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

function formatUSD(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";
  const num = Number(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

// --- Risk scoring (MVP) ---
function riskScore(pair) {
  let score = 100;

  const liq = Number(pair?.liquidity?.usd ?? 0);
  const vol24 = Number(pair?.volume?.h24 ?? 0);
  const change5m = Number(pair?.priceChange?.m5 ?? 0);
  const ageMs = Date.now() - Number(pair?.pairCreatedAt ?? Date.now());
  const ageHours = ageMs / (1000 * 60 * 60);

  if (liq < 20000) score -= 30;
  else if (liq < 50000) score -= 15;

  if (vol24 < 10000) score -= 20;
  if (change5m > 30) score -= 10;
  if (ageHours < 24) score -= 10;

  score = Math.max(0, Math.min(100, score));

  let label = "✅ Low (relative)";
  if (score < 60) label = "🚨 High";
  else if (score < 80) label = "⚠️ Medium";

  return { score, label, ageHours };
}

// --- Watchlist storage (simple JSON) ---
function loadWatchlist() {
  try {
    const raw = fs.readFileSync(WATCHLIST_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data.items) data.items = [];
    return data;
  } catch {
    // If file missing or broken, reset
    return { items: [] };
  }
}

function saveWatchlist(data) {
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(data, null, 2));
}

function normalizeQuery(q) {
  return q.trim();
}

function findItem(data, chatId, query) {
  const q = normalizeQuery(query).toLowerCase();
  return data.items.find(
    (x) => String(x.chatId) === String(chatId) && String(x.query).toLowerCase() === q
  );
}

// --- Telegram commands ---
bot.start((ctx) => {
  ctx.reply(
    "🤖 Prime Bot online.\n\nCommands:\n/scan <token>\n/score <token>\n/watch <token>\n/unwatch <token>\n/watchlist"
  );
});

bot.command("scan", async (ctx) => {
  try {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) return ctx.reply("Usage: /scan <token address | pair | symbol>");

    const pairs = await fetchDex(q);
    if (!pairs.length) return ctx.reply("No results found on DexScreener.");

    const p = pairs[0];
    const msg =
      `🔎 Scan Result\n` +
      `Pair: ${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}\n` +
      `Chain: ${p.chainId ?? "?"} | DEX: ${p.dexId ?? "?"}\n` +
      `Liquidity: ${formatUSD(p.liquidity?.usd)}\n` +
      `Vol (24h): ${formatUSD(p.volume?.h24)}\n` +
      `Price Change: 5m ${p.priceChange?.m5 ?? "N/A"}% | 1h ${p.priceChange?.h1 ?? "N/A"}% | 24h ${p.priceChange?.h24 ?? "N/A"}%\n` +
      `Link: ${p.url ?? "N/A"}`;

    return ctx.reply(msg);
  } catch (e) {
    console.error(e);
    return ctx.reply("Error scanning right now. Try again in a minute.");
  }
});

bot.command("score", async (ctx) => {
  try {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) return ctx.reply("Usage: /score <token address | pair | symbol>");

    const pairs = await fetchDex(q);
    if (!pairs.length) return ctx.reply("No results found on DexScreener.");

    const p = pairs[0];
    const r = riskScore(p);

    const msg =
      `🧠 Prime Risk Score\n` +
      `Token: ${p.baseToken?.symbol ?? "?"}\n` +
      `Score: ${r.score}/100 (${r.label})\n` +
      `Liquidity: ${formatUSD(p.liquidity?.usd)} | Vol 24h: ${formatUSD(p.volume?.h24)}\n` +
      `Age: ${r.ageHours.toFixed(1)} hours\n` +
      `Note: Risk indicator only — not financial advice.\n` +
      `Link: ${p.url ?? "N/A"}`;

    return ctx.reply(msg);
  } catch (e) {
    console.error(e);
    return ctx.reply("Error scoring right now. Try again in a minute.");
  }
});

bot.command("watch", async (ctx) => {
  const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!q) return ctx.reply("Usage: /watch <token address | pair | symbol>");

  const chatId = ctx.chat.id;
  const data = loadWatchlist();

  if (findItem(data, chatId, q)) {
    return ctx.reply("Already watching that token.");
  }

  data.items.push({
    chatId,
    query: normalizeQuery(q),
    // store last seen metrics so we can detect changes
    last: { liq: null, vol24: null, change5m: null },
    createdAt: Date.now(),
  });

  saveWatchlist(data);
  return ctx.reply(`✅ Watching: ${q}\nI’ll alert you if it moves weird.`);
});

bot.command("unwatch", (ctx) => {
  const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!q) return ctx.reply("Usage: /unwatch <token address | pair | symbol>");

  const chatId = ctx.chat.id;
  const data = loadWatchlist();
  const before = data.items.length;

  data.items = data.items.filter(
    (x) => !(String(x.chatId) === String(chatId) && String(x.query).toLowerCase() === q.toLowerCase())
  );

  saveWatchlist(data);

  if (data.items.length === before) return ctx.reply("Not found in your watchlist.");
  return ctx.reply(`🗑️ Removed from watchlist: ${q}`);
});

bot.command("watchlist", (ctx) => {
  const chatId = ctx.chat.id;
  const data = loadWatchlist();
  const mine = data.items.filter((x) => String(x.chatId) === String(chatId));

  if (!mine.length) return ctx.reply("Your watchlist is empty. Use /watch <token>");

  const lines = mine.map((x, i) => `${i + 1}. ${x.query}`);
  return ctx.reply(`📌 Your Watchlist:\n${lines.join("\n")}`);
});

// --- Alert loop ---
async function alertLoop() {
  const data = loadWatchlist();
  if (!data.items.length) return;

  for (const item of data.items) {
    try {
      const pairs = await fetchDex(item.query);
      if (!pairs.length) continue;

      const p = pairs[0];

      const liq = Number(p?.liquidity?.usd ?? 0);
      const vol24 = Number(p?.volume?.h24 ?? 0);
      const change5m = Number(p?.priceChange?.m5 ?? 0);

      const last = item.last || { liq: null, vol24: null, change5m: null };

      // Alert rules (tweak later)
      const alerts = [];

      // Big 5m move
      if (Math.abs(change5m) >= 3) {
        alerts.push(`⚡ 5m move: ${change5m}%`);
      }

      // Liquidity drop
      if (last.liq !== null && liq > 0) {
        const dropPct = ((last.liq - liq) / last.liq) * 100;
        if (dropPct >= 20) alerts.push(`💧 Liquidity dropped ~${dropPct.toFixed(1)}%`);
      }

      // Volume spike
      if (last.vol24 !== null && vol24 > 0 && last.vol24 > 0) {
        const upPct = ((vol24 - last.vol24) / last.vol24) * 100;
        if (upPct >= 50) alerts.push(`📈 24h volume jumped ~${upPct.toFixed(1)}%`);
      }

      if (alerts.length) {
        const msg =
          `🚨 Prime Alert (${p.baseToken?.symbol ?? "?"})\n` +
          `${alerts.join("\n")}\n` +
          `Liquidity: ${formatUSD(liq)} | Vol24: ${formatUSD(vol24)} | 5m: ${change5m}%\n` +
          `Link: ${p.url ?? "N/A"}`;

        await bot.telegram.sendMessage(item.chatId, msg);
      }

      // update last metrics
      item.last = { liq, vol24, change5m };
    } catch (e) {
      console.error("Alert loop error for", item.query, e.message || e);
    }
  }

  saveWatchlist(data);
}

setInterval(() => {
  alertLoop().catch((e) => console.error("Alert loop fatal", e));
}, POLL_MS);

bot.launch();
console.log("Prime Bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
