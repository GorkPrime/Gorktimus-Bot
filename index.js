const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// ================= ENV =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COMMUNITY_X_URL =
  process.env.COMMUNITY_X_URL || "https://x.com/gorktimusprime";
const COMMUNITY_TELEGRAM_URL =
  process.env.COMMUNITY_TELEGRAM_URL || "https://t.me/gorktimusprimezone";

// IMPORTANT:
// This must be the Telegram channel/group username like @gorktimusprimezone
// OR a numeric chat id like -1001234567890
// DO NOT put the invite link here.
const REQUIRED_CHANNEL =
  process.env.REQUIRED_CHANNEL || "@gorktimusprimezone";

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// ================= CONFIG =================
const TERMINAL_IMG = path.join(__dirname, "assets", "gorktimus_terminal.png");
const DB_PATH = path.join(__dirname, "gorktimus.db");

const SUPPORTED_CHAINS = ["solana", "base", "ethereum"];
const PRIME_MIN_LIQ_USD = 30000;
const PRIME_MIN_VOL_USD = 20000;
const PRIME_MIN_AGE_MIN = 30;

const LAUNCH_MIN_LIQ_USD = 5000;
const LAUNCH_MIN_VOL_USD = 1000;

const WALLET_SCAN_INTERVAL_MS = 20000;
const DEX_TIMEOUT_MS = 15000;
const HELIUS_TIMEOUT_MS = 20000;
const TELEGRAM_SEND_RETRY_MS = 900;
const WATCHLIST_SCAN_INTERVAL_MS = 180000;
const WATCHLIST_ALERT_COOLDOWN_SEC = 1800;
const MAX_WATCHLIST_ITEMS = 30;

const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
const HONEYPOT_API_BASE = "https://api.honeypot.is";

const EVM_CHAIN_IDS = {
  ethereum: 1,
  base: 8453
};

// ================= GLOBALS =================
const db = new sqlite3.Database(DB_PATH);
const pendingAction = new Map();
let bot = null;
let walletScanInterval = null;
let watchlistScanInterval = null;
let walletScanRunning = false;
let shuttingDown = false;
let BOT_USERNAME = "";

// ================= DB HELPERS =================
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {await run(`
  CREATE TABLE IF NOT EXISTS user_activity (
    user_id TEXT,
    ts INTEGER
  )
`);

await run(`
  CREATE TABLE IF NOT EXISTS scan_logs (
    user_id TEXT,
    ts INTEGER
  )
`);
  await run(`
    CREATE TABLE IF NOT EXISTS wallet_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      label_type TEXT NOT NULL,
      nickname TEXT,
      chain_id TEXT DEFAULT 'solana',
      active INTEGER DEFAULT 1,
      alerts_enabled INTEGER DEFAULT 1,
      last_signature TEXT,
      last_seen_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, wallet, label_type)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      chat_id TEXT,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_subscribed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      mode TEXT DEFAULT 'balanced',
      alerts_enabled INTEGER DEFAULT 1,
      launch_alerts INTEGER DEFAULT 1,
      smart_alerts INTEGER DEFAULT 1,
      risk_alerts INTEGER DEFAULT 1,
      whale_alerts INTEGER DEFAULT 1,
      explanation_level TEXT DEFAULT 'deep',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      symbol TEXT,
      pair_address TEXT,
      active INTEGER DEFAULT 1,
      alerts_enabled INTEGER DEFAULT 1,
      added_price REAL DEFAULT 0,
      last_price REAL DEFAULT 0,
      last_liquidity REAL DEFAULT 0,
      last_volume REAL DEFAULT 0,
      last_score INTEGER DEFAULT 0,
      last_alert_ts INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, chain_id, token_address)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS pair_memory (
      memory_key TEXT PRIMARY KEY,
      learned_bias REAL DEFAULT 0,
      positive_events INTEGER DEFAULT 0,
      negative_events INTEGER DEFAULT 0,
      last_outcome TEXT,
      last_price REAL DEFAULT 0,
      last_liquidity REAL DEFAULT 0,
      last_volume REAL DEFAULT 0,
      last_seen_at INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS scan_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      chain_id TEXT,
      token_address TEXT,
      pair_address TEXT,
      symbol TEXT,
      feedback TEXT,
      score_snapshot INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
}

// ================= HELPERS =================
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, num(value)));
}
function shortUsd(n) {
  const x = num(n);
  if (x >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(8)}`;
}

function shortAddr(value, len = 6) {
  const s = String(value || "");
  if (s.length <= len * 2 + 3) return s;
  return `${s.slice(0, len)}...${s.slice(-len)}`;
}

function clip(value, len = 28) {
  const s = String(value || "");
  if (s.length <= len) return s;
  return `${s.slice(0, len - 1)}…`;
}

function toPct(value, digits = 2) {
  return `${num(value).toFixed(digits)}%`;
}

function sum(arr = []) {
  return arr.reduce((a, b) => a + num(b), 0);
}

function isAddressLike(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) || /^0x[a-fA-F0-9]{40}$/.test(t);
}

function isLikelySolanaWallet(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t);
}

function hasHelius() {
  return !!HELIUS_API_KEY;
}

function hasEtherscanKey() {
  return !!ETHERSCAN_API_KEY;
}

function supportsChain(chainId) {
  return SUPPORTED_CHAINS.includes(String(chainId || "").toLowerCase());
}

function isEvmChain(chainId) {
  const c = String(chainId || "").toLowerCase();
  return c === "ethereum" || c === "base";
}

function humanChain(chainId) {
  const c = String(chainId || "").toLowerCase();
  if (c === "solana") return "Solana";
  if (c === "base") return "Base";
  if (c === "ethereum") return "Ethereum";
  return clip(c, 18) || "Unknown";
}

function buildGeneratedStamp() {
  return "Generated: just now";
}

function ageMinutesFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

function formatLaunchDate(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return "Unknown";
  const d = new Date(ms);
  return d.toLocaleString("en-US", {
    month: "short",
    year: "numeric"
  });
}

function ageFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return "N/A";

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffMin < 60) return `${diffMin}m`;
  if (diffHrs < 24) return `${diffHrs}h`;
  if (diffDays < 30) return `${diffDays}d`;

  return formatLaunchDate(createdAtMs);
}

function makeDexUrl(chainId, pairAddress, fallbackUrl = "") {
  if (fallbackUrl) return fallbackUrl;
  if (!chainId || !pairAddress) return "";
  return `https://dexscreener.com/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
}

function makeBirdeyeUrl(chainId, tokenAddress) {
  const chain = String(chainId || "").toLowerCase();
  const token = String(tokenAddress || "").trim();
  if (!token) return "";
  if (chain === "solana") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=solana`;
  }
  if (chain === "base") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=base`;
  }
  if (chain === "ethereum") {
    return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=ethereum`;
  }
  return "";
}

function makeGeckoUrl(chainId, pairAddress) {
  const chain = String(chainId || "").toLowerCase();
  const pair = String(pairAddress || "").trim();
  if (!pair) return "";
  if (chain === "solana") {
    return `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(pair)}`;
  }
  if (chain === "base") {
    return `https://www.geckoterminal.com/base/pools/${encodeURIComponent(pair)}`;
  }
  if (chain === "ethereum") {
    return `https://www.geckoterminal.com/eth/pools/${encodeURIComponent(pair)}`;
  }
  return "";
}

function getMsgChat(msgOrQuery) {
  return msgOrQuery?.message?.chat || msgOrQuery?.chat || null;
}

function isPrivateChat(msgOrQuery) {
  const chat = getMsgChat(msgOrQuery);
  return chat?.type === "private";
}

function buildBotDeepLink() {
  if (!BOT_USERNAME) return "";
  return `https://t.me/${BOT_USERNAME}`;
}

// ================= USER / SUBSCRIPTION =================
async function upsertUserFromMessage(msg, isSubscribed = 0) {
  const ts = nowTs();
  const userId = String(msg.from?.id || "");
  const chatId = String(msg.chat?.id || "");
  const username = msg.from?.username || "";
  const firstName = msg.from?.first_name || "";
  const lastName = msg.from?.last_name || "";

  if (!userId) return;

  await run(
    `
    INSERT INTO users (user_id, chat_id, username, first_name, last_name, is_subscribed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      is_subscribed = excluded.is_subscribed,
      updated_at = excluded.updated_at
    `,
    [userId, chatId, username, firstName, lastName, isSubscribed ? 1 : 0, ts, ts]
  );
}

async function setUserSubscription(userId, isSubscribed) {
  await run(
    `UPDATE users SET is_subscribed = ?, updated_at = ? WHERE user_id = ?`,
    [isSubscribed ? 1 : 0, nowTs(), String(userId)]
  );
}

async function getBotUserCount() {
  const row = await get(`SELECT COUNT(*) AS c FROM users`, []);
  return row?.c || 0;
}

async function getVerifiedSubscriberBotUsersCount() {
  const row = await get(`SELECT COUNT(*) AS c FROM users WHERE is_subscribed = 1`, []);
  return row?.c || 0;
}

async function getChannelSubscriberCount() {
  try {
    const count = await bot.getChatMemberCount(REQUIRED_CHANNEL);
    return count;
  } catch (err) {
    console.log("getChannelSubscriberCount error:", err.message);
    return null;
  }
}

function safeMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (["aggressive", "balanced", "guardian"].includes(m)) return m;
  return "balanced";
}

function modeTitle(mode) {
  const m = safeMode(mode);
  if (m === "aggressive") return "Aggressive";
  if (m === "guardian") return "Guardian";
  return "Balanced";
}

async function ensureUserSettings(userId) {
  const ts = nowTs();
  await run(
    `INSERT OR IGNORE INTO user_settings (user_id, created_at, updated_at) VALUES (?, ?, ?)`,
    [String(userId), ts, ts]
  );
}

async function getUserSettings(userId) {
  await ensureUserSettings(userId);
  const row = await get(`SELECT * FROM user_settings WHERE user_id = ?`, [String(userId)]);
  return row || {
    user_id: String(userId),
    mode: "balanced",
    alerts_enabled: 1,
    launch_alerts: 1,
    smart_alerts: 1,
    risk_alerts: 1,
    whale_alerts: 1,
    explanation_level: "deep"
  };
}

async function setUserSetting(userId, field, value) {
  const allowed = new Set([
    "mode",
    "alerts_enabled",
    "launch_alerts",
    "smart_alerts",
    "risk_alerts",
    "whale_alerts",
    "explanation_level"
  ]);
  if (!allowed.has(field)) throw new Error(`Invalid setting field: ${field}`);
  await ensureUserSettings(userId);
  await run(
    `UPDATE user_settings SET ${field} = ?, updated_at = ? WHERE user_id = ?`,
    [value, nowTs(), String(userId)]
  );
}

function getMemoryKey(pair) {
  const chain = String(pair?.chainId || '').toLowerCase();
  const token = String(pair?.baseAddress || pair?.pairAddress || '').toLowerCase();
  return `${chain}:${token}`;
}

async function getPairMemory(pair) {
  const key = getMemoryKey(pair);
  const row = await get(`SELECT * FROM pair_memory WHERE memory_key = ?`, [key]);
  return row || {
    memory_key: key,
    learned_bias: 0,
    positive_events: 0,
    negative_events: 0,
    last_outcome: "none",
    last_price: 0,
    last_liquidity: 0,
    last_volume: 0,
    last_seen_at: 0
  };
}

async function savePairMemorySnapshot(pair, verdictScore = null) {
  const key = getMemoryKey(pair);
  const old = await getPairMemory(pair);
  const price = num(pair?.priceUsd);
  const liquidity = num(pair?.liquidityUsd);
  const volume = num(pair?.volumeH24);
  let learnedBias = num(old.learned_bias);
  let positive = num(old.positive_events);
  let negative = num(old.negative_events);
  let outcome = old.last_outcome || "none";

  if (num(old.last_seen_at) > 0) {
    const priceDelta = old.last_price > 0 ? ((price - old.last_price) / old.last_price) * 100 : 0;
    const liqDelta = old.last_liquidity > 0 ? ((liquidity - old.last_liquidity) / old.last_liquidity) * 100 : 0;
    const volDelta = old.last_volume > 0 ? ((volume - old.last_volume) / old.last_volume) * 100 : 0;

    let signal = 0;
    if (priceDelta >= 8) signal += 1;
    if (liqDelta >= 10) signal += 1;
    if (volDelta >= 15) signal += 1;
    if (priceDelta <= -12) signal -= 1;
    if (liqDelta <= -18) signal -= 1;

    if (signal >= 2) {
      learnedBias = Math.min(8, learnedBias + 1.25);
      positive += 1;
      outcome = "improving";
    } else if (signal <= -2) {
      learnedBias = Math.max(-10, learnedBias - 1.5);
      negative += 1;
      outcome = "weakening";
    }
  }

  await run(
    `INSERT INTO pair_memory (memory_key, learned_bias, positive_events, negative_events, last_outcome, last_price, last_liquidity, last_volume, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_key) DO UPDATE SET
       learned_bias = excluded.learned_bias,
       positive_events = excluded.positive_events,
       negative_events = excluded.negative_events,
       last_outcome = excluded.last_outcome,
       last_price = excluded.last_price,
       last_liquidity = excluded.last_liquidity,
       last_volume = excluded.last_volume,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
    [key, learnedBias, positive, negative, outcome, price, liquidity, volume, nowTs(), nowTs()]
  );

  return { learnedBias, positive, negative, outcome, verdictScore };
}

async function addScanFeedback(userId, pair, feedback, scoreSnapshot = 0) {
  await run(
    `INSERT INTO scan_feedback (user_id, chain_id, token_address, pair_address, symbol, feedback, score_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(userId),
      String(pair?.chainId || ''),
      String(pair?.baseAddress || ''),
      String(pair?.pairAddress || ''),
      String(pair?.baseSymbol || ''),
      String(feedback || ''),
      num(scoreSnapshot),
      nowTs()
    ]
  );

  const current = await getPairMemory(pair);
  let learnedBias = num(current.learned_bias);
  let positive = num(current.positive_events);
  let negative = num(current.negative_events);
  let outcome = current.last_outcome || 'none';

  if (feedback === 'good') {
    learnedBias = Math.min(10, learnedBias + 2);
    positive += 1;
    outcome = 'user_confirmed_good';
  } else if (feedback === 'bad') {
    learnedBias = Math.max(-12, learnedBias - 2.5);
    negative += 1;
    outcome = 'user_confirmed_bad';
  }

  await run(
    `INSERT INTO pair_memory (memory_key, learned_bias, positive_events, negative_events, last_outcome, last_price, last_liquidity, last_volume, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_key) DO UPDATE SET
       learned_bias = excluded.learned_bias,
       positive_events = excluded.positive_events,
       negative_events = excluded.negative_events,
       last_outcome = excluded.last_outcome,
       updated_at = excluded.updated_at`,
    [getMemoryKey(pair), learnedBias, positive, negative, outcome, num(current.last_price), num(current.last_liquidity), num(current.last_volume), num(current.last_seen_at), nowTs()]
  );
}

