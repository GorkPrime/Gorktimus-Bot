const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const STORAGE_PATH = path.join(__dirname, "storage.json");
const BANNER_PATH = path.join(__dirname, "assets", "gorktimus-banner.png");

// Timers
const WATCH_POLL_MS = 60 * 1000;      // watch notifications check (1 min)
const ALERT_POLL_MS = 30 * 1000;      // price alert check (30 sec)
const TRENDING_POLL_MS = 30 * 60 * 1000; // trending push (30 min)

// DexScreener official endpoints:
// - trending/boosts: https://api.dexscreener.com/token-boosts/top/v1
// - token pairs:     https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}
const DEX = {
  boostsTop: "https://api.dexscreener.com/token-boosts/top/v1",
  tokenPairs: (chainId, tokenAddress) =>
    `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`
};

// ---------------- Storage ----------------
function loadStorage() {
  try {
    const raw = fs.readFileSync(STORAGE_PATH, "utf8");
    const data = JSON.parse(raw);
    data.settings = data.settings && typeof data.settings === "object" ? data.settings : {};
    data.priceAlerts = Array.isArray(data.priceAlerts) ? data.priceAlerts : [];
    data.watches = Array.isArray(data.watches) ? data.watches : [];
    return data;
  } catch {
    return { settings: {}, priceAlerts: [], watches: [] };
  }
}

function saveStorage(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
}

function getChatSettings(data, chatId) {
  const key = String(chatId);
  if (!data.settings[key]) {
    data.settings[key] = {
      trendingOn: false,
      trendingChainId: "solana",
      deleteInputsInGroups: true,
      watchNotifyOnlyOnMove: true, // only notify when price moves vs last snapshot
      watchMoveThresholdPct: 0.5   // move threshold to ping (0.5%)
    };
  }
  return data.settings[key];
}

// ---------------- Helpers ----------------
function isPrivate(ctx) {
  return ctx?.chat?.type === "private";
}

async function maybeDeleteUserMessage(ctx) {
  try {
    const data = loadStorage();
    const s = getChatSettings(data, ctx.chat.id);
    // delete only in groups if enabled
    if (!isPrivate(ctx) && s.deleteInputsInGroups) {
      await ctx.deleteMessage();
    }
  } catch {}
}

function fmtUSD(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "N/A";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  if (num >= 1) return `$${num.toFixed(4)}`;
  return `$${num.toFixed(8)}`;
}

function pct(a, b) {
  const A = Number(a), B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B) || B === 0) return null;
  return ((A - B) / B) * 100;
}

function clamp0(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return x;
}

// Risk score (simple + fast). Higher = riskier.
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

// Pick best pair from token-pairs response: highest liquidity.usd
function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  let best = pairs[0];
  let bestLiq = Number(best?.liquidity?.usd ?? 0);
  for (const p of pairs) {
    const liq = Number(p?.liquidity?.usd ?? 0);
    if (liq > bestLiq) {
      best = p;
      bestLiq = liq;
    }
  }
  return best;
}

async function fetchTokenPairs(chainId, tokenAddress) {
  const url = DEX.tokenPairs(chainId, tokenAddress);
  const { data } = await axios.get(url, { timeout: 15000 });
  return data; // array of pairs
}

async function fetchTrendingBoosted(chainId) {
  const { data } = await axios.get(DEX.boostsTop, { timeout: 15000 });
  // returns array of { chainId, tokenAddress, amount, totalAmount, ... }
  const list = Array.isArray(data) ? data : [];
  return list.filter((t) => String(t.chainId).toLowerCase().trim() === String(chainId).toLowerCase().trim());
}

