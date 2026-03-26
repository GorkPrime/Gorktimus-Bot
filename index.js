
 * Required env:
 * TELEGRAM_BOT_TOKEN=...
 * CHANNEL_USERNAME=@yourchannel            // optional membership gate
 * HELIUS_API_KEY=...                       // optional wallet tracking
 * OPENAI_API_KEY=...                       // optional future AI mode
 * DEFAULT_ALERT_PCT=5
 * DEFAULT_LIQ_ALERT_PCT=10
 * ALERT_COOLDOWN_SECONDS=900
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const { promisify } = require("util");
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_ALERT_PCT = Number(process.env.DEFAULT_ALERT_PCT || 5);
const DEFAULT_LIQ_ALERT_PCT = Number(process.env.DEFAULT_LIQ_ALERT_PCT || 10);
const ALERT_COOLDOWN_SECONDS = Number(process.env.ALERT_COOLDOWN_SECONDS || 900);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "gorktimus.db");
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not provided");
  process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database(DB_PATH);
const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
const get = promisify(db.get.bind(db));
const all = promisify(db.all.bind(db));
function nowTs() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function pctChange(oldValue, newValue) {
  if (!Number.isFinite(oldValue) || oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}
function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "0";
}
function fmtUsd(n) {
  const value = safeNum(n, NaN);
  if (!Number.isFinite(value)) return "N/A";
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(6)}`;
  return "$0.00";
}
function fmtPct(n) {
  const value = safeNum(n, NaN);
}
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : "N/A";
function escapeHtml(input = "") {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function shortAddr(addr = "", head = 6, tail = 4) {
  if (!addr || addr.length <= head + tail + 3) return addr || "N/A";
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}
function normalizeText(v = "") {
  return String(v).trim();
}
function hasHelius() {
  return Boolean(HELIUS_API_KEY);
}
function isLikelySolanaWallet(input = "") {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(input).trim());
}
function makeHash(input = "") {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}
function buildMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Scan Token", callback_data: "menu_scan" },
          { text: "Trending", callback_data: "menu_trending" }
        ],
        [
          { text: "Watchlist", callback_data: "menu_watchlist" },
          { text: "Alerts", callback_data: "menu_alerts" }
        ],
        [
          { text: "Wallet Tracking", callback_data: "menu_wallets" },
          { text: "AI Assistant", callback_data: "menu_ai" }
        ],
        [
          { text: "Modes / Settings", callback_data: "menu_settings" },
          { text: "Help", callback_data: "menu_help" }
        ],
        [{ text: "Referrals", callback_data: "menu_referrals" }]
      ]
    },
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
}
function buildBackMenuRow() {
  return [{ text: "Main Menu", callback_data: "main_menu" }];
}
function buildModeButtons(activeMode = "balanced") {
  const decorate = (mode, label) => (mode === activeMode ? `* ${label}` : label);
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: decorate("fast", "Mode A - Fast Scan"), callback_data: "mode_fast" }],
        [{ text: decorate("balanced", "Mode B - Balanced Intelligence"), callback_data: "mode_balanced" }],
        [{ text: decorate("deep", "Mode C - Deep Defense"), callback_data: "mode_deep" }],
        buildBackMenuRow()
      ]
    },
    parse_mode: "HTML"
  };
}
function buildAlertsMenu(settings) {
  const onOff = (v) => (v ? "ON" : "OFF");
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `Price Alerts ${onOff(settings.price_alerts)}`, callback_data: "toggle_alert_price" }],
        [{ text: `Liquidity Alerts ${onOff(settings.liq_alerts)}`, callback_data: "toggle_alert_liq" }],
        [{ text: `Watchlist Risk ${onOff(settings.risk_alerts)}`, callback_data: "toggle_alert_risk" }],
        [{ text: `Wallet Alerts ${onOff(settings.wallet_alerts)}`, callback_data: "toggle_alert_wallet" }],
        buildBackMenuRow()
}
      ]
    },
    parse_mode: "HTML"
  };
function buildWatchlistMenu(tokens) {
  const keyboard = tokens.slice(0, 10).map((t) => [
    { text: `Scan ${t.symbol || t.query || shortAddr(t.contract_address || "", 6, 4)}`, callback_data: `watch_scan:${t.id}` },
    { text: "Remove", callback_data: `watch_remove:${t.id}` }
  ]);
  keyboard.push(buildBackMenuRow());
  return {
    reply_markup: { inline_keyboard: keyboard },
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
}
function buildTrendingMenu(items) {
  const keyboard = items.slice(0, 10).map((item) => [
    { text: `${item.baseToken?.symbol || "TOKEN"} | ${fmtUsd(item.liquidity?.usd)}`, callback_data: `trend_scan:${encodeURIComponent(item.pairAddress || item.baseToken?.address || "")}` }
  ]);
  keyboard.push(buildBackMenuRow());
  return {
    reply_markup: { inline_keyboard: keyboard },
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
}
async function sendText(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}
async function editText(chatId, messageId, text, extra = {}) {
  return bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}
async function answerCb(id, text = "") {
  try {
    await bot.answerCallbackQuery(id, text ? { text, show_alert: false } : {});
  } catch (_) {
    // ignore
  }
}
async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      mode TEXT NOT NULL DEFAULT 'balanced',
      expecting_input TEXT,
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      member_verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      chat_id TEXT PRIMARY KEY,
      price_alerts INTEGER NOT NULL DEFAULT 1,
      liq_alerts INTEGER NOT NULL DEFAULT 1,
      risk_alerts INTEGER NOT NULL DEFAULT 1,
      wallet_alerts INTEGER NOT NULL DEFAULT 1,
      price_alert_pct REAL NOT NULL DEFAULT 5,
      liq_alert_pct REAL NOT NULL DEFAULT 10,
      cooldown_seconds INTEGER NOT NULL DEFAULT 900,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      query TEXT NOT NULL,
      symbol TEXT,
      contract_address TEXT,
      chain_id TEXT,
      pair_address TEXT,
      last_price REAL,
      last_liquidity REAL,
      last_risk_score REAL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS wallet_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      label_type TEXT NOT NULL,
      nickname TEXT NOT NULL,
      chain_id TEXT NOT NULL DEFAULT 'solana',
      active INTEGER NOT NULL DEFAULT 1,
      alerts_enabled INTEGER NOT NULL DEFAULT 1,
      last_seen_signature TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_chat_id TEXT NOT NULL,
      referred_chat_id TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_unique_pair
    ON referrals(referrer_chat_id, referred_chat_id)
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS prompt_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}
async function ensureUser(msg) {
  const chatId = String(msg.chat.id);
  const ts = nowTs();
  const existing = await get(`SELECT * FROM users WHERE chat_id = ?`, [chatId]);
  if (!existing) {
    await run(
      `INSERT INTO users (chat_id, username, first_name, mode, expecting_input, ai_enabled, member_verified, created_at, updated_at)
       VALUES (?, ?, ?, 'balanced', NULL, 1, 0, ?, ?)`,
      [chatId, msg.from?.username || "", msg.from?.first_name || "", ts, ts]
    );
  } else {
    await run(
      `UPDATE users
       SET username = ?, first_name = ?, updated_at = ?
       WHERE chat_id = ?`,
      [msg.from?.username || "", msg.from?.first_name || "", ts, chatId]
  }
    );
  const settings = await get(`SELECT * FROM settings WHERE chat_id = ?`, [chatId]);
  if (!settings) {
    await run(
      `INSERT INTO settings (chat_id, price_alerts, liq_alerts, risk_alerts, wallet_alerts, price_alert_pct, liq_alert_pct, cooldown_seconds, created_at, updated_at)
       VALUES (?, 1, 1, 1, 1, ?, ?, ?, ?, ?)`,
      [chatId, DEFAULT_ALERT_PCT, DEFAULT_LIQ_ALERT_PCT, ALERT_COOLDOWN_SECONDS, ts, ts]
    );
  }
}
async function setExpecting(chatId, value) {
  await run(`UPDATE users SET expecting_input = ?, updated_at = ? WHERE chat_id = ?`, [value, nowTs(), String(chatId)]);
}
async function setMode(chatId, mode) {
  await run(`UPDATE users SET mode = ?, updated_at = ? WHERE chat_id = ?`, [mode, nowTs(), String(chatId)]);
}
async function getUser(chatId) {
  return get(`SELECT * FROM users WHERE chat_id = ?`, [String(chatId)]);
}
async function getSettings(chatId) {
  return get(`SELECT * FROM settings WHERE chat_id = ?`, [String(chatId)]);
}
async function toggleSetting(chatId, field) {
  const row = await getSettings(chatId);
  const next = row && row[field] ? 0 : 1;
  await run(`UPDATE settings SET ${field} = ?, updated_at = ? WHERE chat_id = ?`, [next, nowTs(), String(chatId)]);
  return getSettings(chatId);
}
async function logPrompt(chatId, role, content) {
  await run(
    `INSERT INTO prompt_log (chat_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`,
    [String(chatId), role, String(content).slice(0, 4000), nowTs()]
  );
}
async function getPromptHistory(chatId, limit = 8) {
  const rows = await all(
    `SELECT role, content FROM prompt_log
     WHERE chat_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [String(chatId), limit]
  );
  return rows.reverse();
}
async function verifyMembership(chatId) {
  if (!CHANNEL_USERNAME) return true;
  try {
    const member = await bot.getChatMember(CHANNEL_USERNAME, chatId);
    const ok = ["creator", "administrator", "member"].includes(member.status);
    await run(`UPDATE users SET member_verified = ?, updated_at = ? WHERE chat_id = ?`, [ok ? 1 : 0, nowTs(), String(chatId)]);
    return ok;
  } catch (err) {
    console.error("membership check error:", err.message);
    return false;
  }
}
function mustJoinMessage() {
  const clean = CHANNEL_USERNAME.startsWith("@") ? CHANNEL_USERNAME : `@${CHANNEL_USERNAME}`;
  return [
    "<b>GorKtimus Access Gate</b>",
    "",
    "To use the terminal, join the official channel first.",
    `Channel: <b>${escapeHtml(clean)}</b>`,
    "",
    "After joining, press <b>Verify Access</b>."
  ].join("\n");
}
function buildVerifyButtons() {
  const url = CHANNEL_USERNAME
    ? `https://t.me/${String(CHANNEL_USERNAME).replace(/^@/, "")}`
    : "https://t.me";
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Join Channel", url }],
        [{ text: "Verify Access", callback_data: "verify_access" }]
}
      ]
    },
    parse_mode: "HTML"
  };