async function addWatchlistItem(chatId, pair) {
  const ts = nowTs();
  await run(
    `INSERT INTO watchlist (chat_id, chain_id, token_address, symbol, pair_address, active, alerts_enabled, added_price, last_price, last_liquidity, last_volume, last_score, last_alert_ts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(chat_id, chain_id, token_address) DO UPDATE SET
       symbol = excluded.symbol,
       pair_address = excluded.pair_address,
       last_price = excluded.last_price,
       last_liquidity = excluded.last_liquidity,
       last_volume = excluded.last_volume,
       updated_at = excluded.updated_at,
       active = 1`,
    [
      String(chatId),
      String(pair.chainId || ''),
      String(pair.baseAddress || ''),
      String(pair.baseSymbol || ''),
      String(pair.pairAddress || ''),
      num(pair.priceUsd),
      num(pair.priceUsd),
      num(pair.liquidityUsd),
      num(pair.volumeH24),
      ts,
      ts
    ]
  );
}

async function removeWatchlistItem(chatId, chainId, tokenAddress) {
  await run(`DELETE FROM watchlist WHERE chat_id = ? AND chain_id = ? AND token_address = ?`, [String(chatId), String(chainId), String(tokenAddress)]);
}

async function getWatchlistItems(chatId) {
  return await all(
    `SELECT * FROM watchlist WHERE chat_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT ?`,
    [String(chatId), MAX_WATCHLIST_ITEMS]
  );
}

async function getWatchlistCount(chatId) {
  const row = await get(`SELECT COUNT(*) AS c FROM watchlist WHERE chat_id = ? AND active = 1`, [String(chatId)]);
  return row?.c || 0;
}

function buildWatchlistItemCallback(chainId, tokenAddress) {
  return `watch_open:${String(chainId)}:${String(tokenAddress)}`;
}

function explainBias(memory) {
  const bias = num(memory?.learned_bias);
  if (bias >= 5) return "Adaptive memory strongly positive";
  if (bias >= 2) return "Adaptive memory slightly positive";
  if (bias <= -5) return "Adaptive memory strongly negative";
  if (bias <= -2) return "Adaptive memory slightly negative";
  return "Adaptive memory neutral";
}

async function isUserSubscribed(userId) {
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    const ok = ["member", "administrator", "creator"].includes(member.status);
    await setUserSubscription(userId, ok);
    return ok;
  } catch (err) {
    console.log(`isUserSubscribed error for ${userId}:`, err.message);
    await setUserSubscription(userId, 0).catch(() => {});
    return false;
  }
}

function buildSubscriptionGate() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Join Channel", url: COMMUNITY_TELEGRAM_URL }],
        [{ text: "✅ I Joined / Check Again", callback_data: "check_subscription" }]
      ]
    }
  };
}

async function showSubscriptionRequired(chatId) {
  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🚫 <b>Access Locked</b>\n\nYou must join the official channel before using the bot.\n\nRequired channel: <b>${escapeHtml(
      REQUIRED_CHANNEL
    )}</b>`,
    buildSubscriptionGate()
  );
}

async function ensureSubscribedOrBlock(msgOrQuery) {
  const from = msgOrQuery.from;
  const chatId = msgOrQuery.message?.chat?.id || msgOrQuery.chat?.id;
  if (!from?.id || !chatId) return false;

  const ok = await isUserSubscribed(from.id);
  if (!ok) {
    await showSubscriptionRequired(chatId);
    return false;
  }
  return true;
}

// ================= MENUS =================
function buildMainMenu() {
  const growthRow = BOT_USERNAME
    ? [{ text: "🚀 Invite Friends", callback_data: "invite_friends" }]
    : [];

  const keyboard = [
    [
      { text: "🔎 Scan Token", callback_data: "scan_token" },
      { text: "📈 Trending", callback_data: "trending" }
    ],
    [
      { text: "📡 Launch Radar", callback_data: "launch_radar" },
      { text: "⭐ Prime Picks", callback_data: "prime_picks" }
    ],
    [
      { text: "👁 Watchlist", callback_data: "watchlist" },
      { text: "🧬 Mode Lab", callback_data: "mode_lab" }
    ],
    [
      { text: "🚨 Alert Center", callback_data: "alert_center" },
      { text: "🐋 Whale Tracker", callback_data: "whale_menu" }
    ],
    [
      { text: "🧠 Edge Brain", callback_data: "edge_brain" },
      { text: "❓ Help", callback_data: "help_menu" }
    ]
  ];

  if (growthRow.length) keyboard.push(growthRow);

  return {
    reply_markup: {
      inline_keyboard: keyboard
    }
  };
}

function buildHelpMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 System Status", callback_data: "help_status" }],
        [{ text: "📖 How To Use", callback_data: "help_how" }],
        [{ text: "⚙️ Data Sources", callback_data: "help_sources" }],
        [{ text: "💬 Contact / Community", callback_data: "help_community" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildWhaleMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Add Whale", callback_data: "add_whale" },
          { text: "📋 Whale List", callback_data: "whale_list" }
        ],
        [
          { text: "➕ Add Dev Wallet", callback_data: "add_dev" },
          { text: "📋 Dev List", callback_data: "dev_list" }
        ],
        [
          { text: "🔍 Check Wallet", callback_data: "check_wallet" },
          { text: "⚙️ Alert Settings", callback_data: "wallet_alert_settings" }
        ],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildModeMenu(currentMode) {
  const mode = safeMode(currentMode);
  const mark = (name, title) => ({
    text: mode === name ? `✅ ${title}` : title,
    callback_data: `set_mode:${name}`
  });
  return {
    reply_markup: {
      inline_keyboard: [
        [mark("aggressive", "A — Aggressive")],
        [mark("balanced", "B — Balanced")],
        [mark("guardian", "C — Guardian")],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildAlertCenterMenu(settings) {
  const mark = (v) => (num(v) ? "✅" : "❌");
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `${mark(settings.alerts_enabled)} Master Alerts`, callback_data: "toggle_setting:alerts_enabled" }],
        [
          { text: `${mark(settings.launch_alerts)} Launch Alerts`, callback_data: "toggle_setting:launch_alerts" },
          { text: `${mark(settings.smart_alerts)} Smart Alerts`, callback_data: "toggle_setting:smart_alerts" }
        ],
        [
          { text: `${mark(settings.risk_alerts)} Risk Alerts`, callback_data: "toggle_setting:risk_alerts" },
          { text: `${mark(settings.whale_alerts)} Whale Alerts`, callback_data: "toggle_setting:whale_alerts" }
        ],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildWatchlistMenu(rows) {
  const buttons = rows.slice(0, MAX_WATCHLIST_ITEMS).map((row) => [{
    text: `👁 ${clip(row.symbol || shortAddr(row.token_address, 6), 28)}`,
    callback_data: buildWatchlistItemCallback(row.chain_id, row.token_address)
  }]);
  buttons.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);
  return { reply_markup: { inline_keyboard: buttons } };
}

function buildWatchlistItemMenu(pair) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔁 Re-Scan", callback_data: `watch_rescan:${pair.chainId}:${pair.baseAddress}` }],
        [{ text: "❌ Remove", callback_data: `watch_remove:${pair.chainId}:${pair.baseAddress}` }],
        [
          { text: "👍 Good Call", callback_data: `feedback:good:${pair.chainId}:${pair.baseAddress}` },
          { text: "👎 Bad Call", callback_data: `feedback:bad:${pair.chainId}:${pair.baseAddress}` }
        ],
        [{ text: "👁 Watchlist", callback_data: "watchlist" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildScanActionButtons(pair) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "👁 Add Watchlist", callback_data: `watch_add:${pair.chainId}:${pair.baseAddress}` },
          { text: "🔎 Scan Another", callback_data: "scan_token" }
        ],
        [
          { text: "👍 Good Call", callback_data: `feedback:good:${pair.chainId}:${pair.baseAddress}` },
          { text: "👎 Bad Call", callback_data: `feedback:bad:${pair.chainId}:${pair.baseAddress}` }
        ],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildMainMenuOnlyButton() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "main_menu" }]]
    }
  };
}

function buildRefreshMainButtons(refreshCallback) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: refreshCallback }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildScanButtons() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔎 Scan Another", callback_data: "scan_token" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildWalletListMenu(rows, type) {
  const buttons = rows.map((row) => [
    {
      text: `${type === "whale" ? "🐋" : "👤"} ${clip(row.nickname || shortAddr(row.wallet, 6), 28)}`,
      callback_data: `wallet_item:${row.id}`
    }
  ]);

  buttons.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);

  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

function buildWalletItemMenu(row) {
  const toggleText = row.alerts_enabled ? "⛔ Alerts Off" : "✅ Alerts On";
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: toggleText, callback_data: `wallet_toggle:${row.id}` }],
        [{ text: "🔍 Check Now", callback_data: `wallet_check:${row.id}` }],
        [{ text: "✏️ Rename", callback_data: `wallet_rename:${row.id}` }],
        [{ text: "❌ Remove", callback_data: `wallet_remove:${row.id}` }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

// ================= TELEGRAM SENDERS =================
async function sendMessageWithRetry(chatId, text, opts, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await bot.sendMessage(chatId, text, opts);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const retryable =
        msg.includes("504") ||
        msg.includes("Gateway Timeout") ||
        msg.includes("429") ||
        msg.includes("Too Many Requests") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT");
      if (!retryable || i === attempts) throw err;
      await sleep(TELEGRAM_SEND_RETRY_MS * i);
    }
  }
  throw lastErr;
}

async function sendPhotoWithRetry(chatId, photo, opts, attempts = 2) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await bot.sendPhoto(chatId, photo, opts);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const retryable =
        msg.includes("504") ||
        msg.includes("Gateway Timeout") ||
        msg.includes("429") ||
        msg.includes("Too Many Requests") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT");
      if (!retryable || i === attempts) throw err;
      await sleep(TELEGRAM_SEND_RETRY_MS * i);
    }
  }
  throw lastErr;
}

async function answerCallbackSafe(queryId, text = "") {
  try {
    await bot.answerCallbackQuery(queryId, text ? { text } : {});
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("query is too old") || msg.includes("query ID is invalid")) return;
    console.log("callback answer failed:", msg);
  }
}

async function sendMenu(chatId, caption, keyboard) {
  const safeCaption =
    caption ||
    "🧠 <b>Gorktimus Intelligence Terminal</b>\n\nLive intelligence. Clean execution.";

  try {
    if (!fs.existsSync(TERMINAL_IMG)) {
      await sendMessageWithRetry(chatId, safeCaption, {
        ...keyboard,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
      return;
    }

    await sendPhotoWithRetry(chatId, fs.createReadStream(TERMINAL_IMG), {
      caption: safeCaption,
      ...keyboard,
      parse_mode: "HTML"
    });
  } catch (err) {
    console.log("sendMenu fallback:", err.message);
    await sendMessageWithRetry(chatId, safeCaption, {
      ...keyboard,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }
}

async function sendText(chatId, text, keyboard) {
  await sendMessageWithRetry(chatId, text, {
    ...keyboard,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendCard(chatId, text, keyboard = {}, imageUrl = "") {
  const safeText = text || "🧠 <b>Gorktimus Intelligence Terminal</b>";
  if (imageUrl) {
    try {
      await sendPhotoWithRetry(chatId, imageUrl, {
        caption: safeText,
        ...keyboard,
        parse_mode: "HTML"
      });
      return;
    } catch (err) {
      console.log("sendCard image fallback:", err.message);
    }
  }

  await sendText(chatId, safeText, keyboard);
}

// ================= DEX HELPERS =================
function rankPairQuality(pair) {
  return (
    num(pair.liquidity?.usd || pair.liquidityUsd) * 4 +
    num(pair.volume?.h24 || pair.volumeH24) * 2 +
    num(pair.marketCap) +
    num(pair.txns?.m5?.buys || pair.buysM5) * 250 -
    num(pair.txns?.m5?.sells || pair.sellsM5) * 100
  );
}

function normalizePair(pair) {
  if (!pair) return null;
  return {
    chainId: String(pair.chainId || ""),
    dexId: String(pair.dexId || ""),
    pairAddress: String(pair.pairAddress || ""),
    pairCreatedAt: num(pair.pairCreatedAt || 0),
    baseSymbol: String(pair.baseToken?.symbol || pair.baseSymbol || ""),
    baseName: String(pair.baseToken?.name || pair.baseName || ""),
    baseAddress: String(pair.baseToken?.address || pair.baseAddress || ""),
    quoteSymbol: String(pair.quoteToken?.symbol || ""),
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(pair.liquidity?.usd || pair.liquidityUsd),
    volumeH24: num(pair.volume?.h24 || pair.volumeH24),
    buysM5: num(pair.txns?.m5?.buys || pair.buysM5),
    sellsM5: num(pair.txns?.m5?.sells || pair.sellsM5),
    txnsM5:
      num(pair.txns?.m5?.buys || pair.buysM5) + num(pair.txns?.m5?.sells || pair.sellsM5),
    marketCap: num(pair.marketCap || pair.fdv || pair.market_cap),
    fdv: num(pair.fdv),
    url: String(pair.url || ""),
    imageUrl: String(
      pair.info?.imageUrl ||
        pair.info?.iconUrl ||
        pair.imageUrl ||
        pair.icon ||
        ""
    )
  };
}

async function safeGet(url, timeout = DEX_TIMEOUT_MS) {
  const res = await axios.get(url, { timeout });
  return res.data;
}

async function rpcPost(url, body, timeout = HELIUS_TIMEOUT_MS) {
  const res = await axios.post(url, body, {
    timeout,
    headers: { "Content-Type": "application/json" }
  });
  return res.data;
}

async function searchDexPairs(query) {
  const data = await safeGet(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`
  );
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  return pairs.map(normalizePair).filter((p) => p && supportsChain(p.chainId));
}