// ---------------- UI (Buttons) ----------------
function homeMenu() {
  return Markup.inlineKeyboard(
    [
      [Markup.button.callback("🔎 Scan Token", "HOME_SCAN"), Markup.button.callback("🧠 Risk / Score", "HOME_SCORE")],
      [Markup.button.callback("👁️ Watch Token", "HOME_WATCH"), Markup.button.callback("📣 My Watches", "HOME_WATCHES")],
      [Markup.button.callback("🎯 Set Alert", "HOME_ALERT"), Markup.button.callback("📌 My Alerts", "HOME_ALERTS")],
      [Markup.button.callback("📈 Trending Toggle", "HOME_TREND_TOGGLE")],
      [Markup.button.callback("⚙️ Settings", "HOME_SETTINGS")]
    ],
    { columns: 2 }
  );
}

function backHomeRow() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Home", "GO_HOME")]]);
}

function settingsMenu(settings) {
  const trendText = settings.trendingOn ? "📈 Trending: ON" : "📉 Trending: OFF";
  const delText = settings.deleteInputsInGroups ? "🧹 Delete Inputs: ON" : "🧹 Delete Inputs: OFF";
  const watchText = settings.watchNotifyOnlyOnMove ? "👁️ Watch Pings: ONLY on move" : "👁️ Watch Pings: ALWAYS";
  return Markup.inlineKeyboard(
    [
      [Markup.button.callback(trendText, "SET_TREND_TOGGLE")],
      [Markup.button.callback(delText, "SET_DEL_TOGGLE")],
      [Markup.button.callback(watchText, "SET_WATCH_PINGS_TOGGLE")],
      [Markup.button.callback(`📏 Move Threshold: ${settings.watchMoveThresholdPct}%`, "SET_THRESH")],
      [Markup.button.callback("🏠 Home", "GO_HOME")]
    ],
    { columns: 1 }
  );
}

// ---------------- Conversation State ----------------
const waiting = new Map(); // chatId -> { mode, extra? }
// modes: scan | score | watch | alert_symbol | alert_target | del_alert | del_watch | set_thresh

function setWaiting(chatId, mode, extra = {}) {
  waiting.set(String(chatId), { mode, extra, ts: Date.now() });
}
function clearWaiting(chatId) {
  waiting.delete(String(chatId));
}

// ---------------- Home Banner + Menu ----------------
async function sendHome(ctxOrChatId) {
  const chatId = typeof ctxOrChatId === "number" || typeof ctxOrChatId === "string"
    ? ctxOrChatId
    : ctxOrChatId.chat.id;

  // Send banner (if exists)
  try {
    if (fs.existsSync(BANNER_PATH)) {
      await bot.telegram.sendPhoto(chatId, { source: BANNER_PATH });
    }
  } catch {}

  await bot.telegram.sendMessage(
    chatId,
    "🧠 **Gorktimus Prime Intelligence Terminal**\nTap a button 👇",
    { parse_mode: "Markdown", ...homeMenu() }
  );
}

// ---------------- Start ----------------
bot.start(async (ctx) => {
  await sendHome(ctx);
  await maybeDeleteUserMessage(ctx);
});

// ---------------- Button actions ----------------
bot.action("GO_HOME", async (ctx) => {
  await ctx.answerCbQuery();
  clearWaiting(ctx.chat.id);
  await sendHome(ctx.chat.id);
});

bot.action("HOME_SCAN", async (ctx) => {
  await ctx.answerCbQuery();
  setWaiting(ctx.chat.id, "scan");
  await ctx.reply("Paste a **token address** (Solana mint) to scan.", { parse_mode: "Markdown", ...backHomeRow() });
});

bot.action("HOME_SCORE", async (ctx) => {
  await ctx.answerCbQuery();
  setWaiting(ctx.chat.id, "score");
  await ctx.reply("Paste a **token address** (Solana mint) for risk score.", { parse_mode: "Markdown", ...backHomeRow() });
});

bot.action("HOME_WATCH", async (ctx) => {
  await ctx.answerCbQuery();
  setWaiting(ctx.chat.id, "watch");
  await ctx.reply("Paste a **token address** (Solana mint) to add to Watchlist.", { parse_mode: "Markdown", ...backHomeRow() });
});

