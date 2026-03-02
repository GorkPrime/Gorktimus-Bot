import { Telegraf } from "telegraf";
import axios from "axios";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
  process.exit(1);
}

const bot = new Telegraf(token);

// Helper: fetch DexScreener pairs by query (token address, pair address, or symbol)
async function fetchDex(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  return pairs;
}

function formatUSD(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";
  const num = Number(n);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

// Simple “defensible” scoring rules (MVP)
function riskScore(pair) {
  let score = 100;

  const liq = Number(pair?.liquidity?.usd ?? 0);
  const vol24 = Number(pair?.volume?.h24 ?? 0);
  const change5m = Number(pair?.priceChange?.m5 ?? 0);
  const ageMs = Date.now() - Number(pair?.pairCreatedAt ?? Date.now());
  const ageHours = ageMs / (1000 * 60 * 60);

  // Liquidity
  if (liq < 20000) score -= 30;
  else if (liq < 50000) score -= 15;

  // Volume
  if (vol24 < 10000) score -= 20;

  // Spike risk
  if (change5m > 30) score -= 10;

  // Super new token risk
  if (ageHours < 24) score -= 10;

  // Clamp
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let label = "✅ Low (relative)";
  if (score < 60) label = "🚨 High";
  else if (score < 80) label = "⚠️ Medium";

  return { score, label, ageHours };
}

bot.start((ctx) => {
  ctx.reply(
    "🤖 Prime Bot online.\n\nCommands:\n/scan <token>\n/score <token>\nExample: /score SOL"
  );
});

bot.command("scan", async (ctx) => {
  try {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) return ctx.reply("Usage: /scan <token address | pair | symbol>");

    const pairs = await fetchDex(q);
    if (!pairs.length) return ctx.reply("No results found on DexScreener.");

    const p = pairs[0]; // MVP: take top match
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
      `Note: This is a risk indicator — not financial advice.\n` +
      `Link: ${p.url ?? "N/A"}`;

    return ctx.reply(msg);
  } catch (e) {
    console.error(e);
    return ctx.reply("Error scoring right now. Try again in a minute.");
  }
});

// Start bot (long polling — easiest)
bot.launch();
console.log("Prime Bot running...");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