async function fetchPairsByToken(chainId, tokenAddress) {
  const data = await safeGet(
    `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(
      tokenAddress
    )}`
  );
  const pairs = Array.isArray(data) ? data : [];
  return pairs.map(normalizePair).filter((p) => p && supportsChain(p.chainId));
}

async function resolveBestPair(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  if (isAddressLike(q)) {
    const chainCandidates = q.startsWith("0x") ? ["base", "ethereum"] : ["solana"];
    const byTokenResults = [];

    for (const chainId of chainCandidates) {
      try {
        const pairs = await fetchPairsByToken(chainId, q);
        byTokenResults.push(...pairs);
      } catch (err) {
        console.log("resolveBestPair token route warning:", err.message);
      }
    }

    if (byTokenResults.length) {
      return byTokenResults.sort((a, b) => rankPairQuality(b) - rankPairQuality(a))[0];
    }
  }

  try {
    const pairs = await searchDexPairs(q);
    if (!pairs.length) return null;

    const lowered = q.toLowerCase();
    return pairs
      .sort((a, b) => {
        const exactA = String(a.baseSymbol || "").toLowerCase() === lowered;
        const exactB = String(b.baseSymbol || "").toLowerCase() === lowered;
        if (exactA !== exactB) return exactB - exactA;
        return rankPairQuality(b) - rankPairQuality(a);
      })[0];
  } catch (err) {
    console.log("resolveBestPair search route error:", err.message);
    return null;
  }
}

async function fetchLatestProfiles() {
  try {
    const data = await safeGet("https://api.dexscreener.com/token-profiles/latest/v1");
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.log("fetchLatestProfiles error:", err.message);
    return [];
  }
}

async function fetchLatestBoosts() {
  try {
    const data = await safeGet("https://api.dexscreener.com/token-boosts/latest/v1");
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.log("fetchLatestBoosts error:", err.message);
    return [];
  }
}

async function fetchTokenOrders(chainId, tokenAddress) {
  try {
    const data = await safeGet(
      `https://api.dexscreener.com/orders/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(
        tokenAddress
      )}`
    );
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function resolveTokenToBestPair(chainId, tokenAddress) {
  try {
    const pairs = await fetchPairsByToken(chainId, tokenAddress);
    if (!pairs.length) return null;
    return pairs.sort((a, b) => rankPairQuality(b) - rankPairQuality(a))[0];
  } catch (err) {
    console.log("resolveTokenToBestPair error:", err.message);
    return null;
  }
}

async function fetchTokenProfileImage(chainId, tokenAddress, fallbackPair = null) {
  try {
    if (fallbackPair?.imageUrl) return fallbackPair.imageUrl;

    const profiles = await fetchLatestProfiles();
    const hit = profiles.find(
      (x) =>
        String(x?.chainId || "").toLowerCase() === String(chainId || "").toLowerCase() &&
        String(x?.tokenAddress || "") === String(tokenAddress || "")
    );

    if (!hit) return "";
    return String(hit.icon || hit.imageUrl || hit.header || "");
  } catch (err) {
    console.log("fetchTokenProfileImage error:", err.message);
    return "";
  }
}

// ================= CHAIN INTELLIGENCE =================
async function fetchHeliusTokenLargestAccounts(mintAddress) {
  if (!hasHelius() || !mintAddress) return [];

  try {
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_API_KEY)}`;
    const data = await rpcPost(rpcUrl, {
      jsonrpc: "2.0",
      id: "gork-largest-accounts",
      method: "getTokenLargestAccounts",
      params: [mintAddress]
    });

    const rows = Array.isArray(data?.result?.value) ? data.result.value : [];
    return rows.map((x) => ({
      address: String(x.address || ""),
      amountRaw: String(x.amount || "0"),
      uiAmount: num(x.uiAmountString ?? x.uiAmount ?? 0),
      decimals: num(x.decimals, 0)
    }));
  } catch (err) {
    console.log("fetchHeliusTokenLargestAccounts error:", err.message);
    return [];
  }
}

function analyzeSolanaHolderConcentration(largestAccounts = []) {
  if (!largestAccounts.length) {
    return {
      label: "Unknown",
      emoji: "⚠️",
      score: 6,
      top1Pct: 0,
      top5Pct: 0,
      top10Pct: 0,
      holdersKnown: 0,
      detail: "No holder concentration data returned"
    };
  }

  const balances = largestAccounts.map((x) => num(x.uiAmount));
  const totalTop20 = sum(balances);

  if (totalTop20 <= 0) {
    return {
      label: "Unknown",
      emoji: "⚠️",
      score: 6,
      top1Pct: 0,
      top5Pct: 0,
      top10Pct: 0,
      holdersKnown: largestAccounts.length,
      detail: "Largest accounts returned zeroed balances"
    };
  }

  const top1Pct = (sum(balances.slice(0, 1)) / totalTop20) * 100;
  const top5Pct = (sum(balances.slice(0, 5)) / totalTop20) * 100;
  const top10Pct = (sum(balances.slice(0, 10)) / totalTop20) * 100;

  let label = "Moderate";
  let emoji = "⚠️";
  let score = 8;

  if (top1Pct >= 60 || top5Pct >= 90) {
    label = "Very High";
    emoji = "🚨";
    score = 1;
  } else if (top1Pct >= 35 || top5Pct >= 75) {
    label = "High";
    emoji = "⚠️";
    score = 4;
  } else if (top1Pct <= 15 && top5Pct <= 45) {
    label = "Lower";
    emoji = "✅";
    score = 14;
  }

  return {
    label,
    emoji,
    score,
    top1Pct,
    top5Pct,
    top10Pct,
    holdersKnown: largestAccounts.length,
    detail: `Top 1: ${toPct(top1Pct)} | Top 5: ${toPct(top5Pct)} | Top 10: ${toPct(top10Pct)}`
  };
async function fetchEvmHoneypot(address, chainId) {
  if (!address || !isEvmChain(chainId)) return null;

  try {
    const chain = String(chainId).toLowerCase();

    const res = await axios.get(`${HONEYPOT_API_BASE}/v2/IsHoneypot`, {
      timeout: DEX_TIMEOUT_MS,
      params: {
        address,
        chainID: EVM_CHAIN_IDS[chain]
      }
    });

    return res.data || null;
  } catch (err) {
    const status = err?.response?.status;

    if (status === 404) {
      return null;
    }

    console.log("fetchEvmHoneypot error:", err.message);
    return null;
  }
}
      }
    });

    return res.data || null;
  } catch (err) {
    console.log("fetchEvmHoneypot error:", err.message);
    return null;
  }
}

async function fetchEvmTopHolders(address, chainId) {
  if (!address || !isEvmChain(chainId)) return null;

  try {
    const chain = String(chainId).toLowerCase();
    const url = `${HONEYPOT_API_BASE}/v1/TopHolders`;

    const res = await axios.get(url, {
      timeout: DEX_TIMEOUT_MS,
      params: {
        address,
        chainID: EVM_CHAIN_IDS[chain]
      }
    });

    return res.data || null;
  } catch (err) {
    console.log("fetchEvmTopHolders error:", err.message);
    return null;
  }
}

function analyzeEvmTopHolders(data) {
  const totalSupply = num(data?.totalSupply);
  const holders = Array.isArray(data?.holders) ? data.holders : [];

  if (!holders.length || totalSupply <= 0) {
    return {
      label: "Unknown",
      emoji: "⚠️",
      score: 6,
      top1Pct: 0,
      top5Pct: 0,
      top10Pct: 0,
      holdersKnown: 0,
      detail: "No top holder data returned"
    };
  }

  const balances = holders.map((h) => num(h.balance));
  const top1Pct = (sum(balances.slice(0, 1)) / totalSupply) * 100;
  const top5Pct = (sum(balances.slice(0, 5)) / totalSupply) * 100;
  const top10Pct = (sum(balances.slice(0, 10)) / totalSupply) * 100;

  let label = "Moderate";
  let emoji = "⚠️";
  let score = 8;

  if (top1Pct >= 30 || top5Pct >= 70) {
    label = "High";
    emoji = "⚠️";
    score = 4;
  } else if (top1Pct <= 10 && top5Pct <= 30) {
    label = "Lower";
    emoji = "✅";
    score = 14;
  }

  return {
    label,
    emoji,
    score,
    top1Pct,
    top5Pct,
    top10Pct,
    holdersKnown: holders.length,
    detail: `Top 1: ${toPct(top1Pct)} | Top 5: ${toPct(top5Pct)} | Top 10: ${toPct(top10Pct)}`
  };
}async function fetchHeliusTokenLargestAccounts(mintAddress) {
  if (!hasHelius() || !mintAddress) {
    throw new Error("Helius unavailable or mint missing");
  }

  return retryOperation(
    "helius-largest-accounts",
    async () => {
      const res = await axios.post(
        `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        {
          jsonrpc: "2.0",
          id: "gorktimus-largest-accounts",
          method: "getTokenLargestAccounts",
          params: [mintAddress]
        },
        {
          timeout: HELIUS_TIMEOUT_MS,
          headers: { "Content-Type": "application/json" }
        }
      );

      const rows = res?.data?.result?.value;
      if (!Array.isArray(rows)) {
        throw new Error("Helius returned invalid largest accounts payload");
      }

      return rows;
    },
    {
      attempts: 7,
      baseDelay: 1200,
      maxDelay: 12000,
      backoff: 2,
      shouldRetry: (err) => {
        const status = err?.response?.status;
        return [408, 409, 425, 429, 500, 502, 503, 504].includes(status) ||
          err.code === "ECONNABORTED" ||
          err.code === "ENOTFOUND" ||
          err.code === "ETIMEDOUT";
      },
      onRetry: (err, attempt, delay) => {
        console.log(
          `fetchHeliusTokenLargestAccounts retry ${attempt} in ${delay}ms:`,
          err?.response?.status || err.message
        );
      }
    }
  );
}
async function fetchEvmSafetyComposite(address, chainId) {
  const errors = [];

  try {
    const honeypot = await fetchEvmHoneypot(address, chainId);
    return {
      source: "honeypot",
      data: honeypot
    };
  } catch (err) {
    errors.push(`honeypot:${err.message}`);
  }

  try {
    const goplus = await fetchGoPlusSecurity(address, chainId);
    return {
      source: "goplus",
      data: goplus
    };
  } catch (err) {
    errors.push(`goplus:${err.message}`);
  }
const providerHealth = {
  helius: { success: 0, fail: 0, cooldownUntil: 0 },
  honeypot: { success: 0, fail: 0, cooldownUntil: 0 },
  goplus: { success: 0, fail: 0, cooldownUntil: 0 }
};

function markProviderSuccess(name) {
  if (!providerHealth[name]) return;
  providerHealth[name].success += 1;
}{
  ok: false,
  source: "helius",
  error: "rate_limited"
}

function markProviderFail(name, err) {
  if (!providerHealth[name]) return;
  providerHealth[name].fail += 1;

  const status = err?.response?.status;
  if (status === 429) {
    providerHealth[name].cooldownUntil = Date.now() + 60 * 1000;
  }
}
if (!providerAvailable("helius")) {
  throw new Error("Helius temporarily cooling down");
}
function providerAvailable(name) {
  const p = providerHealth[name];
  if (!p) return true;
  return Date.now() >= p.cooldownUntil;
}
  try {
    const heuristic = await buildEvmHeuristicSafety(address, chainId);
    return {
      source: "heuristic",
      data: heuristic
    };
  } catch (err) {
    errors.push(`heuristic:${err.message}`);
  }

  throw new Error(`All EVM safety providers failed: ${errors.join(" | ")}`);
}
async function fetchEtherscanSourceCode(address, chainId) {
  if (!hasEtherscanKey() || !address || !isEvmChain(chainId)) return null;

  try {
    const chain = String(chainId).toLowerCase();
    const res = await axios.get(ETHERSCAN_V2_URL, {
      timeout: DEX_TIMEOUT_MS,
      params: {
        apikey: ETHERSCAN_API_KEY,
        chainid: String(EVM_CHAIN_IDS[chain]),
        module: "contract",
        action: "getsourcecode",
        address
      }
    });

    const result = Array.isArray(res.data?.result) ? res.data.result[0] : null;
    return result || null;
  } catch (err) {
    console.log("fetchEtherscanSourceCode error:", err.message);
    return null;
  }
}