bot.action("HOME_WATCHES", async (ctx) => {
  await ctx.answerCbQuery();
  const data = loadStorage();
  const mine = data.watches.filter(w => String(w.chatId) === String(ctx.chat.id));
  if (!mine.length) return ctx.reply("No watches yet.", backHomeRow());

  const lines = mine.map(w => `#${w.id} — ${w.symbol ?? "?"} (${w.tokenAddress.slice(0, 6)}…${w.tokenAddress.slice(-4)})`);
  return ctx.reply(`👁️ Watches:\n${lines.join("\n")}\n\nTo delete: tap Settings → (coming next) or type the ID when prompted by Delete Watch button (we’ll add later).`, backHomeRow());
});

bot.action("HOME_ALERT", async (ctx) => {
  await ctx.answerCbQuery();
  setWaiting(ctx.chat.id, "alert_symbol");
  await ctx.reply("Alert for what?\n\n1) Paste a **token address** (Solana mint)\n\n(We’ll alert based on DexScreener priceUsd)", backHomeRow());
});

bot.action("HOME_ALERTS", async (ctx) => {
  await ctx.answerCbQuery();
  const data = loadStorage();
  const mine = data.priceAlerts.filter(a => String(a.chatId) === String(ctx.chat.id));
  if (!mine.length) return ctx.reply("No alerts yet.", backHomeRow());

  const lines = mine.map(a => `#${a.id} — ${a.symbol ?? "TOKEN"} ${a.direction === "above" ? ">=" : "<="} $${a.target}`);
  return ctx.reply(`📌 Alerts:\n${lines.join("\n")}`, backHomeRow());
});

bot.action("HOME_TREND_TOGGLE", async (ctx) => {
  await ctx.answerCbQuery();
  const data = loadStorage();
  const s = getChatSettings(data, ctx.chat.id);
  s.trendingOn = !s.trendingOn;
  saveStorage(data);

  await ctx.reply(
    s.trendingOn
      ? "✅ Trending notifications ON (Top 10 boosted tokens)."
      : "⛔ Trending notifications OFF.",
    { ...homeMenu() }
  );
});

bot.action("HOME_SETTINGS", async (ctx) => {
  await ctx.answerCbQuery();
  const data = loadStorage();
  const s = getChatSettings(data, ctx.chat.id);
  saveStorage(data);
  await ctx.reply("⚙️ Settings:", settingsMenu(s));
});

bot.action("SET_TREND_TOGGLE", async (ctx) => {
  await ctx.answerCbQuery();
  const data = loadStorage();
  const s = getChatSettings(data, ctx.chat.id);
  s.trendingOn = !s.trendingOn;
  saveStorage(data);
  await ctx.editMessageText("⚙️ Settings:", settingsMenu(s));
});

bot.action("SET_DEL_TOGGLE", async (ctx) => {
  await ctx.answerCbQuery();
  const data = loadStorage();
  const s = getChatSettings(data, ctx.chat.id);
  s.deleteInputsInGroups = !s.deleteInputsInGroups;
  saveStorage(data);
  await ctx.editMessageText("⚙️ Settings:", settingsMenu(s));
});

bot.action("SET_WATCH_PINGS_TOGGLE", async (ctx) => {
  await ctx.answerCbQuery();
  const data = loadStorage();
  const s = getChatSettings(data, ctx.chat.id);
  s.watchNotifyOnlyOnMove = !s.watchNotifyOnlyOnMove;
  saveStorage(data);
  await ctx.editMessageText("⚙️ Settings:", settingsMenu(s));
});

bot.action("SET_THRESH", async (ctx) => {
  await ctx.answerCbQuery();
  setWaiting(ctx.chat.id, "set_thresh");
  await ctx.reply("Send new move threshold percent (example: `0.5` or `1`).", { parse_mode: "Markdown", ...backHomeRow() });
});