async function enforceMembership(chatId) {
  if (!CHANNEL_USERNAME) return true;
  const ok = await verifyMembership(chatId);
  if (!ok) {
    await sendText(chatId, mustJoinMessage(), buildVerifyButtons());
}
  }
    return false;
  return true;
async function fetchDexSearch(query) {
  const q = encodeURIComponent(normalizeText(query));
  if (!q) return [];
  const url = `https://api.dexscreener.com/latest/dex/search?q=${q}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}
async function fetchDexByTokenAddress(address) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}
async function fetchTrendingPairs() {
  const url = `https://api.dexscreener.com/token-profiles/latest/v1`;
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(data)) return data;
    return [];
  } catch (_) {
    return [];
  }
}
function pickBestPair(pairs = []) {
  if (!pairs.length) return null;
  return [...pairs].sort((a, b) => {
    const liqDiff = safeNum(b?.liquidity?.usd) - safeNum(a?.liquidity?.usd);
    if (liqDiff !== 0) return liqDiff;
    return safeNum(b?.volume?.h24) - safeNum(a?.volume?.h24);
  })[0];
}
function pairAgeMinutes(pair) {
  const created = safeNum(pair?.pairCreatedAt, 0);
  if (!created) return null;
  return Math.max(0, Math.floor((Date.now() - created) / 60000));
}
function buildSourceLines(pair) {
  const lines = [];
  if (pair?.url) lines.push(`DexScreener: ${pair.url}`);
  if (pair?.baseToken?.address) {
    lines.push(`GeckoTerminal: https://www.geckoterminal.com/search?query=${encodeURIComponent(pair.baseToken.address)}`);
    lines.push(`Birdeye: https://birdeye.so/token/${encodeURIComponent(pair.baseToken.address)}?chain=solana`);
  }
  return lines;
}
function deriveWhyItMatters(metrics) {
  const lines = [];
  if (metrics.liquidity < 5000) lines.push("Low liquidity means exits can get ugly fast.");
  if (metrics.marketCap > 0 && metrics.liquidity / metrics.marketCap < 0.02) lines.push("If liquidity is tiny compared to market cap, the chart can look stronger than the real exit path.");
  if (metrics.volume24 > metrics.liquidity * 3 && metrics.liquidity > 0) lines.push("High volume relative to liquidity can signal strong attention, but it can also amplify volatility.");
  if (metrics.sells24 > metrics.buys24 * 1.8 && metrics.sells24 > 30) lines.push("Sell dominance often means momentum is weakening or insiders are unloading.");
  if ((metrics.ageMin || 999999) <= 20) lines.push("The first minutes of a launch are where both the biggest upside and the nastiest traps live.");
  if (!lines.length) lines.push("This pair has a more neutral profile right now, so focus on timing, liquidity quality, and continued flow.");
  return lines;
}
function scorePair(pair) {
  const warnings = [];
  const strengths = [];
  const liquidity = safeNum(pair?.liquidity?.usd, 0);
  const marketCap = safeNum(pair?.marketCap || pair?.fdv, 0);
  const volume24 = safeNum(pair?.volume?.h24, 0);
  const buys24 = safeNum(pair?.txns?.h24?.buys, 0);
  const sells24 = safeNum(pair?.txns?.h24?.sells, 0);
  const priceChange5m = safeNum(pair?.priceChange?.m5, 0);
  const priceChange1h = safeNum(pair?.priceChange?.h1, 0);
  const priceChange24h = safeNum(pair?.priceChange?.h24, 0);
  const ageMin = pairAgeMinutes(pair);
  let score = 55;
  if (liquidity >= 100000) {
    score += 15;
    strengths.push("Strong liquidity base");
  } else if (liquidity >= 25000) {
    score += 7;
    strengths.push("Moderate liquidity");
  } else if (liquidity < 5000) {
    score -= 18;
    warnings.push("Very low liquidity");
  }
  if (marketCap > 0 && liquidity > 0) {
    const liqToCap = liquidity / marketCap;
    if (liqToCap >= 0.12) {
      score += 8;
      strengths.push("Healthy liquidity-to-cap ratio");
    } else if (liqToCap < 0.02) {
      score -= 10;
      warnings.push("Thin liquidity versus market cap");
    }
  }
  if (volume24 > liquidity * 3 && liquidity > 0) {
    strengths.push("Strong volume relative to liquidity");
    score += 4;
  }
  if (Math.abs(priceChange5m) > 35) {
    warnings.push("Violent short-term price swing");
    score -= 8;
  }
  if (priceChange1h < -35 || priceChange24h < -70) {
    warnings.push("Heavy downside pressure");
    score -= 10;
  }
  if (sells24 > buys24 * 1.8 && sells24 > 30) {
    warnings.push("Sell pressure outweighs buys");
    score -= 8;
  } else if (buys24 > sells24 * 1.6 && buys24 > 30) {
    strengths.push("Buy pressure stronger than sells");
    score += 6;
  }
  if (ageMin !== null) {
    if (ageMin <= 20) {
      warnings.push("Very early launch - highest volatility zone");
      score -= 7;
    } else if (ageMin <= 180) {
      strengths.push("Still early with observable market activity");
      score += 2;
    }
  }
  score = Math.max(1, Math.min(99, score));
  let verdict = "Caution";
  let recommendation = "Proceed carefully. Use small size and monitor liquidity.";
  if (score >= 75) {
    verdict = "Stronger Structure";
    recommendation = "Structure looks healthier than average, but still verify entries and watch momentum.";
  } else if (score <= 39) {
    verdict = "High Risk";
    recommendation = "Avoid chasing unless you are deliberately trading extreme risk.";
  }
  return {
    score,
    verdict,
    recommendation,
    warnings,
    strengths,
    whyItMatters: deriveWhyItMatters({ liquidity, marketCap, volume24, buys24, sells24, ageMin })
  };
}
function buildScanCard(pair, userMode = "balanced") {
  const score = scorePair(pair);
  const base = pair?.baseToken || {};
  const quote = pair?.quoteToken || {};
  const ageMin = pairAgeMinutes(pair);
  const lines = [
    "<b>GorKtimus Risk Verdict</b>",
    "",
    `<b>${escapeHtml(score.verdict)}</b>`,
    `Safety Score: <b>${score.score}/99</b>`,
    `Recommendation: ${escapeHtml(score.recommendation)}`,
    "",
    "<b>Warnings</b>",
    score.warnings.length ? score.warnings.map((w) => `- ${escapeHtml(w)}`).join("\n") : "- No major warning spike detected from available pair data.",
    "",
    "<b>Strengths</b>",
    score.strengths.length ? score.strengths.map((s) => `- ${escapeHtml(s)}`).join("\n") : "- No clear strength edge yet.",
    "",
    "<b>Token Metrics</b>",
    `Name: <b>${escapeHtml(base.name || "Unknown")}</b>`,
    `Symbol: <b>${escapeHtml(base.symbol || "N/A")}</b>`,
    `Chain: <b>${escapeHtml(pair?.chainId || "N/A")}</b>`,
    `Pair: <code>${escapeHtml(shortAddr(pair?.pairAddress || "", 8, 6))}</code>`,
    `Contract: <code>${escapeHtml(base.address || "N/A")}</code>`,
    `Price: <b>${escapeHtml(pair?.priceUsd ? fmtUsd(pair.priceUsd) : "N/A")}</b>`,
    `Liquidity: <b>${fmtUsd(pair?.liquidity?.usd)}</b>`,
    `Market Cap: <b>${fmtUsd(pair?.marketCap || pair?.fdv)}</b>`,
    `24H Volume: <b>${fmtUsd(pair?.volume?.h24)}</b>`,
    `Buys/Sells 24H: <b>${fmtInt(pair?.txns?.h24?.buys)}/${fmtInt(pair?.txns?.h24?.sells)}</b>`,
    `5M / 1H / 24H: <b>${fmtPct(pair?.priceChange?.m5)}</b> / <b>${fmtPct(pair?.priceChange?.h1)}</b> / <b>${fmtPct(pair?.priceChange?.h24)}</b>`,
    `Age: <b>${ageMin === null ? "Unknown" : `${fmtInt(ageMin)} min`}</b>`
  ];
  if (userMode !== "fast") {
    lines.push("", "<b>Why It Matters</b>");
    for (const item of score.whyItMatters) lines.push(`- ${escapeHtml(item)}`);
  }
  if (userMode === "deep") {
    lines.push(
      "",
      "<b>Deep Defense Layer</b>",
      `Quote Token: <b>${escapeHtml(quote.symbol || "N/A")}</b>`,
      `DEX: <b>${escapeHtml(pair?.dexId || "N/A")}</b>`,
      `FDV: <b>${fmtUsd(pair?.fdv)}</b>`,
      `Txn 5M Buys/Sells: <b>${fmtInt(pair?.txns?.m5?.buys)}/${fmtInt(pair?.txns?.m5?.sells)}</b>`,
      `Txn 1H Buys/Sells: <b>${fmtInt(pair?.txns?.h1?.buys)}/${fmtInt(pair?.txns?.h1?.sells)}</b>`
    );
  }
  const sources = buildSourceLines(pair);
  if (sources.length) {
    lines.push("", "<b>Sources</b>");
    for (const item of sources) lines.push(escapeHtml(item));
  }
  return lines.join("\n");
}
async function scanToken(query) {
  const looksLikeAddress = /^[A-Za-z0-9]{20,}$/.test(query.trim());
  const pairs = looksLikeAddress ? await fetchDexByTokenAddress(query.trim()) : await fetchDexSearch(query.trim());
  const bestPair = pickBestPair(pairs);
  return { bestPair, pairs };
}
async function upsertWatchlist(chatId, query, bestPair, riskScore) {
  const existing = await get(
    `SELECT * FROM watchlist WHERE chat_id = ? AND (contract_address = ? OR query = ?) AND active = 1 LIMIT 1`,
    [String(chatId), bestPair?.baseToken?.address || "", query]
  );
  const ts = nowTs();
  if (existing) {
    await run(
      `UPDATE watchlist
       SET query = ?, symbol = ?, contract_address = ?, chain_id = ?, pair_address = ?, last_price = ?, last_liquidity = ?, last_risk_score = ?, updated_at = ?
       WHERE id = ?`,
      [
        query,
        bestPair?.baseToken?.symbol || "",
        bestPair?.baseToken?.address || "",
        bestPair?.chainId || "",
        bestPair?.pairAddress || "",
        safeNum(bestPair?.priceUsd, 0),
        safeNum(bestPair?.liquidity?.usd, 0),
        riskScore,
        ts,
        existing.id
      ]
    );
    return existing.id;
  }
  const result = await run(
    `INSERT INTO watchlist
     (chat_id, query, symbol, contract_address, chain_id, pair_address, last_price, last_liquidity, last_risk_score, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      String(chatId),
      query,
      bestPair?.baseToken?.symbol || "",
      bestPair?.baseToken?.address || "",
      bestPair?.chainId || "",
      bestPair?.pairAddress || "",
      safeNum(bestPair?.priceUsd, 0),
      safeNum(bestPair?.liquidity?.usd, 0),
      riskScore,
      ts,
      ts
    ]
  );
  return result.lastID;
}
async function removeWatchlist(chatId, watchId) {
  await run(`UPDATE watchlist SET active = 0, updated_at = ? WHERE id = ? AND chat_id = ?`, [nowTs(), watchId, String(chatId)]);
}
async function addWalletTrack(chatId, wallet, labelType, nickname) {
  const ts = nowTs();
  if (!hasHelius()) {
    await sendText(chatId, [
      "<b>GorKtimus Intelligence Terminal</b>",
      "",
      "Helius is missing.",
      "Add <code>HELIUS_API_KEY</code> to enable wallet tracking."
    ].join("\n"), buildMainMenu());
    return;
  }
  if (!isLikelySolanaWallet(wallet)) {
    await sendText(chatId, [
      "<b>GorKtimus Intelligence Terminal</b>",
      "",
      "That does not look like a valid Solana wallet address."
    ].join("\n"), buildMainMenu());
    return;
  }
  await run(
    `INSERT INTO wallet_tracks
     (chat_id, wallet, label_type, nickname, chain_id, active, alerts_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'solana', 1, 1, ?, ?)`,
    [String(chatId), wallet.trim(), labelType, nickname.trim(), ts, ts]
  );
  await sendText(chatId, [
    "<b>Wallet Tracking Added</b>",
    "",
    `Wallet: <code>${escapeHtml(wallet.trim())}</code>`,
    `Type: <b>${escapeHtml(labelType)}</b>`,
    `Nickname: <b>${escapeHtml(nickname.trim())}</b>`
  ].join("\n"), buildMainMenu());
}
async function fetchHeliusTransactions(wallet) {
  if (!hasHelius()) return [];
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return Array.isArray(data) ? data : [];
}
async function generateAssistantReply(chatId, prompt) {
  const history = await getPromptHistory(chatId, 6);
  const lower = prompt.toLowerCase();
  if (lower.includes("what is liquidity")) {
    return "Liquidity is the real exit fuel. A token can show hype and market cap, but if liquidity is thin, getting out clean gets hard fast.";
  }
  if (lower.includes("what does market cap mean")) {
    return "Market cap is price multiplied by supply. It can look big on paper, but if liquidity is tiny, that market cap can be misleading in practice.";
  }
  if (lower.includes("why no data")) {
    return "No data usually means the pair is too new, not indexed yet, the symbol was too broad, or the source does not expose enough live pair detail yet.";
  }
  if (lower.includes("help") || lower.includes("how does this work")) {
  }
    return "GorKtimus scans pair structure, liquidity, volume, pressure, and launch behavior to turn raw market data into a plain-language risk verdict.";
  const memory = history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join(" | ");
  return [
    "GorKtimus AI Assistant",
    "",
    "I am running in local defense mode right now.",
    "I can explain scans, market structure, liquidity, sell pressure, launch risk, and how to use the terminal.",
    "",
    `Your question: "${prompt.slice(0, 200)}"`,
}
    "",
    `Recent context: ${memory.slice(0, 500) || "No recent context yet."}`
  ].join("\n");
async function sendWelcome(chatId, refCode = "") {
  const intro = [
    "<b>GorKtimus Intelligence Terminal</b>",
    "",
    "Built to protect users from weak structure, false confidence, and low-quality token flow.",
    "",
    "Choose how you want the terminal to think:",
    "- <b>Mode A</b> - Fast Scan",
    "- <b>Mode B</b> - Balanced Intelligence",
    "- <b>Mode C</b> - Deep Defense",
    "",
    "Use the menu below to scan tokens, track watchlist names, monitor wallets, and understand what the data actually means."
  ].join("\n");
  await sendText(chatId, intro, buildMainMenu());
  if (refCode) await registerReferral(chatId, refCode);
}
async function registerReferral(chatId, refCode) {
  try {
    const referrerId = String(refCode).replace(/^ref_/, "");
    if (!referrerId || referrerId === String(chatId)) return;
    const exists = await get(
      `SELECT * FROM referrals WHERE referrer_chat_id = ? AND referred_chat_id = ?`,
      [referrerId, String(chatId)]
    );
    if (exists) return;
    await run(
      `INSERT INTO referrals (referrer_chat_id, referred_chat_id, code, created_at)
       VALUES (?, ?, ?, ?)`,
      [referrerId, String(chatId), refCode, nowTs()]
    );
  } catch (err) {
    console.error("registerReferral error:", err.message);
  }
}
async function sendTrending(chatId) {
  const raw = await fetchTrendingPairs();
  const items = raw
    .filter((x) => x?.tokenAddress || x?.url)
    .slice(0, 10)
    .map((x) => ({
      pairAddress: x.tokenAddress || "",
      baseToken: {
        symbol: x.tokenSymbol || "TOKEN",
        name: x.tokenName || "Unknown",
        address: x.tokenAddress || ""
      },
      liquidity: { usd: safeNum(x.liquidity, 0) },
      volume: { h24: safeNum(x.volume24h, 0) },
      chainId: x.chainId || "solana"
    }));
  if (!items.length) {
    await sendText(chatId, "No trending data is available right now. Try again shortly.", buildMainMenu());
    return;
  }
  const lines = ["<b>Trending Snapshot</b>", ""];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. <b>${escapeHtml(item.baseToken.symbol)}</b> - ${fmtUsd(item.liquidity.usd)} liquidity`);
  });
  await sendText(chatId, lines.join("\n"), buildTrendingMenu(items));
}
async function sendWatchlist(chatId) {
  const rows = await all(`SELECT * FROM watchlist WHERE chat_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 10`, [String(chatId)]);
  if (!rows.length) {
    await sendText(chatId, [
      "<b>Your Watchlist</b>",
      "",
      "No active watchlist entries yet.",
      "Use <b>Scan Token</b>, then add the result to your watchlist."
    ].join("\n"), buildMainMenu());
    return;
  }
  const lines = ["<b>Your Watchlist</b>", ""];
  for (const row of rows) {
    lines.push(
      `- <b>${escapeHtml(row.symbol || row.query)}</b> | Risk ${safeNum(row.last_risk_score, 0).toFixed(0)}/99 | Price ${fmtUsd(row.last_price)}`
}
  }
    );
  await sendText(chatId, lines.join("\n"), buildWatchlistMenu(rows));