// ================= GORKTIMUS RISK VERDICT =================
function getLiquidityHealth(liquidityUsd) {
  const liq = num(liquidityUsd);
  if (liq >= 100000) return { label: "Strong", emoji: "✅", score: 22 };
  if (liq >= 40000) return { label: "Healthy", emoji: "✅", score: 18 };
  if (liq >= 15000) return { label: "Moderate", emoji: "⚠️", score: 10 };
  if (liq > 0) return { label: "Weak", emoji: "⚠️", score: 4 };
  return { label: "Unknown", emoji: "⚠️", score: 0 };
}

function getAgeRisk(ageMin) {
  if (!ageMin) return { label: "Unknown", score: 0 };
  if (ageMin < 5) return { label: "Extremely Fresh", score: 2 };
  if (ageMin < 30) return { label: "Very Early", score: 5 };
  if (ageMin < 180) return { label: "Early", score: 10 };
  if (ageMin < 1440) return { label: "Developing", score: 14 };
  return { label: "Established", score: 18 };
}

function getFlowHealth(pair) {
  const buys = num(pair.buysM5);
  const sells = num(pair.sellsM5);
  const total = buys + sells;

  if (total === 0) return { label: "Limited Recent Flow", score: 4 };

  const ratio = buys / Math.max(sells, 1);

  if (ratio >= 2.5 && buys >= 10) return { label: "Strong Buy Pressure", score: 18 };
  if (ratio >= 1.3) return { label: "Positive Flow", score: 12 };
  if (ratio >= 0.85) return { label: "Mixed Flow", score: 7 };
  return { label: "Sell Pressure", score: 2 };
}

function getVolumeHealth(volumeH24) {
  const vol = num(volumeH24);
  if (vol >= 500000) return { label: "Strong", score: 18 };
  if (vol >= 100000) return { label: "Healthy", score: 14 };
  if (vol >= 25000) return { label: "Moderate", score: 8 };
  if (vol > 0) return { label: "Light", score: 4 };
  return { label: "Unknown", score: 0 };
}

function buildRecommendation(score, ageMin, pair, verdictMeta = {}) {
  const liq = num(pair.liquidityUsd);
  const buys = num(pair.buysM5);
  const sells = num(pair.sellsM5);

  if (verdictMeta.isHoneypot === true) {
    return "Avoid. Simulation and risk signals point to honeypot behavior.";
  }
  if (num(verdictMeta.sellTax) >= 25 || num(verdictMeta.buyTax) >= 25) {
    return "High caution. Token taxes are elevated and can crush exits.";
  }
  if (liq < 10000) {
    return "High risk. Liquidity is thin, so even small exits can hit price hard.";
  }
  if (verdictMeta.holderTop5Pct >= 75) {
    return "Caution. Supply looks concentrated, which increases dump and control risk.";
  }
  if (ageMin > 0 && ageMin < 10) {
    return "Ultra-early token. Watch closely before sizing in because conditions can change fast.";
  }
  if (sells > buys * 1.2) {
    return "Caution. Recent order flow leans bearish, so momentum is not yet convincing.";
  }
  if (score >= 75) {
    return "Stronger setup than most. Still use discipline, but current market structure looks healthier.";
  }
  if (score >= 55) {
    return "Proceed with caution. Some structure is there, but this still needs confirmation.";
  }
  return "Speculative setup. Treat this as a high-risk play until more data matures.";
}

async function buildRiskVerdict(pair, userId = null) {
  const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
  const liquidity = getLiquidityHealth(pair.liquidityUsd);
  const age = getAgeRisk(ageMin);
  const flow = getFlowHealth(pair);
  const volume = getVolumeHealth(pair.volumeH24);

  let transparencyLabel = "Unknown";
  let transparencyEmoji = "⚠️";
  let transparencyScore = 4;
  let transparencyDetail = "";

  let honeypotLabel = "Unknown";
  let honeypotEmoji = "⚠️";
  let honeypotScore = 6;
  let honeypotDetail = "";

  let holderLabel = "Unknown";
  let holderEmoji = "⚠️";
  let holderScore = 6;
  let holderDetail = "";

  let buyTax = null;
  let sellTax = null;
  let transferTax = null;
  let holderTop5Pct = 0;
  let isHoneypot = null;

  const settings = userId ? await getUserSettings(userId) : { mode: "balanced" };
  const mode = safeMode(settings?.mode);
  const memory = await getPairMemory(pair);
  const chain = String(pair.chainId || "").toLowerCase();

  if (chain === "solana") {
    const largestAccounts = await fetchHeliusTokenLargestAccounts(pair.baseAddress);
    const holderInfo = analyzeSolanaHolderConcentration(largestAccounts);

    holderLabel = holderInfo.label;
    holderEmoji = holderInfo.emoji;
    holderScore = holderInfo.score;
    holderDetail = holderInfo.detail;
    holderTop5Pct = holderInfo.top5Pct;

    const orders = await fetchTokenOrders(pair.chainId, pair.baseAddress);
    const approvedCount = orders.filter((x) => x?.status === "approved").length;

    if (approvedCount >= 2) {
      transparencyLabel = "Better Signal";
      transparencyEmoji = "✅";
      transparencyScore = 14;
    } else if (approvedCount >= 1) {
      transparencyLabel = "Some Signal";
      transparencyEmoji = "⚠️";
      transparencyScore = 10;
    } else {
      transparencyLabel = "Limited";
      transparencyEmoji = "⚠️";
      transparencyScore = 5;
    }

    transparencyDetail = approvedCount
      ? `Dex order approvals detected: ${approvedCount}`
      : "No extra order approval signal detected";

    honeypotLabel = "Not Fully Testable";
    honeypotEmoji = "⚠️";
    honeypotScore = 8;
    honeypotDetail = "Solana honeypot simulation not fully supported in this stack yet";
  } else if (isEvmChain(chain)) {
    const [honeypotData, topHoldersData, etherscanData] = await Promise.all([
      fetchEvmHoneypot(pair.baseAddress, chain),
      fetchEvmTopHolders(pair.baseAddress, chain),
      fetchEtherscanSourceCode(pair.baseAddress, chain)
    ]);

    if (honeypotData?.summary) {
      const risk = String(honeypotData.summary.risk || "").toLowerCase();
      const riskLevel = num(honeypotData.summary.riskLevel, 0);
      isHoneypot = honeypotData?.honeypotResult?.isHoneypot === true;

      buyTax = honeypotData?.simulationResult?.buyTax ?? null;
      sellTax = honeypotData?.simulationResult?.sellTax ?? null;
      transferTax = honeypotData?.simulationResult?.transferTax ?? null;

      if (isHoneypot || risk === "honeypot" || riskLevel >= 90) {
        honeypotLabel = "Detected";
        honeypotEmoji = "🚨";
        honeypotScore = 0;
      } else if (riskLevel >= 60) {
        honeypotLabel = `High Risk (${risk || "high"})`;
        honeypotEmoji = "⚠️";
        honeypotScore = 2;
      } else if (riskLevel >= 20) {
        honeypotLabel = `Medium Risk (${risk || "medium"})`;
        honeypotEmoji = "⚠️";
        honeypotScore = 6;
      } else {
        honeypotLabel = `Clearer (${risk || "low"})`;
        honeypotEmoji = "✅";
        honeypotScore = 14;
      }

      const taxBits = [];
      if (buyTax !== null) taxBits.push(`Buy tax: ${buyTax}%`);
      if (sellTax !== null) taxBits.push(`Sell tax: ${sellTax}%`);
      if (transferTax !== null) taxBits.push(`Transfer tax: ${transferTax}%`);
      honeypotDetail = taxBits.join(" | ");

      if (num(sellTax) >= 30 || num(buyTax) >= 30) {
        honeypotScore = Math.min(honeypotScore, 2);
      } else if (num(sellTax) >= 15 || num(buyTax) >= 15) {
        honeypotScore = Math.min(honeypotScore, 6);
      }
    } else {
      honeypotLabel = "Unavailable";
      honeypotEmoji = "⚠️";
      honeypotScore = 5;
      honeypotDetail = "No honeypot simulation response returned";
    }

    const holderInfo = analyzeEvmTopHolders(topHoldersData);
    holderLabel = holderInfo.label;
    holderEmoji = holderInfo.emoji;
    holderScore = holderInfo.score;
    holderDetail = holderInfo.detail;
    holderTop5Pct = holderInfo.top5Pct;

    if (honeypotData?.contractCode) {
      const code = honeypotData.contractCode;
      const openSource = code.openSource === true || code.rootOpenSource === true;
      const proxyRisk = code.hasProxyCalls === true || code.isProxy === true;

      if (openSource && !proxyRisk) {
        transparencyLabel = "Verified Open Source";
        transparencyEmoji = "✅";
        transparencyScore = 16;
      } else if (openSource && proxyRisk) {
        transparencyLabel = "Open Source + Proxy";
        transparencyEmoji = "⚠️";
        transparencyScore = 10;
      } else {
        transparencyLabel = "Closed / Limited";
        transparencyEmoji = "⚠️";
        transparencyScore = 3;
      }

      transparencyDetail = [
        `Open source: ${openSource ? "yes" : "no"}`,
        `Proxy path: ${proxyRisk ? "yes" : "no"}`
      ].join(" | ");
    } else if (etherscanData) {
      const sourceCode = String(etherscanData.SourceCode || "").trim();
      const abi = String(etherscanData.ABI || "").trim();
      const implementation = String(etherscanData.Implementation || "").trim();
      const proxy = String(etherscanData.Proxy || "0").trim() === "1";

      const hasSource = !!sourceCode && sourceCode !== "0";
      const hasAbi = !!abi && abi !== "Contract source code not verified";

      if (hasSource || hasAbi) {
        transparencyLabel = proxy ? "Verified + Proxy" : "Verified";
        transparencyEmoji = proxy ? "⚠️" : "✅";
        transparencyScore = proxy ? 11 : 15;
      } else {
        transparencyLabel = "Unverified";
        transparencyEmoji = "⚠️";
        transparencyScore = 3;
      }

      transparencyDetail = [
        `Source: ${hasSource ? "yes" : "no"}`,
        `ABI: ${hasAbi ? "yes" : "no"}`,
        `Proxy: ${proxy || implementation ? "yes" : "no"}`
      ].join(" | ");
    } else {
      transparencyLabel = hasEtherscanKey() ? "Unavailable" : "No Etherscan Key";
      transparencyEmoji = "⚠️";
      transparencyScore = hasEtherscanKey() ? 4 : 2;
      transparencyDetail = hasEtherscanKey()
        ? "Explorer verification response unavailable"
        : "Set ETHERSCAN_API_KEY for contract verification fallback";
    }
  }

  let rawScore =
    liquidity.score +
    age.score +
    flow.score +
    volume.score +
    transparencyScore +
    honeypotScore +
    holderScore;

  if (mode === "aggressive") {
    rawScore += ageMin > 0 && ageMin < 120 ? 6 : 0;
    rawScore += num(pair.buysM5) > num(pair.sellsM5) ? 4 : 0;
    rawScore -= num(pair.liquidityUsd) < 15000 ? 2 : 0;
  } else if (mode === "guardian") {
    rawScore -= num(pair.liquidityUsd) < 25000 ? 6 : 0;
    rawScore -= holderTop5Pct >= 70 ? 8 : 0;
    rawScore -= isHoneypot === true ? 12 : 0;
    rawScore -= ageMin > 0 && ageMin < 30 ? 4 : 0;
  }

  rawScore += clamp(num(memory.learned_bias), -12, 10);
  rawScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  const recommendation = buildRecommendation(rawScore, ageMin, pair, {
    isHoneypot,
    buyTax,
    sellTax,
    transferTax,
    holderTop5Pct
  });

  return {
    honeypot: `${honeypotEmoji} ${honeypotLabel}`,
    transparency: `${transparencyEmoji} ${transparencyLabel}`,
    holders: `${holderEmoji} ${holderLabel}`,
    liquidity: `${liquidity.emoji} ${liquidity.label}`,
    score: rawScore,
    recommendation,
    buyTax,
    sellTax,
    transferTax,
    holderDetail,
    transparencyDetail,
    honeypotDetail,
    memoryBias: num(memory.learned_bias),
    memoryNote: explainBias(memory),
    modeTitle: modeTitle(mode)
  };
}

// ================= CARD BUILDERS =================
function buildSourceLines(pair) {
  const dex = makeDexUrl(pair.chainId, pair.pairAddress, pair.url);
  const bird = makeBirdeyeUrl(pair.chainId, pair.baseAddress);
  const gecko = makeGeckoUrl(pair.chainId, pair.pairAddress);

  const lines = [];
  if (dex) lines.push(`🔗 DexScreener: ${escapeHtml(dex)}`);
  if (bird) lines.push(`🔗 Birdeye: ${escapeHtml(bird)}`);
  if (gecko) lines.push(`🔗 GeckoTerminal: ${escapeHtml(gecko)}`);
  return lines;
}