// ---------------- Text handler (wizard inputs) ----------------
bot.on("text", async (ctx) => {
  const st = waiting.get(String(ctx.chat.id));
  if (!st) return;

  const text = (ctx.message.text || "").trim();
  if (!text) return;

  try {
    if (st.mode === "set_thresh") {
      const val = Number(text);
      if (!Number.isFinite(val) || val <= 0) {
        await ctx.reply("Threshold must be a number > 0. Example: `0.5`", { parse_mode: "Markdown", ...backHomeRow() });
        await maybeDeleteUserMessage(ctx);
        return;
      }
      const data = loadStorage();
      const s = getChatSettings(data, ctx.chat.id);
      s.watchMoveThresholdPct = val;
      saveStorage(data);
      clearWaiting(ctx.chat.id);
      await ctx.reply("✅ Threshold updated.", homeMenu());
      await maybeDeleteUserMessage(ctx);
      return;
    }

    // For now we assume Solana token addresses for scan/watch/alert.
    const tokenAddress = text;

    if (st.mode === "scan" || st.mode === "score") {
      const pairs = await fetchTokenPairs("solana", tokenAddress);
      const best = pickBestPair(pairs);
      if (!best) {
        clearWaiting(ctx.chat.id);
        await ctx.reply("No pairs found for that token address.", backHomeRow());
        await maybeDeleteUserMessage(ctx);
        return;
      }

      const risk = riskPercent(best);
      const symbol = best?.baseToken?.symbol ?? "TOKEN";
      const priceUsd = Number(best?.priceUsd ?? 0);

      clearWaiting(ctx.chat.id);

      if (st.mode === "scan") {
        await ctx.reply(
          `🔎 ${symbol}\n` +
          `Risk: ${risk}%\n` +
          `Price: ${fmtUSD(priceUsd)}\n` +
          `Liq: ${fmtUSD(best?.liquidity?.usd)} | Vol24: ${fmtUSD(best?.volume?.h24)}\n` +
          `5m Buys/Sells: ${best?.txns?.m5?.buys ?? "?"}/${best?.txns?.m5?.sells ?? "?"}\n` +
          `Link: ${best?.url ?? "N/A"}`,
          homeMenu()
        );
      } else {
        await ctx.reply(
          `🧠 ${symbol} Risk: ${risk}%\n` +
          `Liq: ${fmtUSD(best?.liquidity?.usd)} | Vol24: ${fmtUSD(best?.volume?.h24)}\n` +
          `Price: ${fmtUSD(priceUsd)}`,
          homeMenu()
        );
      }

      await maybeDeleteUserMessage(ctx);
      return;
    }

    if (st.mode === "watch") {
      const pairs = await fetchTokenPairs("solana", tokenAddress);
      const best = pickBestPair(pairs);
      if (!best) {
        clearWaiting(ctx.chat.id);
        await ctx.reply("No pairs found for that token address.", backHomeRow());
        await maybeDeleteUserMessage(ctx);
        return;
      }

      const data = loadStorage();
      const id = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const symbol = best?.baseToken?.symbol ?? "TOKEN";

      // Snapshot for delta tracking
      const snap = {
        lastPriceUsd: Number(best?.priceUsd ?? 0),
        lastBuysM5: Number(best?.txns?.m5?.buys ?? 0),
        lastSellsM5: Number(best?.txns?.m5?.sells ?? 0),
        lastNotifiedAt: Date.now()
      };

      data.watches.push({
        id,
        chatId: ctx.chat.id,
        chainId: "solana",
        tokenAddress,
        symbol,
        snapshot: snap
      });

      saveStorage(data);
      clearWaiting(ctx.chat.id);

      await ctx.reply(`👁️ Watching ${symbol}\nID: #${id}`, homeMenu());
      await maybeDeleteUserMessage(ctx);
      return;
    }

    if (st.mode === "alert_symbol") {
      // save token and ask target
      clearWaiting(ctx.chat.id);
      setWaiting(ctx.chat.id, "alert_target", { tokenAddress });
      await ctx.reply("Send target price USD.\nExample: `0.0012`\n(We trigger when price goes ABOVE target.)", { parse_mode: "Markdown", ...backHomeRow() });
      await maybeDeleteUserMessage(ctx);
      return;
    }

    if (st.mode === "alert_target") {
      const tokenAddress2 = st.extra.tokenAddress;
      const target = Number(text);
      if (!Number.isFinite(target) || target <= 0) {
        await ctx.reply("Target must be a number > 0. Example: `0.0012`", { parse_mode: "Markdown", ...backHomeRow() });
        await maybeDeleteUserMessage(ctx);
        return;
      }

      const pairs = await fetchTokenPairs("solana", tokenAddress2);
      const best = pickBestPair(pairs);
      if (!best) {
        clearWaiting(ctx.chat.id);
        await ctx.reply("No pairs found for that token address.", backHomeRow());
        await maybeDeleteUserMessage(ctx);
        return;
      }

      const data = loadStorage();
      const id = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const symbol = best?.baseToken?.symbol ?? "TOKEN";

      data.priceAlerts.push({
        id,
        chatId: ctx.chat.id,
        chainId: "solana",
        tokenAddress: tokenAddress2,
        symbol,
        direction: "above",
        target,
        createdAt: Date.now()
      });

      saveStorage(data);
      clearWaiting(ctx.chat.id);

      await ctx.reply(`🎯 Alert set: ${symbol} >= $${target}\nID: #${id}`, homeMenu());
      await maybeDeleteUserMessage(ctx);
      return;
    }
  } catch (e) {
    console.error(e);
    clearWaiting(ctx.chat.id);
    await ctx.reply("⚠️ Error. Try again.", homeMenu());
    await maybeDeleteUserMessage(ctx);
  }
});