async function sendReferrals(chatId) {
  const count = await get(`SELECT COUNT(*) as total FROM referrals WHERE referrer_chat_id = ?`, [String(chatId)]);
  const code = `ref_${chatId}`;
  const botName = await bot.getMe();
  const link = `https://t.me/${botName.username}?start=${code}`;
  await sendText(chatId, [
    "<b>Referral Hub</b>",
    "",
    `Your referrals: <b>${fmtInt(count?.total || 0)}</b>`,
    `Invite Link: <code>${escapeHtml(link)}</code>`,
    "",
    "Share your link. New users are tracked when they launch the bot through your code."
  ].join("\n"), buildMainMenu());
}
async function sendHelp(chatId) {
  await sendText(chatId, [
    "<b>How GorKtimus Works</b>",
    "",
    "- <b>Risk Verdict</b> turns raw market structure into plain-language guidance.",
    "- <b>Liquidity</b> shows how real the exit path looks.",
    "- <b>Volume</b> shows activity, but activity alone does not equal safety.",
    "- <b>Trending</b> is a discovery layer, not a trust badge.",
    "- <b>No data</b> can mean a pair is too new, too obscure, or not fully indexed yet.",
    "- <b>Mode A/B/C</b> changes how much detail the terminal gives back.",
    "",
    "Ask AI Assistant things like:",
    "- what does liquidity mean",
    "- why is this token risky",
    "- explain buy vs sell pressure"
  ].join("\n"), buildMainMenu());
}
async function sendSettings(chatId) {
  const user = await getUser(chatId);
  await sendText(chatId, [
    "<b>Mode Selector</b>",
    "",
    "Mode A - Fast Scan",
    "Mode B - Balanced Intelligence",
    "Mode C - Deep Defense",
    "",
    `Current Mode: <b>${escapeHtml(user?.mode || "balanced")}</b>`
  ].join("\n"), buildModeButtons(user?.mode || "balanced"));
}
async function sendAlerts(chatId) {
  const settings = await getSettings(chatId);
  await sendText(chatId, [
    "<b>Alerts Control Center</b>",
    "",
    `Price Threshold: <b>${fmtPct(settings?.price_alert_pct)}</b>`,
    `Liquidity Threshold: <b>${fmtPct(settings?.liq_alert_pct)}</b>`,
    `Cooldown: <b>${fmtInt(settings?.cooldown_seconds || ALERT_COOLDOWN_SECONDS)} sec</b>`,
    "",
    "Toggle what you want active below."
  ].join("\n"), buildAlertsMenu(settings));
}
async function runScanAndRespond(chatId, query, addToWatchlist = false) {
  const user = await getUser(chatId);
  const { bestPair } = await scanToken(query);
  if (!bestPair) {
    await sendText(chatId, [
      "<b>No Pair Found</b>",
      "",
      "I could not find a usable pair from that query.",
      "Try a ticker, contract address, or more precise token name."
  }
    ].join("\n"), buildMainMenu());
    return;
  const card = buildScanCard(bestPair, user?.mode || "balanced");
  const score = scorePair(bestPair);
  const buttons = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Add to Watchlist", callback_data: `add_watch:${encodeURIComponent(query)}` },
      ]
          { text: "Rescan", callback_data: `rescan:${encodeURIComponent(query)}` }
        ],
        buildBackMenuRow()
    },
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  await sendText(chatId, card, buttons);
  if (addToWatchlist) {
    await upsertWatchlist(chatId, query, bestPair, score.score);
  }
}
async function handleFreeText(msg) {
  const chatId = msg.chat.id;
  const text = normalizeText(msg.text || "");
  const user = await getUser(chatId);
  if (!text) return;
  if (!(await enforceMembership(chatId))) return;
  if (user?.expecting_input === "scan_query") {
    await setExpecting(chatId, null);
    await runScanAndRespond(chatId, text, false);
    return;
  }
  if (user?.expecting_input === "wallet_add") {
    await setExpecting(chatId, null);
    const parts = text.split("|").map((x) => x.trim());
    const wallet = parts[0] || "";
    const labelType = (parts[1] || "whale").toLowerCase();
    const nickname = parts[2] || `Tracked ${labelType}`;
    await addWalletTrack(chatId, wallet, labelType, nickname);
    return;
  }
  if (user?.expecting_input === "ai_prompt") {
    await setExpecting(chatId, null);
    await logPrompt(chatId, "user", text);
    const reply = await generateAssistantReply(chatId, text);
    await logPrompt(chatId, "assistant", reply);
    await sendText(chatId, escapeHtml(reply), buildMainMenu());
    return;
  }
  if (text.startsWith("/scan ")) {
    await runScanAndRespond(chatId, text.replace("/scan ", "").trim(), false);
    return;
  }
  if (text.startsWith("/ai ")) {
    const prompt = text.replace("/ai ", "").trim();
    await logPrompt(chatId, "user", prompt);
    const reply = await generateAssistantReply(chatId, prompt);
    await logPrompt(chatId, "assistant", reply);
    await sendText(chatId, escapeHtml(reply), buildMainMenu());
    return;
  }
  await sendText(chatId, [
    "<b>GorKtimus Terminal</b>",
    "",
    "I did not route that input to a specific flow.",
    "Use the menu or commands:",
    "<code>/scan token_or_contract</code>",
    "<code>/ai ask_question_here</code>"
  ].join("\n"), buildMainMenu());
}
async function monitorWatchlistLoop() {
  while (true) {
    try {
      const rows = await all(`SELECT * FROM watchlist WHERE active = 1 ORDER BY id ASC LIMIT 50`);
      for (const row of rows) {
        const settings = await getSettings(row.chat_id);
        const user = await getUser(row.chat_id);
        if (!user || !settings) continue;
        const query = row.contract_address || row.query;
        const { bestPair } = await scanToken(query);
        if (!bestPair) continue;
        const newPrice = safeNum(bestPair.priceUsd, 0);
        const newLiquidity = safeNum(bestPair?.liquidity?.usd, 0);
        const priceDelta = Math.abs(pctChange(row.last_price, newPrice));
        const liqDelta = Math.abs(pctChange(row.last_liquidity, newLiquidity));
        const risk = scorePair(bestPair);
        const shouldPrice = settings.price_alerts && priceDelta >= safeNum(settings.price_alert_pct, DEFAULT_ALERT_PCT);
        const shouldLiq = settings.liq_alerts && liqDelta >= safeNum(settings.liq_alert_pct, DEFAULT_LIQ_ALERT_PCT);
        const shouldRisk = settings.risk_alerts && Math.abs(risk.score - safeNum(row.last_risk_score, risk.score)) >= 12;
        if (shouldPrice || shouldLiq || shouldRisk) {
          const reasons = [];
          if (shouldPrice) reasons.push(`price moved ${fmtPct(priceDelta)}`);
          if (shouldLiq) reasons.push(`liquidity moved ${fmtPct(liqDelta)}`);
          if (shouldRisk) reasons.push(`risk score shifted to ${risk.score}/99`);
          await sendText(row.chat_id, [
            "<b>Watchlist Alert</b>",
            "",
            `<b>${escapeHtml(bestPair?.baseToken?.symbol || row.query)}</b> triggered an alert.`,
            `Reason: ${escapeHtml(reasons.join(", "))}`,
            "",
            buildScanCard(bestPair, user.mode || "balanced")
          ].join("\n"), buildMainMenu());
        }
        await run(
          `UPDATE watchlist
           SET symbol = ?, contract_address = ?, pair_address = ?, chain_id = ?, last_price = ?, last_liquidity = ?, last_risk_score = ?, updated_at = ?
           WHERE id = ?`,
          [
            bestPair?.baseToken?.symbol || row.symbol,
            bestPair?.baseToken?.address || row.contract_address,
            bestPair?.pairAddress || row.pair_address,
            bestPair?.chainId || row.chain_id,
            newPrice,
            newLiquidity,
            risk.score,
            nowTs(),
            row.id
          ]
        );
        await sleep(350);
      }
    } catch (err) {
      console.error("monitorWatchlistLoop error:", err.message);
    }
    await sleep(60000);
  }
}
async function monitorWalletLoop() {
  while (true) {
    try {
      const rows = await all(`SELECT * FROM wallet_tracks WHERE active = 1 AND alerts_enabled = 1 ORDER BY id ASC LIMIT 25`);
      for (const row of rows) {
        if (!hasHelius()) break;
        try {
          const txs = await fetchHeliusTransactions(row.wallet);
          if (!txs.length) continue;
          const newest = txs[0];
          const sig = newest?.signature || newest?.transactions?.[0]?.signature || "";
          if (sig && sig !== row.last_seen_signature) {
            await sendText(row.chat_id, [
              "<b>Wallet Activity Detected</b>",
              "",
              `Nickname: <b>${escapeHtml(row.nickname)}</b>`,
              `Type: <b>${escapeHtml(row.label_type)}</b>`,
              `Wallet: <code>${escapeHtml(shortAddr(row.wallet, 8, 6))}</code>`,
              `Latest Signature: <code>${escapeHtml(shortAddr(sig, 10, 8))}</code>`
            ].join("\n"), buildMainMenu());
            await run(`UPDATE wallet_tracks SET last_seen_signature = ?, updated_at = ? WHERE id = ?`, [sig, nowTs(), row.id]);
          }
        } catch (err) {
          console.error("wallet row error:", err.message);
        }
      }
        await sleep(350);
    } catch (err) {
      console.error("monitorWalletLoop error:", err.message);
    }
    await sleep(90000);
  }
}
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  try {
    await ensureUser(msg);
    const chatId = msg.chat.id;
    const refCode = normalizeText(match?.[1] || "");
    if (!(await enforceMembership(chatId))) return;
    await sendWelcome(chatId, refCode);
  } catch (err) {
    console.error("/start error:", err.message);
  }
});
bot.onText(/^\/menu$/, async (msg) => {
  try {
    await ensureUser(msg);
    if (!(await enforceMembership(msg.chat.id))) return;
    await sendWelcome(msg.chat.id);
  } catch (err) {
    console.error("/menu error:", err.message);
  }
});
bot.onText(/^\/help$/, async (msg) => {
  try {
    await ensureUser(msg);
    if (!(await enforceMembership(msg.chat.id))) return;
    await sendHelp(msg.chat.id);
  } catch (err) {
    console.error("/help error:", err.message);
  }
});
bot.on("message", async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith("/start") || msg.text === "/menu" || msg.text === "/help") return;
    await ensureUser(msg);
    await handleFreeText(msg);
  } catch (err) {
    console.error("message handler error:", err.message);
  }
});
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || "";
  if (!chatId || !messageId) {
    await answerCb(query.id);
    return;
  }
  try {
    if (!(await enforceMembership(chatId))) {
      await answerCb(query.id);
      return;
    }
    if (data === "verify_access") {
      const ok = await verifyMembership(chatId);
      if (ok) {
        await answerCb(query.id, "Access verified");
        await editText(chatId, messageId, "Access verified. Welcome to GorKtimus.", buildMainMenu());
      } else {
        await answerCb(query.id, "Still not verified");
      }
      return;
    }
    if (data === "main_menu") {
      await answerCb(query.id);
      await editText(chatId, messageId, "<b>GorKtimus Main Menu</b>\n\nChoose your command center below.", buildMainMenu());
      return;
    }
    if (data === "menu_scan") {
      await setExpecting(chatId, "scan_query");
      await answerCb(query.id);
      await editText(chatId, messageId, "Send a token ticker, token name, or contract address to scan.", {
    }
        reply_markup: { inline_keyboard: [buildBackMenuRow()] },
        parse_mode: "HTML"
      });
      return;
    if (data === "menu_trending") {
      await answerCb(query.id);
      await sendTrending(chatId);
      return;
    }
    if (data === "menu_watchlist") {
      await answerCb(query.id);
      await sendWatchlist(chatId);
      return;
    }
    if (data === "menu_alerts") {
      await answerCb(query.id);
      await sendAlerts(chatId);
      return;
    }
    if (data === "menu_wallets") {
      await setExpecting(chatId, "wallet_add");
      await answerCb(query.id);
      await editText(chatId, messageId, [
        "<b>Wallet Tracking</b>",
        "",
        "Send wallet details in this format:",
        "<code>wallet_address | whale | nickname</code>"
      ].join("\n"), {
        reply_markup: { inline_keyboard: [buildBackMenuRow()] },
        parse_mode: "HTML"
      });
      return;
    }
    if (data === "menu_ai") {
      await setExpecting(chatId, "ai_prompt");
      await answerCb(query.id);
      await editText(chatId, messageId, "Ask your question in plain language. Example: <code>why is low liquidity dangerous</code>", {
        reply_markup: { inline_keyboard: [buildBackMenuRow()] },
        parse_mode: "HTML"
      });
      return;
    }
    if (data === "menu_settings") {
      await answerCb(query.id);
      await sendSettings(chatId);
      return;
    }
    if (data === "menu_help") {
      await answerCb(query.id);
      await sendHelp(chatId);
      return;
    }
    if (data === "menu_referrals") {
      await answerCb(query.id);
      await sendReferrals(chatId);
      return;
    }
    if (data === "mode_fast" || data === "mode_balanced" || data === "mode_deep") {
      const nextMode = data.replace("mode_", "");
      await setMode(chatId, nextMode);
      await answerCb(query.id, "Mode updated");
      await editText(chatId, messageId, `Mode updated to <b>${escapeHtml(nextMode)}</b>.`, buildModeButtons(nextMode));
      return;
    }
    if (data === "toggle_alert_price") {
      const settings = await toggleSetting(chatId, "price_alerts");
      await answerCb(query.id);
      await editText(chatId, messageId, "<b>Alerts Control Center</b>\n\nToggle what you want active below.", buildAlertsMenu(settings));
      return;
    }
    if (data === "toggle_alert_liq") {
      const settings = await toggleSetting(chatId, "liq_alerts");
      await answerCb(query.id);
      await editText(chatId, messageId, "<b>Alerts Control Center</b>\n\nToggle what you want active below.", buildAlertsMenu(settings));
      return;
    }
    if (data === "toggle_alert_risk") {
      const settings = await toggleSetting(chatId, "risk_alerts");
      await answerCb(query.id);
      await editText(chatId, messageId, "<b>Alerts Control Center</b>\n\nToggle what you want active below.", buildAlertsMenu(settings));
      return;
    }
    if (data === "toggle_alert_wallet") {
      const settings = await toggleSetting(chatId, "wallet_alerts");
      await answerCb(query.id);
      await editText(chatId, messageId, "<b>Alerts Control Center</b>\n\nToggle what you want active below.", buildAlertsMenu(settings));
    }
      return;
    if (data.startswith && false) {
      // placeholder to keep linter calm in some editors
    }
    if (data.startsWith("add_watch:")) {
      const q = decodeURIComponent(data.split(":")[1] || "");
      const { bestPair } = await scanToken(q);
      if (bestPair) {
        const risk = scorePair(bestPair);
        await upsertWatchlist(chatId, q, bestPair, risk.score);
        await answerCb(query.id, "Added to watchlist");
      } else {
        await answerCb(query.id, "No pair found");
      }
      return;
    }
    if (data.startsWith("rescan:")) {
      const q = decodeURIComponent(data.split(":")[1] || "");
      await answerCb(query.id, "Rescanning");
      await runScanAndRespond(chatId, q, false);
      return;
    }
    if (data.startsWith("trend_scan:")) {
      const address = decodeURIComponent(data.split(":")[1] || "");
      await answerCb(query.id, "Scanning token");
      await runScanAndRespond(chatId, address, false);
      return;
    }
    if (data.startsWith("watch_scan:")) {
      const watchId = Number(data.split(":")[1] || 0);
      const row = await get(`SELECT * FROM watchlist WHERE id = ? AND chat_id = ?`, [watchId, String(chatId)]);
      if (row) {
        await answerCb(query.id, "Scanning watchlist token");
        await runScanAndRespond(chatId, row.contract_address || row.query, false);
      } else {
        await answerCb(query.id, "Not found");
      }
      return;
    }
    if (data.startsWith("watch_remove:")) {
      const watchId = Number(data.split(":")[1] || 0);
      await removeWatchlist(chatId, watchId);
      await answerCb(query.id, "Removed");
      await sendWatchlist(chatId);
      return;
    }
    await answerCb(query.id);
  } catch (err) {
    console.error("callback_query error:", err.message);
    await answerCb(query.id, "Something went wrong");
  }
});
process.on("SIGINT", () => {
  console.log("Shutting down...");
  db.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  db.close();
  process.exit(0);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
async function bootstrap() {
  await initDb();
  try {
    await bot.deleteWebHook();
    console.log("Webhook cleared");
  } catch (err) {
  }
    console.error("Webhook clear warning:", err.message);
  console.log("GorKtimus New Update booting...");
  monitorWatchlistLoop().catch((err) => console.error("watchlist loop fatal:", err.message));
  monitorWalletLoop().catch((err) => console.error("wallet loop fatal:", err.message));
}
bootstrap().catch((err) => {
  console.error("Fatal bootstrap error:", err);
  process.exit(1);
})