function clickableAddressLine(pair) {
  const dex = makeDexUrl(pair.chainId, pair.pairAddress, pair.url);
  const addrText = escapeHtml(shortAddr(pair.baseAddress || pair.pairAddress || "", 8));
  if (!dex) return `📍 Address: ${addrText}`;
  return `📍 Address: <a href="${dex}">${addrText}</a>`;
}

async function buildScanCard(pair, title = "🔎 Token Scan", userId = null) {
  const ageLabel = ageFromMs(pair.pairCreatedAt);
  const verdict = await buildRiskVerdict(pair, userId);

  const lines = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `<b>${escapeHtml(title)}</b> | ${buildGeneratedStamp()}`,
    ``,
    `🪙 <b>Token:</b> ${escapeHtml(pair.baseSymbol || "Unknown")} ${
      pair.baseName ? `(${escapeHtml(pair.baseName)})` : ""
    }`,
    `⛓️ <b>Chain:</b> ${escapeHtml(humanChain(pair.chainId))}`,
    `⏱️ <b>Age:</b> ${escapeHtml(ageLabel)}`,
    ``,
    `🧠 <b>Gorktimus Risk Verdict</b>`,
    `⚠️ <b>Honeypot Check:</b> ${escapeHtml(verdict.honeypot)}`,
    `🔍 <b>Contract Transparency:</b> ${escapeHtml(verdict.transparency)}`,
    `👥 <b>Holder Concentration:</b> ${escapeHtml(verdict.holders)}`,
    `💧 <b>Liquidity Health:</b> ${escapeHtml(verdict.liquidity)}`,
    ``,
    verdict.buyTax !== null || verdict.sellTax !== null || verdict.transferTax !== null
      ? `🧾 <b>Taxes:</b> Buy ${escapeHtml(
          verdict.buyTax !== null ? `${verdict.buyTax}%` : "N/A"
        )} | Sell ${escapeHtml(
          verdict.sellTax !== null ? `${verdict.sellTax}%` : "N/A"
        )} | Transfer ${escapeHtml(
          verdict.transferTax !== null ? `${verdict.transferTax}%` : "N/A"
        )}`
      : "",
    verdict.honeypotDetail ? `🧪 <b>Simulation:</b> ${escapeHtml(verdict.honeypotDetail)}` : "",
    verdict.holderDetail ? `📦 <b>Holder Detail:</b> ${escapeHtml(verdict.holderDetail)}` : "",
    verdict.transparencyDetail
      ? `📜 <b>Code Detail:</b> ${escapeHtml(verdict.transparencyDetail)}`
      : "",
    ``,
    `📊 <b>Safety Score:</b> ${escapeHtml(String(verdict.score))} / 100`,
    `🧬 <b>Mode:</b> ${escapeHtml(verdict.modeTitle || "Balanced")}`,
    `🧠 <b>Adaptive Memory:</b> ${escapeHtml(verdict.memoryNote || "Neutral")}`,
    `🧬 <b>Mode:</b> ${escapeHtml(verdict.modeTitle || "Balanced")}`,
    `🧠 <b>Adaptive Memory:</b> ${escapeHtml(verdict.memoryNote || "Neutral")}`,
    ``,
    `📢 <b>Recommendation:</b> ${escapeHtml(verdict.recommendation)}`,
    ``,
    `📈 <b>Market Data</b>`,
    `💲 <b>Price:</b> ${escapeHtml(shortUsd(pair.priceUsd))}`,
    `💧 <b>Liquidity:</b> ${escapeHtml(shortUsd(pair.liquidityUsd))}`,
    `📊 <b>Market Cap:</b> ${escapeHtml(shortUsd(pair.marketCap || pair.fdv))}`,
    `📈 <b>Volume 24h:</b> ${escapeHtml(shortUsd(pair.volumeH24))}`,
    ``,
    `🟢 <b>Buys:</b> ${escapeHtml(String(pair.buysM5))}`,
    `🔴 <b>Sells:</b> ${escapeHtml(String(pair.sellsM5))}`,
    `🔄 <b>Transactions:</b> ${escapeHtml(String(pair.txnsM5))}`,
    ``,
    clickableAddressLine(pair),
    ``,
    `🔗 <b>Data Sources</b>`,
    ...buildSourceLines(pair)
  ].filter(Boolean);

  return lines.join("\n");
}

function buildLaunchVerdict(pair) {
  const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
  if (!ageMin) return "🧠 Verdict: Data is still limited. Treat this launch carefully.";
  if (ageMin < 5) return "🧠 Verdict: This token is extremely fresh. Conditions can shift fast.";
  if (ageMin < 30) {
    return "🧠 Verdict: Early activity is forming. Liquidity and order flow should still be treated carefully.";
  }
  if (ageMin < 180) {
    return "🧠 Verdict: The launch has started to build a clearer profile, but it is still early.";
  }
  return "🧠 Verdict: This token has been trading long enough to show a more stable market profile than most fresh launches.";
}

async function buildLaunchCard(pair, rank = 0, userId = null) {
  const title = rank > 0 ? `📡 Launch Radar #${rank}` : "📡 Launch Radar";
  const verdict = await buildRiskVerdict(pair, userId);

  const lines = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `<b>${escapeHtml(title)}</b> | ${buildGeneratedStamp()}`,
    ``,
    `🪙 <b>Token:</b> ${escapeHtml(pair.baseSymbol || "Unknown")} ${
      pair.baseName ? `(${escapeHtml(pair.baseName)})` : ""
    }`,
    `⛓️ <b>Chain:</b> ${escapeHtml(humanChain(pair.chainId))}`,
    `⏱️ <b>Age:</b> ${escapeHtml(ageFromMs(pair.pairCreatedAt))}`,
    ``,
    `🧠 <b>Gorktimus Risk Verdict</b>`,
    `⚠️ <b>Honeypot Check:</b> ${escapeHtml(verdict.honeypot)}`,
    `🔍 <b>Contract Transparency:</b> ${escapeHtml(verdict.transparency)}`,
    `👥 <b>Holder Concentration:</b> ${escapeHtml(verdict.holders)}`,
    `💧 <b>Liquidity Health:</b> ${escapeHtml(verdict.liquidity)}`,
    ``,
    verdict.buyTax !== null || verdict.sellTax !== null || verdict.transferTax !== null
      ? `🧾 <b>Taxes:</b> Buy ${escapeHtml(
          verdict.buyTax !== null ? `${verdict.buyTax}%` : "N/A"
        )} | Sell ${escapeHtml(
          verdict.sellTax !== null ? `${verdict.sellTax}%` : "N/A"
        )} | Transfer ${escapeHtml(
          verdict.transferTax !== null ? `${verdict.transferTax}%` : "N/A"
        )}`
      : "",
    verdict.honeypotDetail ? `🧪 <b>Simulation:</b> ${escapeHtml(verdict.honeypotDetail)}` : "",
    verdict.holderDetail ? `📦 <b>Holder Detail:</b> ${escapeHtml(verdict.holderDetail)}` : "",
    verdict.transparencyDetail
      ? `📜 <b>Code Detail:</b> ${escapeHtml(verdict.transparencyDetail)}`
      : "",
    ``,
    `📊 <b>Safety Score:</b> ${escapeHtml(String(verdict.score))} / 100`,
    `🧬 <b>Mode:</b> ${escapeHtml(verdict.modeTitle || "Balanced")}`,
    `🧠 <b>Adaptive Memory:</b> ${escapeHtml(verdict.memoryNote || "Neutral")}`,
    ``,
    `📢 <b>Recommendation:</b> ${escapeHtml(verdict.recommendation)}`,
    ``,
    `📈 <b>Market Data</b>`,
    `💲 <b>Price:</b> ${escapeHtml(shortUsd(pair.priceUsd))}`,
    `💧 <b>Liquidity:</b> ${escapeHtml(shortUsd(pair.liquidityUsd))}`,
    `📊 <b>Market Cap:</b> ${escapeHtml(shortUsd(pair.marketCap || pair.fdv))}`,
    `📈 <b>Volume 24h:</b> ${escapeHtml(shortUsd(pair.volumeH24))}`,
    ``,
    `🟢 <b>Buys:</b> ${escapeHtml(String(pair.buysM5))}`,
    `🔴 <b>Sells:</b> ${escapeHtml(String(pair.sellsM5))}`,
    `🔄 <b>Transactions:</b> ${escapeHtml(String(pair.txnsM5))}`,
    ``,
    buildLaunchVerdict(pair),
    ``,
    clickableAddressLine(pair),
    ``,
    `🔗 <b>Data Sources</b>`,
    ...buildSourceLines(pair)
  ].filter(Boolean);

  return lines.join("\n");
}

function buildTrendingLine(pair, idx) {
  const dex = makeDexUrl(pair.chainId, pair.pairAddress, pair.url);
  return `${idx}️⃣ <b>${escapeHtml(pair.baseSymbol || "Unknown")}</b> | ${escapeHtml(
    humanChain(pair.chainId)
  )} | ⏱️ ${escapeHtml(ageFromMs(pair.pairCreatedAt))} | 💧 ${escapeHtml(
    shortUsd(pair.liquidityUsd)
  )} | 📈 ${escapeHtml(shortUsd(pair.volumeH24))} | 🟢 ${escapeHtml(
    String(pair.buysM5)
  )} | 🔴 ${escapeHtml(String(pair.sellsM5))}${dex ? ` | <a href="${dex}">DexScreener</a>` : ""}`;
}
// ================= GORKTIMUS NETWORK PULSE =================
async function trackUserActivity(userId) {
  await run(
    `INSERT INTO user_activity (user_id, ts) VALUES (?, ?)`,
    [String(userId), nowTs()]
  );
}

async function trackScan(userId) {
  await run(
    `INSERT INTO scan_logs (user_id, ts) VALUES (?, ?)`,
    [String(userId), nowTs()]
  );
}

async function getNetworkPulse() {
  const now = nowTs();
  const startOfDay = now - 86400;
  const liveWindow = now - 900; // 15 min

  const todayUsers = await get(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_activity WHERE ts >= ?`,
    [startOfDay]
  );

  const liveUsers = await get(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_activity WHERE ts >= ?`,
    [liveWindow]
  );

  const scansToday = await get(
    `SELECT COUNT(*) as c FROM scan_logs WHERE ts >= ?`,
    [startOfDay]
  );

  return `⚡ ${todayUsers?.c || 0} today • ${liveUsers?.c || 0} live • ${scansToday?.c || 0} scans`;
}
// ================= MARKET SCREENS =================
async function showMainMenu(chatId) {
  const pulse = await getNetworkPulse();

  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n${pulse}\n\nLive intelligence. On-demand execution.\nNo clutter. No spam.\n\nSelect an operation below.`,
    buildMainMenu()
  );
}

async function showHelpMenu(chatId) {
  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❓ <b>Help Center</b>\nEverything below pulls live data when requested.`,
    buildHelpMenu()
  );
}

async function showWhaleMenu(chatId) {
  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🐋 <b>Whale Tracker</b>\nTrack named wallets and monitor movement on demand or by wallet alerts.`,
    buildWhaleMenu()
  );
}

async function showModeLab(chatId) {
  const settings = await getUserSettings(chatId);
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🧬 <b>Mode Lab</b>`,
    ``,
    `Current mode: <b>${escapeHtml(modeTitle(settings.mode))}</b>`,
    ``,
    `Aggressive = faster entries, more risk tolerance.`,
    `Balanced = strongest overall default.`,
    `Guardian = stricter defense and cleaner filters.`
  ].join("\n");
  await sendText(chatId, text, buildModeMenu(settings.mode));
}

async function showAlertCenter(chatId) {
  const settings = await getUserSettings(chatId);
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🚨 <b>Alert Center</b>`,
    ``,
    `Master alerts: <b>${num(settings.alerts_enabled) ? "ON" : "OFF"}</b>`,
    `Launch alerts: <b>${num(settings.launch_alerts) ? "ON" : "OFF"}</b>`,
    `Smart alerts: <b>${num(settings.smart_alerts) ? "ON" : "OFF"}</b>`,
    `Risk alerts: <b>${num(settings.risk_alerts) ? "ON" : "OFF"}</b>`,
    `Whale alerts: <b>${num(settings.whale_alerts) ? "ON" : "OFF"}</b>`
  ].join("\n");
  await sendText(chatId, text, buildAlertCenterMenu(settings));
}

async function showWatchlist(chatId) {
  const rows = await getWatchlistItems(chatId);
  if (!rows.length) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>

👁 <b>Watchlist</b>

No tokens saved yet. Scan a token and tap <b>Add Watchlist</b>.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `👁 <b>Watchlist</b>`,
    ``,
    `Saved tokens: <b>${rows.length}</b>`,
    `Tap any token below to open it.`
  ].join("\n");

  await sendText(chatId, text, buildWatchlistMenu(rows));
}

async function showWatchlistItem(chatId, chainId, tokenAddress) {
  const pair = await resolveExactPairOrToken(chainId, tokenAddress);
  if (!pair) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>

👁 <b>Watchlist</b>

That token could not be refreshed right now.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
  const verdict = await buildRiskVerdict(pair, chatId);
  await savePairMemorySnapshot(pair, verdict.score);
  await sendCard(chatId, await buildScanCard(pair, "👁 Watchlist Token", chatId), buildWatchlistItemMenu(pair), imageUrl);
}

async function showEdgeBrain(chatId) {
  const settings = await getUserSettings(chatId);
  const rows = await getWatchlistItems(chatId);
  const latestFeedback = await get(
    `SELECT COUNT(*) AS c FROM scan_feedback WHERE user_id = ? AND created_at >= ?`,
    [String(chatId), nowTs() - 86400 * 7]
  );

  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🧠 <b>Edge Brain</b>`,
    ``,
    `Mode: <b>${escapeHtml(modeTitle(settings.mode))}</b>`,
    `Adaptive memory: <b>ON</b>`,
    `7D user feedback events: <b>${latestFeedback?.c || 0}</b>`,
    `Saved watchlist tokens: <b>${rows.length}</b>`,
    ``,
    `This stack now learns from:`,
    `• repeated rescans`,
    `• price/liquidity/volume drift`,
    `• your good/bad call feedback`,
    `• mode-based score shaping`,
    ``,
    `It is not training a new AI model by itself,` ,
    `but it does adapt scoring behavior from stored outcomes.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function showInviteFriends(chatId) {
  const botLink = buildBotDeepLink();

  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🚀 <b>Invite Friends</b>`,
    ``,
    botLink
      ? `Share this bot link:\n${escapeHtml(botLink)}`
      : `Bot username not detected yet.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function promptScanToken(chatId) {
  pendingAction.set(chatId, { type: "SCAN_TOKEN" });
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 Send a token ticker, token address, or pair search.`,
    buildMainMenuOnlyButton()
  );
}