// ---------------- Trending loop ----------------
async function trendingLoop() {
  const data = loadStorage();

  // Find chats with trending ON
  const chatIds = Object.keys(data.settings).filter((cid) => data.settings[cid]?.trendingOn);
  if (!chatIds.length) return;

  // For now: solana chain only (simple + best)
  const chainId = "solana";
  const trending = await fetchTrendingBoosted(chainId);
  const top10 = trending.slice(0, 10);

  // Pull details for each token (best pair)
  const rows = [];
  for (const t of top10) {
    try {
      const pairs = await fetchTokenPairs(chainId, t.tokenAddress);
      const best = pickBestPair(pairs);
      if (!best) continue;
      rows.push({
        symbol: best?.baseToken?.symbol ?? "TOKEN",
        priceUsd: Number(best?.priceUsd ?? 0),
        chg1h: best?.priceChange?.h1,
        liq: Number(best?.liquidity?.usd ?? 0),
        vol24: Number(best?.volume?.h24 ?? 0),
        risk: riskPercent(best),
        url: best?.url
      });
    } catch {}
  }

  if (!rows.length) return;

  const msg =
    `📈 **Top 10 Trending (Boosted) — Solana**\n` +
    rows
      .map((r, i) =>
        `${i + 1}) ${r.symbol} | ${fmtUSD(r.priceUsd)} | 1h: ${r.chg1h ?? "?"}% | Liq: ${fmtUSD(r.liq)} | Vol24: ${fmtUSD(r.vol24)} | Risk: ${r.risk}%`
      )
      .join("\n");

  // Send to every chat that has it ON
  for (const cid of chatIds) {
    try {
      await bot.telegram.sendMessage(cid, msg, { parse_mode: "Markdown" });
    } catch {}
  }
}