async function runTokenScan(chatId, query) {
  const pair = await resolveBestPair(query);
  if (!pair) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 <b>Token Scan</b>\n\nNo solid token match was found for <b>${escapeHtml(
        query
      )}</b>.`,
      buildScanButtons()
    );
    return;
  }

  const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
  await trackScan(chatId);
  const card = await buildScanCard(pair, "🔎 Token Scan", chatId);
  const verdict = await buildRiskVerdict(pair, chatId);
  await savePairMemorySnapshot(pair, verdict.score);
  await sendCard(chatId, card, buildScanActionButtons(pair), imageUrl);
}

function pTrendScore(pair) {
  const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
  const buyPressure = pair.buysM5 * 600;
  const sellPenalty = pair.sellsM5 * 120;
  const liq = pair.liquidityUsd * 1.8;
  const vol = pair.volumeH24 * 2.3;
  const freshnessBonus = Math.max(0, 300000 - ageMin * 350);

  return liq + vol + buyPressure + freshnessBonus - sellPenalty;
}

async function buildTrendingCandidates(limit = 10) {
  const profiles = await fetchLatestProfiles();
  const boosts = await fetchLatestBoosts();
  const merged = new Map();

  for (const item of profiles) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;

    merged.set(`${item.chainId}:${item.tokenAddress}`, {
      chainId: String(item.chainId),
      tokenAddress: String(item.tokenAddress)
    });
  }

  for (const item of boosts) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;

    merged.set(`${item.chainId}:${item.tokenAddress}`, {
      chainId: String(item.chainId),
      tokenAddress: String(item.tokenAddress)
    });
  }

  const candidates = [];
  for (const item of [...merged.values()].slice(0, 40)) {
    const pair = await resolveTokenToBestPair(item.chainId, item.tokenAddress);
    if (!pair) continue;
    if (pair.liquidityUsd < 10000) continue;
    if (pair.volumeH24 < 10000) continue;
    if (pair.buysM5 + pair.sellsM5 < 3) continue;

    pair._trendScore = pTrendScore(pair);
    candidates.push(pair);
  }

  return candidates.sort((a, b) => b._trendScore - a._trendScore).slice(0, limit);
}

async function showTrending(chatId) {
  let pairs = [];
  try {
    pairs = await buildTrendingCandidates(10);
  } catch (err) {
    console.log("showTrending fetch error:", err.message);
  }

  if (!pairs.length) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n📈 <b>Trending</b>\n\nNo trending candidates were found right now.`,
      buildRefreshMainButtons("trending")
    );
    return;
  }

  const lines = pairs.map((pair, i) => buildTrendingLine(pair, i + 1));
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `📈 <b>Top 10 Trending</b> | ${buildGeneratedStamp()}`,
    ``,
    ...lines
  ].join("\n");

  await sendText(chatId, text, buildRefreshMainButtons("trending"));
}

async function buildLaunchCandidates(limit = 5) {
  const profiles = await fetchLatestProfiles();
  const boosts = await fetchLatestBoosts();
  const merged = new Map();

  for (const item of profiles) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;
    const key = `${item.chainId}:${item.tokenAddress}`;
    merged.set(key, {
      chainId: String(item.chainId),
      tokenAddress: String(item.tokenAddress)
    });
  }

  for (const item of boosts) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;
    const key = `${item.chainId}:${item.tokenAddress}`;
    if (!merged.has(key)) {
      merged.set(key, {
        chainId: String(item.chainId),
        tokenAddress: String(item.tokenAddress)
      });
    }
  }

  const candidates = [];
  for (const item of [...merged.values()].slice(0, 30)) {
    const pair = await resolveTokenToBestPair(item.chainId, item.tokenAddress);
    if (!pair) continue;
    if (pair.liquidityUsd < LAUNCH_MIN_LIQ_USD) continue;
    if (pair.volumeH24 < LAUNCH_MIN_VOL_USD) continue;
    if (!pair.pairCreatedAt) continue;
    candidates.push(pair);
  }

  return candidates
    .sort((a, b) => num(a.pairCreatedAt) - num(b.pairCreatedAt))
    .slice(0, limit);
}

async function showLaunchRadar(chatId) {
  const launches = await buildLaunchCandidates(5);

  if (!launches.length) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n📡 <b>Launch Radar</b>\n\nNo strong launch candidates were found right now.`,
      buildRefreshMainButtons("launch_radar")
    );
    return;
  }

  for (let i = 0; i < launches.length; i++) {
    const pair = launches[i];
    const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);

    await sendCard(
      chatId,
      await buildLaunchCard(pair, i + 1, chatId),
      i === launches.length - 1 ? buildRefreshMainButtons("launch_radar") : {},
      imageUrl
    );

    if (i < launches.length - 1) await sleep(250);
  }
}

function primePickScore(pair) {
  const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
  const buySellRatio =
    pair.sellsM5 > 0 ? pair.buysM5 / Math.max(pair.sellsM5, 1) : pair.buysM5;

  return (
    pair.liquidityUsd * 2.5 +
    pair.volumeH24 * 1.8 +
    pair.buysM5 * 300 +
    Math.min(ageMin, 720) * 200 +
    buySellRatio * 20000 -
    pair.sellsM5 * 50
  );
}

async function buildPrimePickCandidates(limit = 5) {
  const profiles = await fetchLatestProfiles();
  const boosts = await fetchLatestBoosts();
  const merged = new Map();

  for (const item of profiles) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;
    merged.set(`${item.chainId}:${item.tokenAddress}`, {
      chainId: String(item.chainId),
      tokenAddress: String(item.tokenAddress)
    });
  }

  for (const item of boosts) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;
    merged.set(`${item.chainId}:${item.tokenAddress}`, {
      chainId: String(item.chainId),
      tokenAddress: String(item.tokenAddress)
    });
  }

  const out = [];

  for (const item of [...merged.values()].slice(0, 40)) {
    const pair = await resolveTokenToBestPair(item.chainId, item.tokenAddress);
    if (!pair) continue;

    const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
    if (pair.liquidityUsd < PRIME_MIN_LIQ_USD) continue;
    if (pair.volumeH24 < PRIME_MIN_VOL_USD) continue;
    if (ageMin < PRIME_MIN_AGE_MIN) continue;
    if (pair.buysM5 < pair.sellsM5) continue;
    if (!pair.priceUsd || !pair.marketCap) continue;

    const verdict = await buildRiskVerdict(pair);
    if (verdict.score < 52) continue;

    pair._primeScore = primePickScore(pair) + verdict.score * 500;
    out.push(pair);
  }

  return out.sort((a, b) => b._primeScore - a._primeScore).slice(0, limit);
}

async function showPrimePicks(chatId) {
  const picks = await buildPrimePickCandidates(5);

  if (!picks.length) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⭐ <b>Prime Picks</b>\n\nNo candidates cleared the current liquidity and market filters right now.`,
      buildRefreshMainButtons("prime_picks")
    );
    return;
  }

  for (let i = 0; i < picks.length; i++) {
    const pair = picks[i];
    const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);

    await sendCard(
      chatId,
      await buildScanCard(pair, `⭐ Prime Picks #${i + 1}`, chatId),
      i === picks.length - 1 ? buildRefreshMainButtons("prime_picks") : {},
      imageUrl
    );

    if (i < picks.length - 1) await sleep(250);
  }
}

// ================= HELP SCREENS =================
async function showSystemStatus(chatId) {
  const walletCount = await get(
    `SELECT COUNT(*) AS c FROM wallet_tracks WHERE chat_id = ? AND active = 1`,
    [String(chatId)]
  );
  const whaleCount = await get(
    `SELECT COUNT(*) AS c FROM wallet_tracks WHERE chat_id = ? AND label_type = 'whale' AND active = 1`,
    [String(chatId)]
  );
  const devCount = await get(
    `SELECT COUNT(*) AS c FROM wallet_tracks WHERE chat_id = ? AND label_type = 'dev' AND active = 1`,
    [String(chatId)]
  );
  const alertEnabledCount = await get(
    `SELECT COUNT(*) AS c FROM wallet_tracks WHERE chat_id = ? AND active = 1 AND alerts_enabled = 1`,
    [String(chatId)]
  );

  const botUserCount = await getBotUserCount();
  const verifiedBotUsers = await getVerifiedSubscriberBotUsersCount();
  const channelSubscribers = await getChannelSubscriberCount();

  const lines = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `📊 <b>System Status</b>`,
    ``,
    `✅ Bot: Online`,
    `✅ Database: Connected`,
    `✅ Market Data: Active`,
    `${hasHelius() ? "✅" : "⚠️"} Helius: ${hasHelius() ? "Connected" : "Missing"}`,
    `${hasEtherscanKey() ? "✅" : "⚠️"} Etherscan: ${
      hasEtherscanKey() ? "Connected" : "Missing"
    }`,
    `${fs.existsSync(TERMINAL_IMG) ? "✅" : "⚠️"} Terminal Image: ${
      fs.existsSync(TERMINAL_IMG) ? "Loaded" : "Missing"
    }`,
    `📢 Required Channel: ${escapeHtml(REQUIRED_CHANNEL)}`,
    `👥 Channel Subscribers: ${channelSubscribers === null ? "Unavailable" : channelSubscribers}`,
    `🤖 Bot Users Saved: ${botUserCount}`,
    `✅ Verified Subscriber Bot Users: ${verifiedBotUsers}`,
    `🐋 Tracked Wallets: ${walletCount?.c || 0}`,
    `🐋 Whale Wallets: ${whaleCount?.c || 0}`,
    `👤 Dev Wallets: ${devCount?.c || 0}`,
    `🔔 Alerted Wallets: ${alertEnabledCount?.c || 0}`,
    `⏱️ Wallet Monitor: ${hasHelius() ? `${WALLET_SCAN_INTERVAL_MS / 1000}s` : "Unavailable"}`,
    BOT_USERNAME ? `🤖 Bot Username: @${BOT_USERNAME}` : ""
  ].filter(Boolean);

  await sendText(chatId, lines.join("\n"), buildMainMenuOnlyButton());
}

async function showHowToUse(chatId) {
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `📖 <b>How To Use</b>`,
    ``,
    `🔎 <b>Scan Token</b>`,
    `Analyze a token by ticker, token address, or pair search.`,
    ``,
    `📈 <b>Trending</b>`,
    `View stronger live candidates built from recent profiles, boosts, liquidity, volume, and flow.`,
    ``,
    `📡 <b>Launch Radar</b>`,
    `Review newer launches with a short market verdict.`,
    ``,
    `⭐ <b>Prime Picks</b>`,
    `View cleaner candidates that pass liquidity, volume, age, and risk filters.`,
    ``,
    `👁 <b>Watchlist</b>`,
    `Save tokens, re-scan them fast, and let the bot watch for changes.`,
    ``,
    `🧬 <b>Mode Lab</b>`,
    `Switch between Aggressive, Balanced, and Guardian scoring.`,
    ``,
    `🐋 <b>Whale Tracker</b>`,
    `Track named whale and dev wallets with optional alerts.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function showDataSources(chatId) {
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `⚙️ <b>Data Sources</b>`,
    ``,
    `Market data uses:`,
    `• DexScreener`,
    `• Birdeye`,
    `• GeckoTerminal`,
    `• Honeypot.is`,
    `• Etherscan V2`,
    ``,
    `Wallet monitoring uses:`,
    `• Helius RPC`,
    ``,
    `Supported priority chains:`,
    `• Solana`,
    `• Base`,
    `• Ethereum`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function showCommunity(chatId) {
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `💬 <b>Contact / Community</b>`,
    ``,
    `X: ${escapeHtml(COMMUNITY_X_URL)}`,
    `Telegram: ${escapeHtml(COMMUNITY_TELEGRAM_URL)}`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

// ================= WHALE / DEV TRACKING =================
async function addWalletTrack(chatId, wallet, labelType, nickname) {
  const ts = nowTs();

  if (!hasHelius()) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⚠️ Helius is missing. Add HELIUS_API_KEY to enable wallet tracking.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  if (!isLikelySolanaWallet(wallet)) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❌ That does not look like a valid Solana wallet address.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  try {
    await run(
      `INSERT INTO wallet_tracks
      (chat_id, wallet, label_type, nickname, chain_id, active, alerts_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'solana', 1, 1, ?, ?)`,
      [String(chatId), wallet.trim(), labelType, nickname.trim(), ts, ts]
    );

    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n${
        labelType === "whale" ? "🐋" : "👤"
      } ${escapeHtml(labelType === "whale" ? "Whale" : "Dev wallet")} added.\n\nName: ${escapeHtml(
        nickname
      )}\nWallet: ${escapeHtml(shortAddr(wallet, 8))}`,
      buildMainMenuOnlyButton()
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      await sendText(
        chatId,
        `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⚠️ That wallet is already tracked in this category.`,
        buildMainMenuOnlyButton()
      );
      return;
    }
    throw err;
  }
}

async function showWalletList(chatId, type) {
  const rows = await all(
    `SELECT id, wallet, nickname, alerts_enabled
     FROM wallet_tracks
     WHERE chat_id = ? AND label_type = ? AND active = 1
     ORDER BY created_at DESC`,
    [String(chatId), type]
  );

  if (!rows.length) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n${
        type === "whale" ? "🐋 <b>Whale List</b>" : "👤 <b>Dev List</b>"
      }\n\nNo wallets saved yet.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const lines = rows.map((row, i) => {
    const status = row.alerts_enabled ? "ON" : "OFF";
    return `${i + 1}. ${escapeHtml(row.nickname || shortAddr(row.wallet, 6))} | Alerts: ${status}`;
  });

  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n${
      type === "whale" ? "🐋 <b>Whale List</b>" : "👤 <b>Dev List</b>"
    }\n\n${lines.join("\n")}`,
    buildWalletListMenu(rows, type)
  );
}

async function showWalletAlertSettings(chatId) {
  const rows = await all(
    `SELECT id, nickname, wallet, label_type, alerts_enabled
     FROM wallet_tracks
     WHERE chat_id = ? AND active = 1
     ORDER BY label_type ASC, created_at DESC`,
    [String(chatId)]
  );

  if (!rows.length) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⚙️ <b>Alert Settings</b>\n\nNo tracked wallets found yet.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const lines = rows.map((row, i) => {
    const kind = row.label_type === "whale" ? "🐋" : "👤";
    const status = row.alerts_enabled ? "ON" : "OFF";
    return `${i + 1}. ${kind} ${escapeHtml(
      row.nickname || shortAddr(row.wallet, 6)
    )} | Alerts: ${status}`;
  });

  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⚙️ <b>Alert Settings</b>\n\n${lines.join("\n")}`,
    buildMainMenuOnlyButton()
  );
}

async function showWalletItem(chatId, id) {
  const row = await get(`SELECT * FROM wallet_tracks WHERE id = ? AND chat_id = ?`, [
    id,
    String(chatId)
  ]);

  if (!row) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\nWallet item not found.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const kind = row.label_type === "whale" ? "🐋 Whale" : "👤 Dev Wallet";
  const status = row.alerts_enabled ? "ON" : "OFF";
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `<b>${kind}</b>`,
    ``,
    `Name: ${escapeHtml(row.nickname || "Unnamed")}`,
    `Wallet: ${escapeHtml(shortAddr(row.wallet, 8))}`,
    `Alerts: ${status}`,
    `Type: ${escapeHtml(row.label_type)}`,
    `Chain: ${escapeHtml(humanChain(row.chain_id))}`
  ].join("\n");

  await sendText(chatId, text, buildWalletItemMenu(row));
}

async function toggleWalletAlerts(chatId, id) {
  const row = await get(`SELECT * FROM wallet_tracks WHERE id = ? AND chat_id = ?`, [
    id,
    String(chatId)
  ]);
  if (!row) return;

  const next = row.alerts_enabled ? 0 : 1;
  await run(`UPDATE wallet_tracks SET alerts_enabled = ?, updated_at = ? WHERE id = ?`, [
    next,
    nowTs(),
    id
  ]);
  await showWalletItem(chatId, id);
}

async function renameWallet(chatId, id, name) {
  await run(`UPDATE wallet_tracks SET nickname = ?, updated_at = ? WHERE id = ? AND chat_id = ?`, [
    name.trim(),
    nowTs(),
    id,
    String(chatId)
  ]);
  await showWalletItem(chatId, id);
}

async function removeWallet(chatId, id) {
  await run(`UPDATE wallet_tracks SET active = 0, updated_at = ? WHERE id = ? AND chat_id = ?`, [
    nowTs(),
    id,
    String(chatId)
  ]);
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n✅ Wallet removed.`,
    buildMainMenuOnlyButton()
  );
}

async function fetchHeliusLatestTx(address) {
  if (!HELIUS_API_KEY) return null;

  try {
    const res = await axios.get(
      `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(
        address
      )}/transactions?api-key=${encodeURIComponent(HELIUS_API_KEY)}`,
      { timeout: HELIUS_TIMEOUT_MS }
    );
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows[0] || null;
  } catch (err) {
    console.log("fetchHeliusLatestTx error:", err.message);
    return null;
  }
}

function summarizeWalletTx(tx) {
  if (!tx) {
    return {
      type: "Unknown",
      source: "Unknown",
      tokenLine: "Details: limited transaction data available",
      amountLine: "",
      signature: ""
    };
  }

  const type = String(tx.type || "Unknown");
  const source = String(tx.source || "Unknown");
  const signature = String(tx.signature || "");

  if (tx.events?.swap) {
    const swap = tx.events.swap;
    const tokenIn = swap.tokenInputs?.[0];
    const tokenOut = swap.tokenOutputs?.[0];
    const inSym = tokenIn?.symbol || shortAddr(tokenIn?.mint || "", 4) || "Unknown";
    const outSym = tokenOut?.symbol || shortAddr(tokenOut?.mint || "", 4) || "Unknown";
    const inAmt = num(tokenIn?.tokenAmount);
    const outAmt = num(tokenOut?.tokenAmount);

    return {
      type,
      source,
      tokenLine: `Swap: ${inSym} → ${outSym}`,
      amountLine: `Amount: ${inAmt || 0} → ${outAmt || 0}`,
      signature
    };
  }

  if (Array.isArray(tx.tokenTransfers) && tx.tokenTransfers.length) {
    const first = tx.tokenTransfers[0];
    const token = first?.symbol || shortAddr(first?.mint || "", 4) || "Unknown";
    const amount = num(first?.tokenAmount);
    return {
      type,
      source,
      tokenLine: `Token: ${token}`,
      amountLine: `Amount: ${amount || 0}`,
      signature
    };
  }

  return {
    type,
    source,
    tokenLine: `Details: ${clip(tx.description || "limited transaction data available", 80)}`,
    amountLine: "",
    signature
  };
}

async function sendWalletMovementAlert(row, tx) {
  const info = summarizeWalletTx(tx);
  const kindEmoji = row.label_type === "whale" ? "🐋" : "👤";
  const kindText =
    row.label_type === "whale" ? "Whale Movement Detected" : "Dev Wallet Movement Detected";

  const lines = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `${kindEmoji} <b>${kindText}</b>`,
    ``,
    `Name: ${escapeHtml(row.nickname || shortAddr(row.wallet, 8))}`,
    `Wallet: ${escapeHtml(shortAddr(row.wallet, 8))}`,
    `Type: ${escapeHtml(info.type)}`,
    `Source: ${escapeHtml(info.source)}`,
    escapeHtml(info.tokenLine),
    info.amountLine ? escapeHtml(info.amountLine) : "",
    info.signature ? `Signature: ${escapeHtml(shortAddr(info.signature, 8))}` : "",
    `Detected: just now`
  ].filter(Boolean);

  await sendText(row.chat_id, lines.join("\n"), buildMainMenuOnlyButton());
}

async function checkWalletNow(chatId, id) {
  const row = await get(`SELECT * FROM wallet_tracks WHERE id = ? AND chat_id = ?`, [
    id,
    String(chatId)
  ]);
  if (!row) return;

  const tx = await fetchHeliusLatestTx(row.wallet);
  if (!tx) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔍 No recent transaction data was found for this wallet.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const info = summarizeWalletTx(tx);
  const kindEmoji = row.label_type === "whale" ? "🐋" : "👤";
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `${kindEmoji} <b>Wallet Check</b>`,
    ``,
    `Name: ${escapeHtml(row.nickname || shortAddr(row.wallet, 8))}`,
    `Wallet: ${escapeHtml(shortAddr(row.wallet, 8))}`,
    `Type: ${escapeHtml(info.type)}`,
    `Source: ${escapeHtml(info.source)}`,
    escapeHtml(info.tokenLine),
    info.amountLine ? escapeHtml(info.amountLine) : "",
    info.signature ? `Signature: ${escapeHtml(shortAddr(info.signature, 8))}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function checkWalletByAddress(chatId, wallet) {
  if (!hasHelius()) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⚠️ Helius is missing. Add HELIUS_API_KEY to enable wallet checks.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  if (!isLikelySolanaWallet(wallet)) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❌ That does not look like a valid Solana wallet address.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const tx = await fetchHeliusLatestTx(wallet.trim());
  if (!tx) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔍 No recent transaction data was found for that wallet.`,
      buildMainMenuOnlyButton()
    );
    return;
  }

  const info = summarizeWalletTx(tx);
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🔍 <b>Wallet Check</b>`,
    ``,
    `Wallet: ${escapeHtml(shortAddr(wallet, 8))}`,
    `Type: ${escapeHtml(info.type)}`,
    `Source: ${escapeHtml(info.source)}`,
    escapeHtml(info.tokenLine),
    info.amountLine ? escapeHtml(info.amountLine) : "",
    info.signature ? `Signature: ${escapeHtml(shortAddr(info.signature, 8))}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function scanWalletTracks() {
  if (!hasHelius() || walletScanRunning) return;
  walletScanRunning = true;

  try {
    const rows = await all(
      `SELECT * FROM wallet_tracks WHERE active = 1 AND alerts_enabled = 1 ORDER BY created_at ASC`
    );

    for (const row of rows) {
      const tx = await fetchHeliusLatestTx(row.wallet);
      if (!tx || !tx.signature) continue;

      if (!row.last_signature) {
        await run(
          `UPDATE wallet_tracks SET last_signature = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
          [tx.signature, nowTs(), nowTs(), row.id]
        );
        continue;
      }

      if (tx.signature !== row.last_signature) {
        await sendWalletMovementAlert(row, tx);

        await run(
          `UPDATE wallet_tracks SET last_signature = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
          [tx.signature, nowTs(), nowTs(), row.id]
        );
      }
    }
  } catch (err) {
    console.log("scanWalletTracks error:", err.message);
  } finally {
    walletScanRunning = false;
  }
}

// ================= PENDING ACTIONS =================
async function handlePendingAction(chatId, text) {
  const pending = pendingAction.get(chatId);
  if (!pending) return false;

  const input = String(text || "").trim();
  if (!input) return true;

  try {
    if (pending.type === "SCAN_TOKEN") {
      pendingAction.delete(chatId);
      await runTokenScan(chatId, input);
      return true;
    }

    if (pending.type === "ADD_WHALE_WALLET") {
      if (!isLikelySolanaWallet(input)) {
        await sendText(
          chatId,
          `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❌ Please send a valid Solana wallet address.`,
          buildMainMenuOnlyButton()
        );
        return true;
      }
      pendingAction.set(chatId, {
        type: "ADD_WHALE_NAME",
        wallet: input
      });
      await sendText(
        chatId,
        `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🐋 Now send a name for this whale wallet.`,
        buildMainMenuOnlyButton()
      );
      return true;
    }

    if (pending.type === "ADD_WHALE_NAME") {
      pendingAction.delete(chatId);
      await addWalletTrack(chatId, pending.wallet, "whale", input);
      return true;
    }

    if (pending.type === "ADD_DEV_WALLET") {
      if (!isLikelySolanaWallet(input)) {
        await sendText(
          chatId,
          `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❌ Please send a valid Solana wallet address.`,
          buildMainMenuOnlyButton()
        );
        return true;
      }
      pendingAction.set(chatId, {
        type: "ADD_DEV_NAME",
        wallet: input
      });
      await sendText(
        chatId,
        `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n👤 Now send a name for this dev wallet.`,
        buildMainMenuOnlyButton()
      );
      return true;
    }

    if (pending.type === "ADD_DEV_NAME") {
      pendingAction.delete(chatId);
      await addWalletTrack(chatId, pending.wallet, "dev", input);
      return true;
    }

    if (pending.type === "CHECK_WALLET") {
      pendingAction.delete(chatId);
      await checkWalletByAddress(chatId, input);
      return true;
    }

    if (pending.type === "RENAME_WALLET") {
      pendingAction.delete(chatId);
      await renameWallet(chatId, pending.id, input);
      return true;
    }
  } catch (err) {
    pendingAction.delete(chatId);
    console.log("handlePendingAction error:", err.message);
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❌ Something went wrong while processing that request.`,
      buildMainMenuOnlyButton()
    );
    return true;
  }

  return false;
}