// ---------------- Watch loop ----------------
async function watchLoop() {
  const data = loadStorage();
  if (!data.watches.length) return;

  for (const w of data.watches) {
    try {
      const pairs = await fetchTokenPairs(w.chainId, w.tokenAddress);
      const best = pickBestPair(pairs);
      if (!best) continue;

      const priceNow = Number(best?.priceUsd ?? 0);
      const buysNow = Number(best?.txns?.m5?.buys ?? 0);
      const sellsNow = Number(best?.txns?.m5?.sells ?? 0);

      const last = w.snapshot || {};
      const priceThen = Number(last.lastPriceUsd ?? priceNow);

      const movePct = pct(priceNow, priceThen);
      const moveAbs = priceNow - priceThen;

      // Approx “since last ping” using m5 window deltas (best effort)
      let buysDelta = clamp0(buysNow - Number(last.lastBuysM5 ?? buysNow));
      let sellsDelta = clamp0(sellsNow - Number(last.lastSellsM5 ?? sellsNow));

      const chatId = w.chatId;
      const s = getChatSettings(data, chatId);

      const movedEnough =
        movePct === null ? true : Math.abs(movePct) >= Number(s.watchMoveThresholdPct ?? 0.5);

      if (!s.watchNotifyOnlyOnMove || movedEnough) {
        const arrow = moveAbs >= 0 ? "⬆️" : "⬇️";
        const sym = w.symbol || best?.baseToken?.symbol || "TOKEN";
        const risk = riskPercent(best);

        await bot.telegram.sendMessage(
          chatId,
          `👁️ Watch Update — ${sym}\n` +
            `${arrow} Price: ${fmtUSD(priceNow)} (${movePct === null ? "?" : movePct.toFixed(2)}%)\n` +
            `Buys/Sells since last ping (approx): ${buysDelta}/${sellsDelta}\n` +
            `Liq: ${fmtUSD(best?.liquidity?.usd)} | Vol24: ${fmtUSD(best?.volume?.h24)} | Risk: ${risk}%\n` +
            `Link: ${best?.url ?? "N/A"}`
        );

        // update snapshot after notify
        w.snapshot = {
          lastPriceUsd: priceNow,
          lastBuysM5: buysNow,
          lastSellsM5: sellsNow,
          lastNotifiedAt: Date.now()
        };
        saveStorage(data);
      } else {
        // still update snapshot quietly so deltas stay meaningful
        w.snapshot = {
          lastPriceUsd: priceNow,
          lastBuysM5: buysNow,
          lastSellsM5: sellsNow,
          lastNotifiedAt: last.lastNotifiedAt ?? Date.now()
        };
        saveStorage(data);
      }
    } catch (e) {
      console.error("watchLoop error", e?.message || e);
    }
  }
}

// ---------------- Price alert loop ----------------
async function alertLoop() {
  const data = loadStorage();
  if (!data.priceAlerts.length) return;

  const toRemove = new Set();

  for (const a of data.priceAlerts) {
    try {
      const pairs = await fetchTokenPairs(a.chainId, a.tokenAddress);
      const best = pickBestPair(pairs);
      if (!best) continue;

      const priceNow = Number(best?.priceUsd ?? 0);
      const hit = a.direction === "above" ? priceNow >= a.target : priceNow <= a.target;

      if (hit) {
        await bot.telegram.sendMessage(
          a.chatId,
          `🎯 ALERT HIT — ${a.symbol ?? "TOKEN"}\n` +
            `Price: ${fmtUSD(priceNow)}\n` +
            `Target: $${a.target}\n` +
            `ID: #${a.id}\n` +
            `Link: ${best?.url ?? "N/A"}`
        );
        toRemove.add(a.id);
      }
    } catch (e) {
      console.error("alertLoop error", e?.message || e);
    }
  }

  if (toRemove.size) {
    data.priceAlerts = data.priceAlerts.filter(x => !toRemove.has(x.id));
    saveStorage(data);
  }
}

// ---------------- Launch + intervals ----------------
bot.launch();
console.log("Prime Bot running (FULL Buttons Terminal)");

// intervals
setInterval(() => alertLoop().catch(() => {}), ALERT_POLL_MS);
setInterval(() => watchLoop().catch(() => {}), WATCH_POLL_MS);
setInterval(() => trendingLoop().catch(() => {}), TRENDING_POLL_MS);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