async function scanWatchlistAlerts() {
  const rows = await all(`SELECT * FROM watchlist WHERE active = 1 AND alerts_enabled = 1`, []);
  if (!rows.length) return;

  for (const row of rows) {
    try {
      const settings = await getUserSettings(row.chat_id);
      if (!num(settings.alerts_enabled)) continue;

      const pair = await resolveExactPairOrToken(row.chain_id, row.token_address);
      if (!pair) continue;

      const verdict = await buildRiskVerdict(pair, row.chat_id);
      await savePairMemorySnapshot(pair, verdict.score);

      const oldPrice = num(row.last_price);
      const oldLiq = num(row.last_liquidity);
      const oldScore = num(row.last_score);
      const newPrice = num(pair.priceUsd);
      const newLiq = num(pair.liquidityUsd);
      const priceDelta = oldPrice > 0 ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;
      const liqDelta = oldLiq > 0 ? ((newLiq - oldLiq) / oldLiq) * 100 : 0;
      const scoreDelta = verdict.score - oldScore;
      const since = nowTs() - num(row.last_alert_ts);

      let shouldAlert = false;
      let reason = "";

      if (num(settings.smart_alerts) && priceDelta >= 12 && verdict.score >= 60) {
        shouldAlert = true;
        reason = `Momentum burst: ${toPct(priceDelta)}`;
      } else if (num(settings.launch_alerts) && ageMinutesFromMs(pair.pairCreatedAt) <= 45 && verdict.score >= 58) {
        shouldAlert = since >= WATCHLIST_ALERT_COOLDOWN_SEC;
        reason = `Fresh launch watchlist token is active`;
      } else if (num(settings.risk_alerts) && (scoreDelta <= -12 || liqDelta <= -18 || verdict.score <= 40)) {
        shouldAlert = true;
        reason = `Risk deterioration detected`;
      }

      if (shouldAlert && since >= WATCHLIST_ALERT_COOLDOWN_SEC) {
        const text = [
          `🧠 <b>Gorktimus Watchlist Alert</b>`,
          ``,
          `🪙 <b>${escapeHtml(pair.baseSymbol || pair.baseName || 'Unknown')}</b>`,
          `⛓️ ${escapeHtml(humanChain(pair.chainId))}`,
          `📢 ${escapeHtml(reason)}`,
          `📊 Score: <b>${verdict.score}/100</b>`,
          `💲 Price: ${escapeHtml(shortUsd(pair.priceUsd))}`,
          `💧 Liquidity: ${escapeHtml(shortUsd(pair.liquidityUsd))}`,
          `📈 Volume 24h: ${escapeHtml(shortUsd(pair.volumeH24))}`
        ].join("\n");

        await sendText(row.chat_id, text, buildWatchlistItemMenu(pair));
        await run(`UPDATE watchlist SET last_alert_ts = ?, updated_at = ? WHERE id = ?`, [nowTs(), nowTs(), row.id]);
      }

      await run(
        `UPDATE watchlist SET pair_address = ?, symbol = ?, last_price = ?, last_liquidity = ?, last_volume = ?, last_score = ?, updated_at = ? WHERE id = ?`,
        [String(pair.pairAddress || ''), String(pair.baseSymbol || ''), newPrice, newLiq, num(pair.volumeH24), verdict.score, nowTs(), row.id]
      );
    } catch (err) {
      console.log("scanWatchlistAlerts item error:", err.message);
    }
  }
}

// ================= HANDLERS =================
async function registerHandlers() {
  bot.onText(/\/start/, async (msg) => {
    try {
      if (!isPrivateChat(msg)) return;

      await upsertUserFromMessage(msg, 0);

      const ok = await ensureSubscribedOrBlock(msg);
      if (!ok) return;

      await showMainMenu(msg.chat.id);
    } catch (err) {
      console.log("/start error:", err.message);
    }
  });

  bot.onText(/\/menu/, async (msg) => {
    try {
      if (!isPrivateChat(msg)) return;

      await upsertUserFromMessage(msg, 0);

      const ok = await ensureSubscribedOrBlock(msg);
      if (!ok) return;

      await showMainMenu(msg.chat.id);
    } catch (err) {
      console.log("/menu error:", err.message);
    }
  });

  bot.onText(/\/scan(?:\s+(.+))?/, async (msg, match) => {
    try {
      if (!isPrivateChat(msg)) return;

      await upsertUserFromMessage(msg, 0);

      const ok = await ensureSubscribedOrBlock(msg);
      if (!ok) return;

      const chatId = msg.chat.id;
      const query = String(match?.[1] || "").trim();
      if (!query) {
        await promptScanToken(chatId);
        return;
      }
      await runTokenScan(chatId, query);
    } catch (err) {
      console.log("/scan error:", err.message);
    }
  });

  bot.onText(/\/watchlist/, async (msg) => {
    try {
      if (!isPrivateChat(msg)) return;
      await upsertUserFromMessage(msg, 0);
      const ok = await ensureSubscribedOrBlock(msg);
      if (!ok) return;
      await showWatchlist(msg.chat.id);
    } catch (err) {
      console.log("/watchlist error:", err.message);
    }
  });

  bot.onText(/\/mode/, async (msg) => {
    try {
      if (!isPrivateChat(msg)) return;
      await upsertUserFromMessage(msg, 0);
      const ok = await ensureSubscribedOrBlock(msg);
      if (!ok) return;
      await showModeLab(msg.chat.id);
    } catch (err) {
      console.log("/mode error:", err.message);
    }
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    const data = query.data || "";

    try {
      await answerCallbackSafe(query.id);

      if (!chatId) return;
      if (!isPrivateChat(query)) return;

      if (data === "check_subscription") {
        const ok = await ensureSubscribedOrBlock(query);
        if (!ok) {
          await answerCallbackSafe(query.id, "Still not subscribed yet.");
          return;
        }
        await answerCallbackSafe(query.id, "Access unlocked.");
        await showMainMenu(chatId);
        return;
      }

      const ok = await ensureSubscribedOrBlock(query);
      if (!ok) return;

      if (data === "main_menu") {
        await showMainMenu(chatId);
      } else if (data === "scan_token") {
        await promptScanToken(chatId);
      } else if (data === "trending") {
        await showTrending(chatId);
      } else if (data === "launch_radar") {
        await showLaunchRadar(chatId);
      } else if (data === "prime_picks") {
        await showPrimePicks(chatId);
      } else if (data === "watchlist") {
        await showWatchlist(chatId);
      } else if (data === "mode_lab") {
        await showModeLab(chatId);
      } else if (data === "alert_center") {
        await showAlertCenter(chatId);
      } else if (data === "edge_brain") {
        await showEdgeBrain(chatId);
      } else if (data === "whale_menu") {
        await showWhaleMenu(chatId);
      } else if (data === "help_menu") {
        await showHelpMenu(chatId);
      } else if (data === "help_status") {
        await showSystemStatus(chatId);
      } else if (data === "help_how") {
        await showHowToUse(chatId);
      } else if (data === "help_sources") {
        await showDataSources(chatId);
      } else if (data === "help_community") {
        await showCommunity(chatId);
      } else if (data === "invite_friends") {
        await showInviteFriends(chatId);
      } else if (data.startsWith("set_mode:")) {
        const mode = safeMode(data.split(":")[1]);
        await setUserSetting(chatId, "mode", mode);
        await answerCallbackSafe(query.id, `Mode set to ${modeTitle(mode)}`);
        await showModeLab(chatId);
      } else if (data.startsWith("toggle_setting:")) {
        const field = String(data.split(":")[1] || "");
        const settings = await getUserSettings(chatId);
        const current = num(settings[field]);
        await setUserSetting(chatId, field, current ? 0 : 1);
        await showAlertCenter(chatId);
      } else if (data.startsWith("watch_add:")) {
        const parts = data.split(":");
        const chainId = parts[1];
        const tokenAddress = parts[2];
        const pair = await resolveExactPairOrToken(chainId, tokenAddress);
        if (pair) {
          await addWatchlistItem(chatId, pair);
          await answerCallbackSafe(query.id, "Added to watchlist.");
        }
      } else if (data.startsWith("watch_open:")) {
        const parts = data.split(":");
        await showWatchlistItem(chatId, parts[1], parts[2]);
      } else if (data.startsWith("watch_rescan:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(parts[1], parts[2]);
        if (pair) {
          const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
          await sendCard(chatId, await buildScanCard(pair, "🔁 Watchlist Re-Scan", chatId), buildWatchlistItemMenu(pair), imageUrl);
          const verdict = await buildRiskVerdict(pair, chatId);
          await savePairMemorySnapshot(pair, verdict.score);
        }
      } else if (data.startsWith("watch_remove:")) {
        const parts = data.split(":");
        await removeWatchlistItem(chatId, parts[1], parts[2]);
        await answerCallbackSafe(query.id, "Removed from watchlist.");
        await showWatchlist(chatId);
      } else if (data.startsWith("feedback:")) {
        const parts = data.split(":");
        const feedback = parts[1];
        const pair = await resolveExactPairOrToken(parts[2], parts[3]);
        if (pair) {
          const verdict = await buildRiskVerdict(pair, chatId);
          await addScanFeedback(chatId, pair, feedback, verdict.score);
          await answerCallbackSafe(query.id, feedback === "good" ? "Logged as good call." : "Logged as bad call.");
        }
      } else if (data === "add_whale") {
        pendingAction.set(chatId, { type: "ADD_WHALE_WALLET" });
        await sendText(
          chatId,
          `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🐋 Send a Solana whale wallet address.`,
          buildMainMenuOnlyButton()
        );
      } else if (data === "add_dev") {
        pendingAction.set(chatId, { type: "ADD_DEV_WALLET" });
        await sendText(
          chatId,
          `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n👤 Send a Solana dev wallet address.`,
          buildMainMenuOnlyButton()
        );
      } else if (data === "whale_list") {
        await showWalletList(chatId, "whale");
      } else if (data === "dev_list") {
        await showWalletList(chatId, "dev");
      } else if (data === "check_wallet") {
        pendingAction.set(chatId, { type: "CHECK_WALLET" });
        await sendText(
          chatId,
          `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔍 Send a Solana wallet address to check.`,
          buildMainMenuOnlyButton()
        );
      } else if (data === "wallet_alert_settings") {
        await showWalletAlertSettings(chatId);
      } else if (data.startsWith("wallet_item:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) await showWalletItem(chatId, id);
      } else if (data.startsWith("wallet_toggle:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) await toggleWalletAlerts(chatId, id);
      } else if (data.startsWith("wallet_check:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) await checkWalletNow(chatId, id);
      } else if (data.startsWith("wallet_rename:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) {
          pendingAction.set(chatId, { type: "RENAME_WALLET", id });
          await sendText(
            chatId,
            `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n✏️ Send the new wallet name.`,
            buildMainMenuOnlyButton()
          );
        }
      } else if (data.startsWith("wallet_remove:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) await removeWallet(chatId, id);
      }
    } catch (err) {
      console.log("callback error:", err.message);
      if (chatId) {
        await sendText(
          chatId,
          `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❌ Something glitched.`,
          buildMainMenuOnlyButton()
        ).catch(() => {});
      }
    }
  });

  bot.on("message", async (msg) => {
    try {
      if (!isPrivateChat(msg)) return;

      const chatId = msg.chat.id;
      const text = msg.text;

      await upsertUserFromMessage(msg, 0);
      await trackUserActivity(msg.from.id);

      if (!text) return;
      if (text.startsWith("/start") || text.startsWith("/menu") || text.startsWith("/scan")) return;

      const ok = await ensureSubscribedOrBlock(msg);
      if (!ok) return;

      const handled = await handlePendingAction(chatId, text);
      if (handled) return;

      const cleaned = text.trim();
      if (isAddressLike(cleaned)) {
        await trackScan(chatId);
        await runTokenScan(chatId, cleaned);
        return;
      }

      if (/^[A-Za-z0-9_.$-]{2,24}$/.test(cleaned) && !cleaned.startsWith("/")) {
        await runTokenScan(chatId, cleaned);
      }
    } catch (err) {
      console.log("message handler error:", err.message);
    }
  });

  bot.on("polling_error", (err) => {
    console.log("Polling error:", err.code, err.message);
  });

  bot.on("error", (err) => {
    console.log("Bot error:", err.message);
  });
}

// ================= CLEAN SHUTDOWN =================
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`🛑 Shutdown signal received: ${signal}`);

  try {
    if (walletScanInterval) clearInterval(walletScanInterval);
    if (watchlistScanInterval) clearInterval(watchlistScanInterval);

    if (bot) {
      try {
        await bot.stopPolling();
        console.log("✅ Polling stopped cleanly");
      } catch (err) {
        console.log("stopPolling error:", err.message);
      }
    }

    db.close(() => {
      console.log("✅ DB closed");
      process.exit(0);
    });

    setTimeout(() => process.exit(0), 3000);
  } catch (err) {
    console.log("shutdown error:", err.message);
    process.exit(0);
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

// ================= BOOT =================
(async () => {
  await initDb();

  bot = new TelegramBot(BOT_TOKEN, {
    polling: {
      autoStart: false,
      interval: 1000,
      params: { timeout: 10 }
    }
  });

  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
    console.log("✅ Webhook cleared");
  } catch (err) {
    console.log("deleteWebHook warning:", err.message);
  }

  try {
    const me = await bot.getMe();
    BOT_USERNAME = me?.username || "";
  } catch (err) {
    console.log("getMe warning:", err.message);
  }

  await registerHandlers();
  await bot.startPolling();

  console.log("🧠 Gorktimus Intelligence Terminal Running...");
  console.log("🖼️ Menu image exists:", fs.existsSync(TERMINAL_IMG));
  console.log("🔑 Helius enabled:", hasHelius());
  console.log("🔑 Etherscan enabled:", hasEtherscanKey());
  console.log("📢 Required channel:", REQUIRED_CHANNEL);
  console.log("🤖 Bot username:", BOT_USERNAME || "unknown");

  if (hasHelius()) {
    walletScanInterval = setInterval(() => {
      scanWalletTracks();
    }, WALLET_SCAN_INTERVAL_MS);
  }
})();
