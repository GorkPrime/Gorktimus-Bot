const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const DEV_MODE = process.env.DEV_MODE === "true"; 
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const pairCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
function isPrivateChat(msgOrQuery) {
  const chat =
    msgOrQuery?.chat ||
    msgOrQuery?.message?.chat ||
    null;

  return chat?.type === "private";
}
// ================= ENV =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COMMUNITY_X_URL =
  process.env.COMMUNITY_X_URL || "https://x.com/gorktimusprime";
const COMMUNITY_TELEGRAM_URL =
  process.env.COMMUNITY_TELEGRAM_URL || "https://t.me/gorktimusprimezone";
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || "";
const DB_PATH = path.join(__dirname, "gorktimus.db");
const TERMINAL_IMG = path.join(__dirname, "assets", "gorktimus_terminal.png");

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// ================= CONFIG =================
const DEX_TIMEOUT_MS = 6000;
const HELIUS_TIMEOUT_MS = 7000;
const TELEGRAM_SEND_RETRY_MS = 900;
const MAX_WATCHLIST_ITEMS = 30;
const PRIME_MIN_LIQ_USD = 30000;
const PRIME_MIN_VOL_USD = 20000;
const PRIME_MIN_AGE_MIN = 30;
const LAUNCH_MIN_LIQ_USD = 5000;
const LAUNCH_MIN_VOL_USD = 1000;
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
const HONEYPOT_API_BASE = "https://api.honeypot.is";

const SUPPORTED_CHAINS = ["solana", "base", "ethereum"];
const EVM_CHAIN_IDS = {
  ethereum: 1,
  base: 8453
};

// ================= GLOBALS =================
const largestAccountsCache = new Map();
const LARGEST_ACCOUNTS_TTL_MS = 60000;
const db = new sqlite3.Database(DB_PATH);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pendingAction = new Map();
const sessionMemory = new Map();
let BOT_USERNAME = "";
const callbackStore = new Map();
const latestProfilesCache = {
  ts: 0,
  data: []
};

const latestBoostsCache = {
  ts: 0,
  data: []
};

const PROFILES_CACHE_TTL_MS = 120000; // 2 min
const BOOSTS_CACHE_TTL_MS = 45000;    // 45 sec
// ================= DEV MODE LOCK =================
const OWNER_USER_ID = process.env.OWNER_USER_ID || "";
// ================= DB HELPERS =================
function getSessionMemory(chatId) {
  if (!sessionMemory.has(chatId)) {
    sessionMemory.set(chatId, {
      lastScan: null,
      lastImage: null,
      lastAIContext: null
    });
  }
  return sessionMemory.get(chatId);
}

function updateSessionMemory(chatId, patch) {
  const current = getSessionMemory(chatId);
  sessionMemory.set(chatId, {
    ...current,
    ...patch
  });
}

function makeShortCallback(action, payload) {
  const id = Math.random().toString(36).slice(2, 10);
  callbackStore.set(id, payload);
  return `${action}:${id}`;
}

function getShortCallbackPayload(data) {
  const parts = String(data || "").split(":");
  const id = parts[1] || "";
  return callbackStore.get(id) || null;
}
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
async function askAI({ text, chatId, imageUrl = null }) {
  const memory = getSessionMemory(chatId);

  let context = "";
  if (memory?.lastScan) {
    context = `
Most recent scan context:
- Query: ${memory.lastScan.query || ""}
- Symbol: ${memory.lastScan.symbol || ""}
- Name: ${memory.lastScan.name || ""}
- Token Address: ${memory.lastScan.tokenAddress || ""}
- Chain: ${memory.lastScan.chainId || ""}
- Price: ${memory.lastScan.priceUsd || ""}
- Liquidity: ${memory.lastScan.liquidityUsd || ""}
- Market Cap: ${memory.lastScan.marketCap || ""}
- Score: ${memory.lastScan.score || ""}
- Verdict: ${memory.lastScan.verdict || ""}
- Recommendation: ${memory.lastScan.recommendation || ""}
`;
  }

  const userContent = imageUrl
    ? [
        { type: "text", text: context + "\nUser: " + (text || "Analyze this image.") },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    : context + "\nUser: " + (text || "");

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: `
You are Gorktimus Prime — an elite AI crypto defense system.

Your personality:
- Speak sharp, confident, slightly aggressive, in a teaching manner
- Keep it real, urban down to earth professional tone
- Think like a sniper, Like a overall genuis and a elite analyst

Your mission:
- Protect users from scams, rugs, traps, and dont sugarcoat shit
- Break things down SIMPLE but powerful
- Think like a elite master high-level supreme trader

Your outputs MUST include:
- Clear verdict: SAFE / RISKY / DANGER
- Short reasoning (2–5 lines max)
- If needed: a warning or next move

Rules:
- If user sends a token → deep analyze it like a risk scanner
- If user asks anything → respond like a trading assistant and guide
- If unclear → ask a sharp follow-up

Never speak like generic AI. And adapt to individual user mannaerism
          `
        },
        {
          role: "user",
          content: userContent
        }
      ]
    });

    return `⚡ GORKTIMUS VERDICT\n\n${res.choices[0]?.message?.content || "No AI response returned."}`;
  } catch (err) {
    console.log("AI ERROR:", err?.message);
    return "⚠️ Gorktimus temporarily unavailable.";
  }
}
// ================= CALLBACK HELPERS =================


async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      chat_id TEXT UNIQUE,
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
      last_scan_query TEXT DEFAULT '',
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

  try {
    await run(`ALTER TABLE user_settings ADD COLUMN last_scan_query TEXT DEFAULT ''`);
  } catch (_) {}
}

// ================= BASIC HELPERS =================

  async function fetchHeliusTokenLargestAccounts(mint) {
  const now = Date.now();
  const cached = largestAccountsCache.get(mint);

  if (cached && (now - cached.ts < LARGEST_ACCOUNTS_TTL_MS)) {
    console.log(`Cache hit for ${mint} - ${Math.round((LARGEST_ACCOUNTS_TTL_MS - (now - cached.ts)) / 1000)}s remaining`);
    return cached.data;
  }

  let tries = 0;

  while (tries < 4) {
    try {
      const res = await axios.post(HELIUS_RPC_URL, {
        jsonrpc: "2.0",
        id: "largest-accounts",
        method: "getTokenLargestAccounts",
        params: [mint]
      }, {
        timeout: 4000
      });

      const data = res.data?.result?.value || [];
      largestAccountsCache.set(mint, { ts: now, data });
      return data;
    } catch (err) {
      const status = err?.response?.status;

      if (status === 429) {
        tries += 1;
        await sleep(1500 * tries);
        continue;
      }

      throw err;
    }
  }

 return []; 
}
function nowTs() {
  return Math.floor(Date.now() / 1000);
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

function clip(value, len = 28) {
  const s = String(value || "");
  if (s.length <= len) return s;
  return `${s.slice(0, len - 1)}…`;
}

function shortAddr(value, len = 6) {
  const s = String(value || "");
  if (s.length <= len * 2 + 3) return s;
  return `${s.slice(0, len)}...${s.slice(-len)}`;
}

function sum(arr = []) {
  return arr.reduce((a, b) => a + num(b), 0);
}

function shortUsd(n) {
  const x = num(n);
  if (x >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(8)}`;
}

function toPct(value, digits = 2) {
  return `${num(value).toFixed(digits)}%`;
}

function ageMinutesFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

function ageFromMs(createdAtMs) {
  const ms = num(createdAtMs, 0);
  if (!ms) return "N/A";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);
  
  // Show seconds for under 1 minute
  if (diffSec < 60) return `${diffSec}s`;
  if (diffMin < 60) return `${diffMin}m ${diffSec % 60}s`;
  if (diffHrs < 24) return `${diffHrs}h ${diffMin % 60}m`;
  return `${diffDays}d ${diffHrs % 24}h`;
}

function isAddressLike(text) {
  const t = String(text || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) || /^0x[a-fA-F0-9]{40}$/.test(t);
}

function isLikelySolanaWallet(text) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(text || "").trim());
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
  return "Unknown";
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
  return `https://birdeye.so/token/${encodeURIComponent(token)}?chain=${encodeURIComponent(chain)}`;
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

function buildBotDeepLink() {
  if (!BOT_USERNAME) return "";
  return `https://t.me/${BOT_USERNAME}`;
}

// ================= RETRY =================
async function retryOperation(label, fn, options = {}) {
  const {
    attempts = 3,
    baseDelay = 800,
    maxDelay = 9000,
    backoff = 1.8,
    jitter = 180,
    shouldRetry = () => true,
    onRetry = null
  } = options;

  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err, attempt) || attempt === attempts) break;

      const delay =
        Math.min(maxDelay, Math.floor(baseDelay * Math.pow(backoff, attempt - 1))) +
        Math.floor(Math.random() * jitter);

      if (typeof onRetry === "function") {
        try {
          onRetry(err, attempt, delay);
        } catch (_) {}
      }

      await sleep(delay);
    }
  }

  throw lastErr || new Error(`${label} failed`);
}

// ================= TELEGRAM SEND HELPERS =================
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

async function sendPhotoWithRetry(chatId, photo, opts, fileOpts = {}, attempts = 2) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await bot.sendPhoto(chatId, photo, opts, fileOpts);
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
  } catch (_) {}
}

async function sendText(chatId, text, keyboard = {}) {
  return sendMessageWithRetry(chatId, text, {
    ...keyboard,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendMenu(chatId, caption, keyboard) {
  const safeCaption =
    caption ||
    "🧠 <b>Gorktimus Intelligence Terminal</b>\n\nLive intelligence. On-demand execution.";

  try {
    if (!fs.existsSync(TERMINAL_IMG)) {
      return await sendText(chatId, safeCaption, keyboard);
    }

    const buffer = fs.readFileSync(TERMINAL_IMG);
    return await sendPhotoWithRetry(
      chatId,
      buffer,
      {
        caption: safeCaption,
        ...keyboard,
        parse_mode: "HTML"
      },
      {
        filename: "gorktimus_terminal.png",
        contentType: "image/png"
      }
    );
  } catch (err) {
    console.log("sendMenu image fallback:", err.message);
    return await sendText(chatId, safeCaption, keyboard);
  }
}

async function sendCard(chatId, text, keyboard = {}, imageUrl = "") {
  const safeText = text || "🧠 <b>Gorktimus Intelligence Terminal</b>";
  if (imageUrl) {
    try {
      return await sendPhotoWithRetry(chatId, imageUrl, {
        caption: safeText,
        ...keyboard,
        parse_mode: "HTML"
      });
    } catch (err) {
      console.log("sendCard image fallback:", err.message);
    }
  }
  return sendText(chatId, safeText, keyboard);
}

// ================= USER / SETTINGS =================
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
    explanation_level: "deep",
    last_scan_query: ""
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
    "explanation_level",
    "last_scan_query"
  ]);
  if (!allowed.has(field)) throw new Error(`Invalid setting field: ${field}`);
  await ensureUserSettings(userId);
  await run(
    `UPDATE user_settings SET ${field} = ?, updated_at = ? WHERE user_id = ?`,
    [value, nowTs(), String(userId)]
  );
}

function safeMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (["aggressive", "balanced", "guardian"].includes(m)) return m;
  return "balanced";
}

function modeTitle(mode) {
  const m = safeMode(mode);
  if (m === "aggressive") return "Aggressive";
  if (m === "guardian") return "Guardian";
  return "Balanced";
}

async function trackUserActivity(userId) {
  await run(`INSERT INTO user_activity (user_id, ts) VALUES (?, ?)`, [String(userId), nowTs()]);
}

async function trackScan(userId) {
  await run(`INSERT INTO scan_logs (user_id, ts) VALUES (?, ?)`, [String(userId), nowTs()]);
}

async function getNetworkPulse() {
  const now = nowTs();
  const startOfDay = now - 86400;
  const liveWindow = now - 900;

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

// ================= SUBSCRIPTION =================
async function isUserSubscribed(userId) {
  if (!REQUIRED_CHANNEL) return true;
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    const ok = ["member", "administrator", "creator"].includes(member.status);
    await setUserSubscription(userId, ok);
    return ok;
  } catch (err) {
    console.log(`isUserSubscribed error for ${userId}:`, err.message);
    // fail-open so the bot keeps working if the bot was kicked or the channel value is bad
    return true;
  }
}

function buildSubscriptionGate() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Join Channel", url: COMMUNITY_TELEGRAM_URL }],
        [{ text: "✅ I Joined / Check Again", callback_data: "check_subscription" }],
        [{ text: "🔄 Refresh", callback_data: "refresh:main" }]
      ]
    }
  };
}

async function showSubscriptionRequired(chatId) {
  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🚫 <b>Access Locked</b>\n\nYou must join the official channel before using the bot.\n\nRequired channel: <b>${escapeHtml(REQUIRED_CHANNEL)}</b>`,
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
function getDevModeStatus() {
  return DEV_MODE ? "🔴 DEV: ON" : "🟢 PROD: ON";
}

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
      { text: "🤖 AI Assistant", callback_data: "ai_assistant" }
    ],
    [{ text: "❓ Help", callback_data: "help_menu" }],
    [{ text: "🔄 Refresh", callback_data: "refresh:main" }]
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
        [{ text: "📖 How Gorktimus Works", callback_data: "help_engine" }],
        [{ text: "📊 Why It Differs From Dex", callback_data: "help_dex_diff" }],
        [{ text: "🛡 Safety Score + Confidence", callback_data: "help_score" }],
        [{ text: "🔄 Transactions / Flow Explained", callback_data: "help_transactions" }],
        [{ text: "⚙️ Data Sources", callback_data: "help_sources" }],
        [{ text: "💬 Contact / Community", callback_data: "help_community" }],
        [{ text: "🔄 Refresh", callback_data: "refresh:help" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildAIAssistantMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📖 How It Works", callback_data: "help_engine" },
          { text: "📊 Why Not Dex", callback_data: "help_dex_diff" }
        ],
        [
          { text: "🔄 Transactions", callback_data: "help_transactions" },
          { text: "🛡 Safety Score", callback_data: "help_score" }
        ],
        [
          { text: "🔎 Scan Token", callback_data: "scan_token" },
          { text: "🔄 Refresh", callback_data: "refresh:ai" }
        ],
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
        [{ text: "🔄 Refresh", callback_data: "refresh:wallets" }],
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
        [{ text: "🔄 Refresh", callback_data: "refresh:mode_lab" }],
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
        [{ text: "🔄 Refresh", callback_data: "refresh:alert_center" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildWatchlistItemCallback(chainId, tokenAddress) {
  return `watch_open:${String(chainId)}:${String(tokenAddress)}`;
}

function buildWatchlistMenu(rows) {
  const buttons = rows.slice(0, MAX_WATCHLIST_ITEMS).map((row) => [
    {
      text: `👁 ${clip(row.symbol || shortAddr(row.token_address, 6), 28)}`,
      callback_data: buildWatchlistItemCallback(row.chain_id, row.token_address)
    }
  ]);
  buttons.push([{ text: "🔄 Refresh", callback_data: "refresh:watchlist" }]);
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
        [{ text: "🔄 Refresh", callback_data: `watch_rescan:${pair.chainId}:${pair.baseAddress}` }],
        [{ text: "👁 Watchlist", callback_data: "watchlist" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildScanActionButtons(pair, query = "") {
  const refreshQuery = encodeURIComponent(
    String(query || pair.baseAddress || pair.baseSymbol || "").slice(0, 40)
  );

  const watchAddCb = makeShortCallback("watchadd", {
    chainId: pair.chainId,
    tokenAddress: pair.baseAddress
  });

  const feedbackGoodCb = makeShortCallback("feedbackgood", {
    chainId: pair.chainId,
    tokenAddress: pair.baseAddress
  });

  const feedbackBadCb = makeShortCallback("feedbackbad", {
    chainId: pair.chainId,
    tokenAddress: pair.baseAddress
  });

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "👁 Add Watchlist", callback_data: watchAddCb },
          { text: "🔎 Scan Another", callback_data: "scan_token" }
        ],
        [
          { text: "👍 Good Call", callback_data: feedbackGoodCb },
          { text: "👎 Bad Call", callback_data: feedbackBadCb }
        ],
        [
          { text: "🔄 Refresh", callback_data: `refresh_scan:${refreshQuery}` }
        ],
        [
          { text: "🤖 Ask AI Assistant", callback_data: "ai_assistant" }
        ],
        [
          { text: "🏠 Main Menu", callback_data: "main_menu" }
        ]
      ]
    }
  };
}

function buildMainMenuOnlyButton(refreshCallback = "refresh:main") {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: refreshCallback }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}
function buildMiniSignalCard(pair, index, mode = "standard") {
  const dexUrl = makeDexUrl(pair.chainId, pair.pairAddress, pair.url);
  const symbol = escapeHtml(pair.baseSymbol || "N/A");
  const chain = escapeHtml(humanChain(pair.chainId));
  const address = escapeHtml(pair.baseAddress || "");
  const age = ageFromMs(pair.pairCreatedAt);

  let verdict = "Structure is being watched.";
  if (mode === "trending") {
    verdict =
      pair.buysM5 > pair.sellsM5
        ? "Momentum is active. Buyers are leading short-term flow."
        : "Attention is live, but buyer control is not fully established.";
  } else if (mode === "launch") {
    verdict =
      pair.volumeH24 >= pair.liquidityUsd * 1.5
        ? "Strong early flow relative to liquidity."
        : "Fresh activity detected, but confirmation is still forming.";
  } else if (mode === "prime") {
    verdict =
      pair.liquidityUsd >= PRIME_MIN_LIQ_USD * 2
        ? "Cleaner structure with stronger balance."
        : "Qualified setup, but not top-tier depth yet.";
  }

  return [
    `━━━━━━━━━━━━━━━`,
    `<b>${index}. <a href="${dexUrl}">${symbol}</a></b> • ${chain}`,
    `<code>${shortAddr(address, 6)}</code>`,
    `Price: <b>${shortUsd(pair.priceUsd)}</b>   Mcap: <b>${shortUsd(pair.marketCap)}</b>`,
    `Liq: <b>${shortUsd(pair.liquidityUsd)}</b>   Vol: <b>${shortUsd(pair.volumeH24)}</b>`,
    `Flow: <b>${pair.buysM5}B / ${pair.sellsM5}S</b>   Age: <b>${age}</b>`,
    `<i>${escapeHtml(verdict)}</i>`
  ].join("\n");
}
function buildSignalListButtons(items, refreshKey) {
  const rows = [];

  for (const pair of items) {
    const dexUrl = makeDexUrl(pair.chainId, pair.pairAddress, pair.url);

    rows.push([
      { text: `📈 ${clip(pair.baseSymbol || "Token", 18)}`, url: dexUrl },
      { text: "📋 Copy Address", copy_text: { text: pair.baseAddress || "" } }
    ]);

    rows.push([
      { text: "🔎 Full Scan", callback_data: `scan_direct:${pair.chainId}:${pair.baseAddress}` }
    ]);
  }

  rows.push([{ text: "🔄 Refresh", callback_data: refreshKey }]);
  rows.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);

  return {
    reply_markup: {
      inline_keyboard: rows
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
  buttons.push([{ text: "🔄 Refresh", callback_data: "refresh:wallets" }]);
  buttons.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);
  return { reply_markup: { inline_keyboard: buttons } };
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
        [{ text: "🔄 Refresh", callback_data: "refresh:wallets" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
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
      num(pair.txns?.m5?.buys || pair.buysM5) +
      num(pair.txns?.m5?.sells || pair.sellsM5),
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
    `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`
  );
  const pairs = Array.isArray(data) ? data : [];
  return pairs.map(normalizePair).filter((p) => p && supportsChain(p.chainId));
}
async function resolveBestPair(query, forceFresh = false) {
  const q = String(query || "").trim();
  if (!q) return null;

  const cacheKey = q.toLowerCase();
  const now = Date.now();
  const cached = pairCache.get(cacheKey);

  if (!forceFresh && cached && now - cached.ts < 40000 ) {
    return cached.data;
  }

  let result = null;
  let tries = 0;

  while (tries < 3) {
    try {
      if (isAddressLike(q)) {
        const chainCandidates = q.startsWith("0x")
          ? ["base", "ethereum"]
          : ["solana"];
const tokenResults = await Promise.all(
  chainCandidates.map(async (chainId) => {
    try {
      return await fetchPairsByToken(chainId, q);
    } catch (_) {
      return [];
    }
  })
);

const byTokenResults = tokenResults.flat();

        if (byTokenResults.length) {
          result = byTokenResults.sort((a, b) => rankPairQuality(b) - rankPairQuality(a))[0];
          break;
        }
      }

      const pairs = await searchDexPairs(q);
      if (!pairs.length) {
        result = null;
        break;
      }

      const lowered = q.toLowerCase();
      result = pairs.sort((a, b) => {
       const exactA = String(a.baseSymbol || "").toLowerCase() === lowered;
const exactB = String(b.baseSymbol || "").toLowerCase() === lowered;
        if (exactA !== exactB) return exactB - exactA;
        return rankPairQuality(b) - rankPairQuality(a);
      })[0];

      break;
    } catch (err) {
      const status = err?.response?.status;

      if (status === 429) {
        tries += 1;
        console.log(`resolveBestPair 429 for ${q}. Retry ${tries}/3`);
        await sleep(400 * tries);
        continue;
      }

      console.log("resolveBestPair error:", err.message);
      return null;
    }
  }

  pairCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

async function resolveTokenToBestPair(chainId, tokenAddress, forceFresh = false) {
  try {
    const cacheKey = `${String(chainId).toLowerCase()}:${String(tokenAddress).toLowerCase()}`;
    const now = Date.now();
    const cached = pairCache.get(cacheKey);

    if (!forceFresh && cached && now - cached.ts < 10000) {
      return cached.data;
    }

    const pairs = await fetchPairsByToken(chainId, tokenAddress);
    if (!pairs.length) return null;

    const best = pairs.sort((a, b) => rankPairQuality(b) - rankPairQuality(a))[0];
    pairCache.set(cacheKey, { ts: Date.now(), data: best });
    return best;
  } catch (err) {
    console.log("resolveTokenToBestPair error:", err.message);
    return null;
  }
}
async function fetchLatestProfiles(forceFresh = false) {
  try {
    const now = Date.now();
    if (!forceFresh && latestProfilesCache.data.length && (now - latestProfilesCache.ts < PROFILES_CACHE_TTL_MS)) {
      return latestProfilesCache.data;
    }

    const data = await safeGet("https://api.dexscreener.com/token-profiles/latest/v1");
    const clean = Array.isArray(data) ? data : [];

    latestProfilesCache.ts = now;
    latestProfilesCache.data = clean;
    return clean;
  } catch (err) {
    console.log("fetchLatestProfiles error:", err.message);
    return latestProfilesCache.data || [];
  }
}

async function fetchLatestBoosts(forceFresh = false) {
  try {
    const now = Date.now();
    if (!forceFresh && latestBoostsCache.data.length && (now - latestBoostsCache.ts < BOOSTS_CACHE_TTL_MS)) {
      return latestBoostsCache.data;
    }

    const data = await safeGet("https://api.dexscreener.com/token-boosts/latest/v1");
    const clean = Array.isArray(data) ? data : [];

    latestBoostsCache.ts = now;
    latestBoostsCache.data = clean;
    return clean;
  } catch (err) {
    console.log("fetchLatestBoosts error:", err.message);
    return latestBoostsCache.data || [];
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
    return String(hit?.icon || hit?.imageUrl || hit?.header || "");
  } catch (err) {
    console.log("fetchTokenProfileImage error:", err.message);
    return "";
  }
}

// ================= CHAIN INTELLIGENCE =================

async function fetchEvmHoneypot(address, chainId) {
  if (!address || !isEvmChain(chainId)) return null;
  const chain = String(chainId).toLowerCase();
  const mappedChainId = EVM_CHAIN_IDS[chain];
  const strategies = [
    async () => {
      const res = await axios.get(`${HONEYPOT_API_BASE}/v2/IsHoneypot`, {
        timeout: DEX_TIMEOUT_MS,
        params: { address, chainID: mappedChainId }
      });
      return res.data || null;
    },
    async () => {
      const res = await axios.get(`${HONEYPOT_API_BASE}/v2/IsHoneypot`, {
        timeout: DEX_TIMEOUT_MS,
        params: { address }
      });
      return res.data || null;
    }
  ];

  for (const strategy of strategies) {
    try {
      return await retryOperation(
        "fetchEvmHoneypot",
        async () => {
          const result = await strategy();
          if (!result) throw new Error("Empty honeypot payload");
          return result;
        },
        {
          attempts: 2,
          baseDelay: 1200,
          maxDelay: 5000,
          backoff: 1.7,
          shouldRetry: (err) => {
            const status = err?.response?.status;
            return [408, 425, 500, 502, 503, 504].includes(status) ||
              err?.code === "ECONNABORTED" ||
              err?.code === "ETIMEDOUT" ||
              err?.code === "ECONNRESET";
          }
        }
      );
    } catch (_) {}
  }

  return null;
}

async function fetchEvmTopHolders(address, chainId) {
  if (!address || !isEvmChain(chainId)) return null;
  const chain = String(chainId).toLowerCase();
  const mappedChainId = EVM_CHAIN_IDS[chain];

  try {
    return await retryOperation(
      "fetchEvmTopHolders",
      async () => {
        const res = await axios.get(`${HONEYPOT_API_BASE}/v1/TopHolders`, {
          timeout: DEX_TIMEOUT_MS,
          params: { address, chainID: mappedChainId }
        });
        return res.data || null;
      },
      {
        attempts: 2,
        baseDelay: 1200,
        maxDelay: 6000,
        backoff: 1.8,
        shouldRetry: (err) => {
          const status = err?.response?.status;
          return [408, 425, 500, 502, 503, 504].includes(status) ||
            err?.code === "ECONNABORTED" ||
            err?.code === "ETIMEDOUT" ||
            err?.code === "ECONNRESET";
        }
      }
    );
  } catch (err) {
    console.log("fetchEvmTopHolders error:", err?.response?.status || err.message);
    return null;
  }
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

// ================= ANALYSIS =================
function analyzeSolanaHolderConcentration(largestAccounts = []) {
  if (!largestAccounts.length) {
    return { label: "Unknown", score: 6, top5Pct: 0, detail: "No holder data returned" };
  }
  const balances = largestAccounts.map((x) => num(x.uiAmount));
  const totalTop20 = sum(balances);
  if (totalTop20 <= 0) {
    return { label: "Unknown", score: 6, top5Pct: 0, detail: "Largest accounts returned zeroed balances" };
  }
  const top1Pct = (sum(balances.slice(0, 1)) / totalTop20) * 100;
  const top5Pct = (sum(balances.slice(0, 5)) / totalTop20) * 100;

  let label = "Moderate";
  let score = 8;
  if (top1Pct >= 60 || top5Pct >= 90) {
    label = "Very High";
    score = 1;
  } else if (top1Pct >= 35 || top5Pct >= 75) {
    label = "High";
    score = 4;
  } else if (top1Pct <= 15 && top5Pct <= 45) {
    label = "Lower";
    score = 14;
  }

  return {
    label,
    score,
    top5Pct,
    detail: `Top 1: ${toPct(top1Pct)} | Top 5: ${toPct(top5Pct)}`
  };
}

function analyzeEvmTopHolders(data) {
  const totalSupply = num(data?.totalSupply);
  const holders = Array.isArray(data?.holders) ? data.holders : [];
  if (!holders.length || totalSupply <= 0) {
    return { label: "Unknown", score: 6, top5Pct: 0, detail: "No top holder data returned" };
  }

  const balances = holders.map((h) => num(h.balance));
  const top1Pct = (sum(balances.slice(0, 1)) / totalSupply) * 100;
  const top5Pct = (sum(balances.slice(0, 5)) / totalSupply) * 100;

  let label = "Moderate";
  let score = 8;
  if (top1Pct >= 30 || top5Pct >= 70) {
    label = "High";
    score = 4;
  } else if (top1Pct <= 10 && top5Pct <= 30) {
    label = "Lower";
    score = 14;
  }

  return {
    label,
    score,
    top5Pct,
    detail: `Top 1: ${toPct(top1Pct)} | Top 5: ${toPct(top5Pct)}`
  };
}

function analyzeExecutionBehavior(pair) {
  const buys = num(pair?.buysM5);
  const sells = num(pair?.sellsM5);
  const txns = num(pair?.txnsM5);
  const liquidity = num(pair?.liquidityUsd);
  const volume = num(pair?.volumeH24);
  const avgUsdPerRecentTxn = txns > 0 ? volume / Math.max(txns, 1) : volume;

  let penalty = 0;
  const notes = [];

  if (txns >= 25 && liquidity < 25000 && avgUsdPerRecentTxn < 1500) {
    penalty += 4;
    notes.push("Recent transaction count looks loud relative to thin liquidity.");
  }

  if (buys >= 18 && sells <= 1 && liquidity < 25000) {
    penalty += 5;
    notes.push("Buy flow is extremely one-sided and can be manufactured in thin books.");
  }

  if (!notes.length) {
    notes.push("No dominant flow-manipulation signature from current lightweight behavior checks.");
  }

  return {
    penalty,
    detail: notes.join(" ")
  };
}

function buildConfidenceMeta(sourceChecks, behaviorPenalty = 0) {
  const available = num(sourceChecks?.available);
  const expected = Math.max(1, num(sourceChecks?.expected, 1));
  const ratio = available / expected;

  let confidence = "Medium";
  if (ratio >= 0.9 && behaviorPenalty <= 2) confidence = "High";
  else if (ratio < 0.6) confidence = "Low";

  return {
    confidence,
    checksText: `${available}/${expected} source checks`
  };
}

function getLiquidityHealth(liquidityUsd) {
  const liq = num(liquidityUsd);
  if (liq >= 100000) return { label: "Strong", score: 22 };
  if (liq >= 40000) return { label: "Healthy", score: 18 };
  if (liq >= 15000) return { label: "Moderate", score: 10 };
  if (liq > 0) return { label: "Weak", score: 4 };
  return { label: "Unknown", score: 0 };
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
    return "Stronger setup than most. Still use discipline, but current structure looks healthier.";
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
  const behavior = analyzeExecutionBehavior(pair);
  const settings = userId ? await getUserSettings(userId) : { mode: "balanced" };
  const mode = safeMode(settings?.mode);

  let transparencyLabel = "Unknown";
  let transparencyScore = 4;
  let transparencyDetail = "";

  let honeypotLabel = "Unknown";
  let honeypotScore = 6;
  let honeypotDetail = "";

  let holderLabel = "Unknown";
  let holderScore = 6;
  let holderDetail = "";

  let buyTax = null;
  let sellTax = null;
  let holderTop5Pct = 0;
  let isHoneypot = null;
  let sourceChecks = { available: 1, expected: 3 };

  const chain = String(pair.chainId || "").toLowerCase();
if (chain === "solana") {
  const largestAccounts = await fetchHeliusTokenLargestAccounts(pair.baseAddress);
  const safeLargestAccounts = Array.isArray(largestAccounts) ? largestAccounts : [];
  const holderInfo = analyzeSolanaHolderConcentration(safeLargestAccounts);

  holderLabel = holderInfo.label;
  holderScore = holderInfo.score;
  holderDetail = holderInfo.detail;
  holderTop5Pct = holderInfo.top5Pct;

  transparencyLabel = safeLargestAccounts.length ? "Some Signal" : "Limited";
  transparencyScore = safeLargestAccounts.length ? 10 : 5;
  transparencyDetail = safeLargestAccounts.length
    ? "Largest accounts returned from Helius."
    : "No extra holder structure returned.";

  honeypotLabel = "Not Fully Testable";
  honeypotScore = 8;
  honeypotDetail =
    "Solana honeypot simulation is limited in this stack, so safety is inferred more from structure.";

  sourceChecks = {
    available: 1 + (safeLargestAccounts.length ? 1 : 0) + 1,
    expected: 3
  };
}
  else if (isEvmChain(chain)) {
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

      if (isHoneypot || risk === "honeypot" || riskLevel >= 90) {
        honeypotLabel = "Detected";
        honeypotScore = 0;
      } else if (riskLevel >= 60) {
        honeypotLabel = `High Risk`;
        honeypotScore = 2;
      } else if (riskLevel >= 20) {
        honeypotLabel = `Medium Risk`;
        honeypotScore = 6;
      } else {
        honeypotLabel = "Low Risk";
        honeypotScore = 13;
      }

      honeypotDetail = `Buy tax: ${buyTax === null ? "?" : toPct(buyTax)} | Sell tax: ${sellTax === null ? "?" : toPct(sellTax)}`;
    } else {
      honeypotLabel = "Unavailable";
      honeypotScore = 7;
      honeypotDetail = "No honeypot result returned.";
    }

    if (topHoldersData) {
      const holderInfo = analyzeEvmTopHolders(topHoldersData);
      holderLabel = holderInfo.label;
      holderScore = holderInfo.score;
      holderDetail = holderInfo.detail;
      holderTop5Pct = holderInfo.top5Pct;
    }

    if (etherscanData) {
      const source = String(etherscanData.SourceCode || "").trim();
      const verified = String(etherscanData.ABI || "").trim() !== "Contract source code not verified";
      transparencyLabel = verified ? "Verified" : "Limited";
      transparencyScore = verified ? 15 : 5;
      transparencyDetail = source ? "Verified source available." : "Source verification unavailable.";
    }

    sourceChecks = {
      available: 1 + (honeypotData ? 1 : 0) + (topHoldersData ? 1 : 0) + (etherscanData ? 1 : 0),
      expected: 4
    };
  }

  const confidenceMeta = buildConfidenceMeta(sourceChecks, behavior.penalty);

  let score =
    liquidity.score +
    age.score +
    flow.score +
    volume.score +
    transparencyScore +
    honeypotScore +
    holderScore -
    behavior.penalty;

  if (mode === "aggressive") score += 3;
  if (mode === "guardian") score -= 3;

  score = Math.max(1, Math.min(99, Math.round(score)));

  let grade = "Caution";
  if (score >= 75) grade = "Strong";
  else if (score >= 55) grade = "Constructive";
  else if (score < 35) grade = "Danger";

  const recommendation = buildRecommendation(score, ageMin, pair, {
    isHoneypot,
    buyTax,
    sellTax,
    holderTop5Pct
  });

  return {
    score,
    grade,
    ageMin,
    recommendation,
    liquidity,
    age,
    flow,
    volume,
    transparencyLabel,
    transparencyDetail,
    honeypotLabel,
    honeypotDetail,
    holderLabel,
    holderDetail,
    confidenceMeta,
    behavior,
    buyTax,
    sellTax
  };
}

async function buildScanCard(pair, heading, userId = null) {
  const verdict = await buildRiskVerdict(pair, userId);
  const dexUrl = makeDexUrl(pair.chainId, pair.pairAddress, pair.url);
  const birdeyeUrl = makeBirdeyeUrl(pair.chainId, pair.baseAddress);
  const geckoUrl = makeGeckoUrl(pair.chainId, pair.pairAddress);

  return [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `${heading}`,
    ``,
    `🪙 <b>${escapeHtml(pair.baseName || pair.baseSymbol || "Unknown")}</b> (${escapeHtml(pair.baseSymbol || "N/A")})`,
    `⛓ <b>${escapeHtml(humanChain(pair.chainId))}</b>`,
    `📍 <code>${escapeHtml(pair.baseAddress || "")}</code>`,
    `🔗 Pair: <code>${escapeHtml(shortAddr(pair.pairAddress || "", 8))}</code>`,
    ``,
    `🛡 <b>Safety Score:</b> ${verdict.score}/99`,
    `📌 <b>Grade:</b> ${escapeHtml(verdict.grade)}`,
    `🎯 <b>Confidence:</b> ${escapeHtml(verdict.confidenceMeta.confidence)} (${escapeHtml(verdict.confidenceMeta.checksText)})`,
    ``,
    `💧 <b>Liquidity:</b> ${shortUsd(pair.liquidityUsd)} • ${escapeHtml(verdict.liquidity.label)}`,
    `📊 <b>24H Volume:</b> ${shortUsd(pair.volumeH24)} • ${escapeHtml(verdict.volume.label)}`,
    `⚡ <b>Flow:</b> ${escapeHtml(verdict.flow.label)} | Buys ${num(pair.buysM5)} / Sells ${num(pair.sellsM5)}`,
    `⏳ <b>Age:</b> ${escapeHtml(ageFromMs(pair.pairCreatedAt))} • ${escapeHtml(verdict.age.label)}`,
    `🏦 <b>Market Cap:</b> ${shortUsd(pair.marketCap || pair.fdv)}`,
    ``,
    `🔍 <b>Transparency:</b> ${escapeHtml(verdict.transparencyLabel)}`,
    `🧪 <b>Trap / Honeypot:</b> ${escapeHtml(verdict.honeypotLabel)}`,
    `👥 <b>Holder Structure:</b> ${escapeHtml(verdict.holderLabel)}`,
    `🧠 <b>Behavior:</b> ${escapeHtml(verdict.behavior.detail)}`,
    ``,
    `📌 <b>Recommendation:</b> ${escapeHtml(verdict.recommendation)}`,
    ``,
    `🌐 Dex: ${dexUrl || "N/A"}`,
    `🐦 Birdeye: ${birdeyeUrl || "N/A"}`,
    `🦎 Gecko: ${geckoUrl || "N/A"}`
  ].join("\n");
}

// ================= WATCHLIST =================
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
      String(pair.chainId || ""),
      String(pair.baseAddress || ""),
      String(pair.baseSymbol || ""),
      String(pair.pairAddress || ""),
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
  await run(
    `DELETE FROM watchlist WHERE chat_id = ? AND chain_id = ? AND token_address = ?`,
    [String(chatId), String(chainId), String(tokenAddress)]
  );
}

async function getWatchlistItems(chatId) {
  return await all(
    `SELECT * FROM watchlist WHERE chat_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT ?`,
    [String(chatId), MAX_WATCHLIST_ITEMS]
  );
}

async function getWatchlistCount(chatId) {
  const row = await get(
    `SELECT COUNT(*) AS c FROM watchlist WHERE chat_id = ? AND active = 1`,
    [String(chatId)]
  );
  return row?.c || 0;
}

// ================= PAIR MEMORY / FEEDBACK =================
function getMemoryKey(pair) {
  return `${String(pair?.chainId || "").toLowerCase()}:${String(pair?.baseAddress || "").toLowerCase()}`;
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

async function savePairMemorySnapshot(pair) {
  const key = getMemoryKey(pair);
  const old = await getPairMemory(pair);
  const price = num(pair?.priceUsd);
  const liquidity = num(pair?.liquidityUsd);
  const volume = num(pair?.volumeH24);

  await run(
    `INSERT INTO pair_memory (memory_key, learned_bias, positive_events, negative_events, last_outcome, last_price, last_liquidity, last_volume, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_key) DO UPDATE SET
       last_price = excluded.last_price,
       last_liquidity = excluded.last_liquidity,
       last_volume = excluded.last_volume,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
    [key, num(old.learned_bias), num(old.positive_events), num(old.negative_events), old.last_outcome || "none", price, liquidity, volume, nowTs(), nowTs()]
  );
}

async function addScanFeedback(userId, pair, feedback, scoreSnapshot = 0) {
  await run(
    `INSERT INTO scan_feedback (user_id, chain_id, token_address, pair_address, symbol, feedback, score_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(userId),
      String(pair?.chainId || ""),
      String(pair?.baseAddress || ""),
      String(pair?.pairAddress || ""),
      String(pair?.baseSymbol || ""),
      String(feedback || ""),
      num(scoreSnapshot),
      nowTs()
    ]
  );
}

// ================= AI HELPER =================
function buildAssistantGenericReply(prompt = "") {
  const lower = String(prompt || "").toLowerCase();

  if (/(liquidity)/i.test(lower)) {
    return [
      `🧠 <b>Liquidity Read</b>`,
      ``,
      `A token can show a big market cap and still be dangerous if liquidity is thin.`,
      `That is why Gorktimus treats liquidity as one of the most important defensive inputs.`
    ].join("\n");
  }

  if (/(volume|transactions|tx|buys|sells|flow|spam)/i.test(lower)) {
    return [
      `🧠 <b>Volume / Transactions Read</b>`,
      ``,
      `High volume and high transactions are not automatically bullish.`,
      `The move matters more when activity is supported by decent liquidity and the recent flow does not look spammy or one-sided in a suspicious way.`,
      ``,
      `That is why the terminal looks at transaction behavior instead of treating raw activity as truth.`
    ].join("\n");
  }

  if (/(rug|trap|honeypot|tax)/i.test(lower)) {
    return [
      `🧠 <b>Trap / Rug Read</b>`,
      ``,
      `A dangerous token often shows a stack of weak signals together:`,
      `• thin liquidity`,
      `• concentration risk`,
      `• poor transparency`,
      `• ugly taxes or direct honeypot behavior`,
      `• spammy or manufactured flow`,
      ``,
      `Gorktimus is designed to weigh the stack, not just one signal in isolation.`
    ].join("\n");
  }

  return [
    `🧠 <b>Gorktimus AI Assistant</b>`,
    ``,
    `Ask about liquidity, volume, transactions, traps, rugs, honeypots, taxes, or scan logic.`,
    `This mode is designed to explain what the terminal is seeing in plain language.`
  ].join("\n");
}

// ================= SCREENS =================
async function showMainMenu(chatId) {
  const pulse = await getNetworkPulse();
  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b> ${getDevModeStatus()}\n\n${pulse}\n\nLive intelligence. On-demand execution.\nNo clutter. No spam.\n\nSelect an operation below.`,
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
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🐋 <b>Whale Tracker</b>\nTrack named wallets and monitor movement on demand.`,
    buildWhaleMenu()
  );
}

async function showInviteFriends(chatId) {
  const botLink = buildBotDeepLink();
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🚀 <b>Invite Friends</b>`,
    ``,
    botLink ? `Share this bot link:\n${escapeHtml(botLink)}` : `Bot username not detected yet.`,
    ``,
    `X Community: ${escapeHtml(COMMUNITY_X_URL)}`,
    `Telegram Community: ${escapeHtml(COMMUNITY_TELEGRAM_URL)}`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton("refresh:invite"));
}

async function promptScanToken(chatId) {
  pendingAction.set(chatId, { type: "SCAN_TOKEN" });
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 Send a token ticker, token address, or pair search.`,
    buildMainMenuOnlyButton("scan_token")
  );
}
// ================= SMART INPUT HELPERS =================

function extractFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : "";
}

function extractAddressCandidates(text) {
  const matches = String(text || "").match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  return matches ? [...new Set(matches)] : [];
}

function detectChainFromInput(text) {
  const value = String(text || "").trim();
  const lower = value.toLowerCase();

  if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
    return "evm";
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return "solana";
  }

  if (lower.includes("geckoterminal.com/base") || lower.includes("dexscreener.com/base")) {
    return "base";
  }

  if (lower.includes("geckoterminal.com/eth") || lower.includes("dexscreener.com/ethereum")) {
    return "ethereum";
  }

  if (lower.includes("geckoterminal.com/solana") || lower.includes("dexscreener.com/solana")) {
    return "solana";
  }

  if (lower.includes("birdeye.so") && lower.includes("chain=solana")) {
    return "solana";
  }

  if (lower.includes("birdeye.so") && lower.includes("chain=ethereum")) {
    return "ethereum";
  }

  if (lower.includes("birdeye.so") && lower.includes("chain=base")) {
    return "base";
  }

  return "unknown";
}

function parseDexUrl(text) {
  const rawUrl = extractFirstUrl(text);
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/^\/+|\/+$/g, "");
    const pathParts = pathname.split("/").filter(Boolean);
    const searchParams = url.searchParams;

    // DexScreener: /{chain}/{address}
    if (hostname.includes("dexscreener.com") && pathParts.length >= 2) {
      return {
        source: "dexscreener",
        chainId: String(pathParts[0] || "").toLowerCase(),
        address: String(pathParts[1] || "").trim(),
        inputType: "pair_or_token_url"
      };
    }

    // GeckoTerminal: /{chain}/pools/{address}
    if (
      hostname.includes("geckoterminal.com") &&
      pathParts.length >= 3 &&
      String(pathParts[1]).toLowerCase() === "pools"
    ) {
      let chainId = String(pathParts[0] || "").toLowerCase();
      if (chainId === "eth") chainId = "ethereum";

      return {
        source: "geckoterminal",
        chainId,
        address: String(pathParts[2] || "").trim(),
        inputType: "pair_url"
      };
    }

    // BirdEye: /token/{address}?chain=solana
    if (
      hostname.includes("birdeye.so") &&
      pathParts.length >= 2 &&
      String(pathParts[0]).toLowerCase() === "token"
    ) {
      return {
        source: "birdeye",
        chainId: String(searchParams.get("chain") || "unknown").toLowerCase(),
        address: String(pathParts[1] || "").trim(),
        inputType: "token_url"
      };
    }

    return {
      source: "url",
      chainId: detectChainFromInput(rawUrl),
      address: "",
      inputType: "url"
    };
  } catch (_) {
    return null;
  }
}

function detectInputType(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();

  if (!raw) {
    return {
      type: "unknown",
      chainHint: "unknown",
      value: raw
    };
  }

  const parsedUrl = parseDexUrl(raw);
  if (parsedUrl) {
    return {
      type: parsedUrl.inputType,
      chainHint: parsedUrl.chainId || "unknown",
      value: parsedUrl.address || raw,
      meta: parsedUrl
    };
  }

  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    return {
      type: "evm_address",
      chainHint: "evm",
      value: raw
    };
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
    return {
      type: "solana_address",
      chainHint: "solana",
      value: raw
    };
  }

  const addresses = extractAddressCandidates(raw);
  if (addresses.length === 1) {
    const addr = addresses[0];
    return {
      type: addr.startsWith("0x") ? "evm_address" : "solana_address",
      chainHint: addr.startsWith("0x") ? "evm" : "solana",
      value: addr
    };
  }

  const questionWords = [
    "what", "why", "how", "is", "can", "should",
    "explain", "compare", "analyze", "check", "tell"
  ];

  if (questionWords.some(word => lower.startsWith(word + " "))) {
    return {
      type: "question",
      chainHint: "unknown",
      value: raw
    };
  }

  if (/^[A-Za-z0-9_.$-]{2,24}$/.test(raw) && !raw.startsWith("/")) {
    return {
      type: "ticker",
      chainHint: "unknown",
      value: raw
    };
  }

  return {
    type: "text",
    chainHint: detectChainFromInput(raw),
    value: raw
  };
}
async function runTokenScan(chatId, query, userId = null) {
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 <b>Scanning</b>\n\nPulling live structure and risk data for <b>${escapeHtml(query)}</b>...`,
    buildMainMenuOnlyButton("scan_token")
  );
const inputInfo = detectInputType(query);

if (inputInfo.type === "ticker") {
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⚠️ <b>Ticker-only scan detected</b>\n\nMultiple coins can share the same ticker.\n\nFor an exact result, paste the <b>contract address</b> or DexScreener token link.`,
    buildMainMenuOnlyButton("scan_token")
  );
  return;
}
  const pair = await resolveBestPair(query, false);

  if (userId) {
    await setUserSetting(userId, "last_scan_query", String(query || ""));
    await trackScan(userId);
  }

  if (!pair) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 <b>Token Scan</b>\n\nNo solid token match was found for <b>${escapeHtml(query)}</b>.`,
      buildMainMenuOnlyButton("scan_token")
    );
    return;
  }

  const snapshotPromise = savePairMemorySnapshot(pair).catch(() => {});
  const cardPromise = buildScanCard(pair, "🔎 <b>Token Scan</b>", userId);

  const card = await cardPromise;
  snapshotPromise.catch(() => {});

  await sendCard(chatId, card, buildScanActionButtons(pair, query), "");
updateSessionMemory(chatId, {
  lastScan: {
    query,
    symbol: pair?.baseSymbol || "",
    name: pair?.baseName || "",
    tokenAddress: pair?.baseAddress || "",
    chainId: pair?.chainId || "",
    priceUsd: pair?.priceUsd || "",
    liquidityUsd: pair?.liquidityUsd || "",
    marketCap: pair?.marketCap || ""
     }
});
}
async function showTrending(chatId, userId = null) {
  const boosts = await fetchLatestBoosts();
  const top = boosts
    .filter((x) => supportsChain(x.chainId))
    .slice(0, 10);

  if (!top.length) {
    await sendText(
      chatId,
      `🧠 <b>Trending</b>\n\nNo live boosted candidates returned right now.`,
      buildMainMenuOnlyButton("refresh:trending")
    );
    return;
  }

  const pairs = [];

  for (const item of top) {
    const chainId = String(item.chainId || "").toLowerCase();
    const tokenAddress = String(item.tokenAddress || "");
    if (!tokenAddress) continue;

    const pair = await resolveTokenToBestPair(chainId, tokenAddress, true);
    if (!pair) continue;

    pairs.push(pair);
  }

  if (!pairs.length) {
    await sendText(
      chatId,
      `🧠 <b>Trending</b>\n\nNo live trending pairs could be resolved right now.`,
      buildMainMenuOnlyButton("refresh:trending")
    );
    return;
  }

  const lines = [
    `🧠 <b>Trending</b>`,
    ``,
    `This list is not meant to match Dex line-for-line. It is a quick live discovery layer. A Live momentum board ranked by current attention, chain activity, and surface strength — not just hype alone.`,
    ``
  ];

  for (const [index, pair] of pairs.entries()) {
    lines.push(buildMiniSignalCard(pair, index + 1));
  }

  await sendText(
    chatId,
    lines.join("\n\n"),
    buildSignalListButtons(pairs, "refresh:trending")
  );
}

async function showLaunchRadar(chatId) {
  const profiles = await fetchLatestProfiles();
  const candidates = [];

  for (const p of profiles.slice(0, 25)) {
    if (!supportsChain(p.chainId)) continue;
    const pair = await resolveTokenToBestPair(p.chainId, p.tokenAddress, true);
    if (!pair) continue;

    const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
    if (
      pair.liquidityUsd >= LAUNCH_MIN_LIQ_USD &&
      pair.volumeH24 >= LAUNCH_MIN_VOL_USD &&
      ageMin <= 1440
    ) {
      candidates.push(pair);
    }

    if (candidates.length >= 3) break;
  }

  if (!candidates.length) {
    await sendText(
      chatId,
      `🧠 <b>Launch Radar</b>\n\nNo fresh launches passed minimum live filters right now.`,
      buildMainMenuOnlyButton("refresh:launch_radar")
    );
    return;
  }

  const lines = [
    `🧠 <b>Launch Radar</b>`,
    ``,
    `These are more than just newly realeased tokens. These are the earliest live opportunities with enough liquidity, movement, and structure to deserve attention.`,
    ``
  ];

  for (const [index, pair] of candidates.entries()) {
    lines.push(buildMiniSignalCard(pair, index + 1));
  }

  await sendText(
    chatId,
    lines.join("\n\n"),
    buildSignalListButtons(candidates, "refresh:launch_radar")
  );
}

async function showPrimePicks(chatId) {
  const profiles = await fetchLatestProfiles();
  const picks = [];

  for (const p of profiles.slice(0, 30)) {
    if (!supportsChain(p.chainId)) continue;
    const pair = await resolveTokenToBestPair(p.chainId, p.tokenAddress);
    if (!pair) continue;

    const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
    if (
      pair.liquidityUsd >= PRIME_MIN_LIQ_USD &&
      pair.volumeH24 >= PRIME_MIN_VOL_USD &&
      ageMin >= PRIME_MIN_AGE_MIN
    ) {
      picks.push(pair);
    }

    if (picks.length >= 5) break;
  }

  if (!picks.length) {
    await sendText(
      chatId,
      `🧠 <b>Prime Picks</b>\n\nNo candidates passed current stronger-structure filters.`,
      buildMainMenuOnlyButton("refresh:prime_picks")
    );
    return;
  }

  const lines = [
    `🧠 <b>Prime Picks</b>`,
    ``,
    `Prime Picks are meant to surface stronger-looking opportunities that have better overall structure than average runners. They are not guaranteed winners, but they pass a higher quality bar.`,
    ``
  ];

  for (const [index, pair] of picks.entries()) {
    lines.push(buildMiniSignalCard(pair, index + 1));
  }

  await sendText(
    chatId,
    lines.join("\n\n"),
    buildSignalListButtons(picks, "refresh:prime_picks")
  );
}

async function showWatchlist(chatId) {
  const rows = await getWatchlistItems(chatId);
  const count = await getWatchlistCount(chatId);

  if (!rows.length) {
    await sendText(
      chatId,
      `🧠 <b>Watchlist</b>\n\nNo saved tokens yet.\n\nUse any scan result and tap <b>Add Watchlist</b>.\n\nCurrent count: ${count}/${MAX_WATCHLIST_ITEMS}`,
      buildMainMenuOnlyButton("refresh:watchlist")
    );
    return;
  }

  await sendText(
    chatId,
    `🧠 <b>Watchlist</b>\n\nSaved items: ${count}/${MAX_WATCHLIST_ITEMS}`,
    buildWatchlistMenu(rows)
  );
}

async function showModeLab(chatId, userId) {
  const settings = await getUserSettings(userId);
  await sendText(
    chatId,
    `🧠 <b>Mode Lab</b>\n\nCurrent mode: <b>${escapeHtml(modeTitle(settings.mode))}</b>\n\nAggressive = Earlier entries, more tolerance for fresh or hotter setups and slightly more permissive\nBalanced = Strongest default for most users or in other words middle ground\nGuardian = Stricter defense better if you want cleaner structure and less tolerance for weak liquidity or concentration risk`,
    buildModeMenu(settings.mode)
  );
}

async function showAlertCenter(chatId, userId) {
  const settings = await getUserSettings(userId);
  await sendText(
    chatId,
    `🧠 <b>Alert Center</b>\n\nControl what types of intelligence alerts are allowed for your account.`,
    buildAlertCenterMenu(settings)
  );
}

async function showEdgeBrain(chatId) {
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Edge Brain</b>\n\nGorktimus Edge is the advanced defense brain of the terminal — the layer that goes beyond basic token stats and turns raw market activity into real protective intelligence.\n\nIt is built to detect traps, read behavior patterns, analyze launch structure, judge momentum quality, flag suspicious wallet and liquidity movement, and explain in plain language why a token may be safe, risky, manipulated, or worth watching.\n\nInstead of just showing numbers, Edge is meant to act like a live guardian system that studies what the token is doing, how it is moving, who may be controlling it, and what that means for the user before they make a decision.`,
    buildMainMenuOnlyButton("refresh:edge_brain")
  );
}



async function showWalletList(chatId, type) {
  const rows = await all(
    `SELECT * FROM wallet_tracks WHERE chat_id = ? AND label_type = ? AND active = 1 ORDER BY updated_at DESC`,
    [String(chatId), type]
  );

  if (!rows.length) {
    await sendText(
      chatId,
      `🧠 <b>${type === "whale" ? "Whale" : "Dev"} List</b>\n\nNothing tracked yet.`,
      buildMainMenuOnlyButton("refresh:wallets")
    );
    return;
  }

  await sendText(
    chatId,
    `🧠 <b>${type === "whale" ? "Whale" : "Dev"} List</b>\n\nTap a wallet below.`,
    buildWalletListMenu(rows, type)
  );
}

// ================= WALLET TRACKING =================
async function addWalletTrack(chatId, wallet, labelType, nickname) {
  const ts = nowTs();
  if (!isLikelySolanaWallet(wallet)) {
    await sendText(
      chatId,
      `🧠 <b>Wallet Tracker</b>\n\nThat does not look like a valid Solana wallet address.`,
      buildMainMenuOnlyButton("refresh:wallets")
    );
    return;
  }

  await run(
    `INSERT INTO wallet_tracks (chat_id, wallet, label_type, nickname, chain_id, active, alerts_enabled, last_signature, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'solana', 1, 1, '', 0, ?, ?)
     ON CONFLICT(chat_id, wallet, label_type) DO UPDATE SET
       nickname = excluded.nickname,
       active = 1,
       updated_at = excluded.updated_at`,
    [String(chatId), wallet.trim(), labelType, nickname.trim(), ts, ts]
  );

  await sendText(
    chatId,
    `🧠 <b>Wallet Saved</b>\n\nType: <b>${escapeHtml(labelType)}</b>\nName: <b>${escapeHtml(nickname)}</b>\nWallet: <code>${escapeHtml(wallet)}</code>`,
    buildMainMenuOnlyButton("refresh:wallets")
  );
}

// ================= CALLBACK ACTIONS =================
async function handleWatchOpen(chatId, userId, chainId, tokenAddress) {
  const pair = await resolveTokenToBestPair(chainId, tokenAddress);
  if (!pair) {
    await sendText(chatId, `🧠 <b>Watchlist</b>\n\nCould not resolve this token right now.`, buildMainMenuOnlyButton("refresh:watchlist"));
    return;
  }
  const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
  const text = await buildScanCard(pair, "👁 <b>Watchlist Item</b>", userId);
  await sendCard(chatId, text, buildWatchlistItemMenu(pair), imageUrl);
}

async function handleRefresh(chatId, userId, key) {
  if (key === "main") return showMainMenu(chatId);
  if (key === "help") return showHelpMenu(chatId);
  if (key === "trending") return showTrending(chatId, userId);
  if (key === "launch_radar") return showLaunchRadar(chatId);
  if (key === "prime_picks") return showPrimePicks(chatId);
  if (key === "watchlist") return showWatchlist(chatId);
  if (key === "mode_lab") return showModeLab(chatId, userId);
  if (key === "alert_center") return showAlertCenter(chatId, userId);
  if (key === "edge_brain") return showEdgeBrain(chatId);
  if (key === "wallets") return showWhaleMenu(chatId);
  if (key === "ai") return showAIAssistant(chatId);
  if (key === "invite") return showInviteFriends(chatId);
}

// ================= COMMANDS =================
// ================= COMMANDS =================
bot.onText(/\/start/, async (msg) => {
  try {
    if (DEV_MODE && String(msg.from?.id) !== OWNER_USER_ID) {
      await sendText(msg.chat.id, "🚫 Development mode. Access denied.");
      return;
    }

    const ok = await ensureSubscribedOrBlock(msg);
    await upsertUserFromMessage(msg, ok ? 1 : 0);
    await ensureUserSettings(msg.from.id);
    await trackUserActivity(msg.from.id);
    if (!ok) return;
    await showMainMenu(msg.chat.id);
  } catch (err) {
    console.log("/start error:", err.message);
  }
});

// ================= MESSAGE HANDLER =================
async function showAIAssistant(chatId) {
  pendingAction.set(chatId, { type: "AI" });
  return sendText(
    chatId,
    "🤖 <b>AI mode ON.</b>\n\nSend me a message.",
    buildAIAssistantMenu()
  );
}
async function getTelegramPhotoUrl(photo) {
  const best = photo[photo.length - 1];
  if (!best?.file_id) return null;

  const file = await bot.getFile(best.file_id);
  if (!file?.file_path) return null;

  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
}
bot.on("message", async (msg) => {
  try {
    if (DEV_MODE && String(msg.from?.id) !== OWNER_USER_ID) {
      return;
    }

    if (!isPrivateChat(msg)) return;
    if (!msg?.from?.id || !msg?.chat?.id) return;
    if (msg.text && msg.text.startsWith("/start")) return;

    const ok = await ensureSubscribedOrBlock(msg);
    await upsertUserFromMessage(msg, ok ? 1 : 0);
    await ensureUserSettings(msg.from.id);
    await trackUserActivity(msg.from.id);
    if (!ok) return;

    const chatId = msg.chat.id;
    const cleaned = String(msg.text || msg.caption || "").trim();
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    let imageUrl = null;

    if (hasPhoto) {
      imageUrl = await getTelegramPhotoUrl(msg.photo);
    }
    if (!cleaned && !hasPhoto) return;
    const pending = pendingAction.get(chatId);
   
    if (pending?.type === "SCAN_TOKEN") {
      pendingAction.delete(chatId);
      await runTokenScan(chatId, cleaned, msg.from.id);
      return;
    }

    if (pending?.type === "ADD_WHALE") {
      pendingAction.set(chatId, { type: "ADD_WHALE_NAME", wallet: cleaned });
      await sendText(chatId, `Send the nickname for this whale wallet.`, buildMainMenuOnlyButton("refresh:wallets"));
      return;
    }

    if (pending?.type === "ADD_WHALE_NAME") {
      const wallet = pending.wallet;
      pendingAction.delete(chatId);
      await addWalletTrack(chatId, wallet, "whale", cleaned || "Whale");
      return;
    }

    if (pending?.type === "ADD_DEV") {
      pendingAction.set(chatId, { type: "ADD_DEV_NAME", wallet: cleaned });
      await sendText(chatId, `Send the nickname for this dev wallet.`, buildMainMenuOnlyButton("refresh:wallets"));
      return;
    }

    if (pending?.type === "ADD_DEV_NAME") {
      const wallet = pending.wallet;
      pendingAction.delete(chatId);
      await addWalletTrack(chatId, wallet, "dev", cleaned || "Dev");
      return;
    }

    if (pending?.type === "CHECK_WALLET") {
      pendingAction.delete(chatId);
      await sendText(
        chatId,
        `🧠 <b>Wallet Check</b>\n\nWallet checks are wired as a shell right now.\nWallet: <code>${escapeHtml(cleaned)}</code>`,
        buildMainMenuOnlyButton("refresh:wallets")
      );
      return;
    }

if (pending?.type === "AI") {
  const reply = await askAI({
    text: cleaned || "Analyze this image.",
    chatId,
    imageUrl
  });

  await sendText(
    chatId,
    `🤖 <b>Gorktimus AI Assistant</b>\n\n${escapeHtml(reply)}`,
    buildAIAssistantMenu()
  );
  return;
}

    if (isAddressLike(cleaned)) {
      await runTokenScan(chatId, cleaned, msg.from.id);
      return;
    }

    if (/^[A-Za-z0-9_.$-]{2,24}$/.test(cleaned) && !cleaned.startsWith("/")) {
      await runTokenScan(chatId, cleaned, msg.from.id);
    }
  } catch (err) {
  console.log("message handler error:", err.message);
console.log(err.stack);
  }
});

// ================= CALLBACKS =================
bot.on("callback_query", async (query) => {
  if (DEV_MODE && String(query.from?.id) !== OWNER_USER_ID) {
    try {
      await answerCallbackSafe(query.id, "🚫 Terminal in development.");
    } catch (e) {
      console.log("DEV BLOCK ERROR:", e.message);
    }
    return;
  }

  const chatId = query?.message?.chat?.id;
  const userId = query?.from?.id;
  const data = String(query?.data || "");

  if (!isPrivateChat(query)) {
    await answerCallbackSafe(query.id);
    return;
  }

  try {
    const ok = await ensureSubscribedOrBlock(query);
    if (!ok) {
      await answerCallbackSafe(query.id);
      return;
    }

    if (data.startsWith("watch_rescan:")) {
      const parts = data.split(":");
      const tokenAddress = parts[2];
      await answerCallbackSafe(query.id);
      return await runTokenScan(chatId, tokenAddress, userId);
    }

    await answerCallbackSafe(query.id);

    if (data === "main_menu") return showMainMenu(chatId);
    if (data === "scan_token") return promptScanToken(chatId);
    if (data === "trending") return showTrending(chatId, userId);
    if (data === "launch_radar") return showLaunchRadar(chatId);
    if (data === "prime_picks") return showPrimePicks(chatId);
    if (data === "watchlist") return showWatchlist(chatId);
    if (data === "mode_lab") return showModeLab(chatId, userId);
    if (data === "alert_center") return showAlertCenter(chatId, userId);
    if (data === "edge_brain") return showEdgeBrain(chatId);
   if (data === "ai_assistant") {
  pendingAction.set(chatId, { type: "AI" });
  return sendText(
    chatId,
    "🤖 <b>AI mode ON.</b>\n\nSend me a message.",
  buildAIAssistantMenu()
  );
}
    if (data === "help_menu") return showHelpMenu(chatId);
    if (data === "whale_menu") return showWhaleMenu(chatId);
    if (data === "invite_friends") return showInviteFriends(chatId);
    if (data === "check_subscription") return showMainMenu(chatId);

   if (data === "help_engine") {
  return sendText(
    chatId,
    `🧠 <b>How Gorktimus Works</b>

Gorktimus is built as a live crypto intelligence terminal, not a simple market mirror.

The stack does three different jobs:
• discovers active pairs
• scores structural risk and opportunity
• explains the result in plain language

That means it is trying to answer a harder question than “what is moving?”

It is trying to answer:
“what is moving, how clean is it, and what could be hiding underneath that movement?”

So when you scan a token, you are not just getting price and liquidity.

You are also getting:
• holder concentration context  
• contract transparency clues  
• behavior signals  
• memory bias from prior outcomes  
• mode-aware score shaping`,
    buildHelpMenu()
  );
}

if (data === "help_dex_diff") {
  return sendText(
    chatId,
    `🧠 <b>Why Gorktimus Differs From Dex</b>

Dex is a raw activity feed.
Gorktimus is a filtered intelligence layer.

Dex can surface tokens because they are simply loud:
• volume spikes
• transaction bursts
• paid boosts
• very early launches

Gorktimus can deliberately rank those lower if the structure looks weak:
• thin liquidity
• suspicious holder concentration
• dangerous tax / honeypot signals
• poor contract transparency
• one-sided or spammy transaction patterns

So if a token is high on Dex but lower here, that usually means the terminal thinks the raw noise is stronger than the underlying structure.`,
    buildHelpMenu()
  );
}
    if (data === "help_score") {
      return sendText(chatId, `🧠 <b>Safety Score</b>\n\nSafety Score blends liquidity, age, flow, transparency, holder structure, and trap risk into one defense-first read.`, buildHelpMenu());
    }

    if (data === "help_transactions") {
      return sendText(chatId, buildAssistantGenericReply("transactions"), buildHelpMenu());
    }

    if (data === "help_sources") {
      return sendText(chatId, `🧠 <b>Data Sources</b>\n\nDexScreener powers market discovery.\nHelius supports Solana holder reads when connected.\nHoneypot / top-holder / Etherscan checks support EVM chains when available.`, buildHelpMenu());
    }

    if (data === "help_community") {
      return sendText(chatId, `🧠 <b>Community</b>\n\nX: ${escapeHtml(COMMUNITY_X_URL)}\nTelegram: ${escapeHtml(COMMUNITY_TELEGRAM_URL)}`, buildHelpMenu());
    }

    if (data === "add_whale") {
      pendingAction.set(chatId, { type: "ADD_WHALE" });
      return sendText(chatId, `Send the Solana wallet address you want to save as a whale wallet.`, buildMainMenuOnlyButton("refresh:wallets"));
    }

    if (data === "add_dev") {
      pendingAction.set(chatId, { type: "ADD_DEV" });
      return sendText(chatId, `Send the Solana wallet address you want to save as a dev wallet.`, buildMainMenuOnlyButton("refresh:wallets"));
    }

    if (data === "check_wallet") {
      pendingAction.set(chatId, { type: "CHECK_WALLET" });
      return sendText(chatId, `Send the wallet address you want to check.`, buildMainMenuOnlyButton("refresh:wallets"));
    }

    if (data === "whale_list") return showWalletList(chatId, "whale");
    if (data === "dev_list") return showWalletList(chatId, "dev");
    if (data === "wallet_alert_settings") return sendText(chatId, `🧠 <b>Wallet Alerts</b>\n\nWallet alerts are controlled through the saved wallet item toggles.`, buildMainMenuOnlyButton("refresh:wallets"));

    if (data.startsWith("wallet_item:")) {
      const id = data.split(":")[1];
      const row = await get(`SELECT * FROM wallet_tracks WHERE id = ?`, [String(id)]);
      if (!row) return sendText(chatId, `Wallet not found.`, buildMainMenuOnlyButton("refresh:wallets"));
      return sendText(
        chatId,
        `🧠 <b>Tracked Wallet</b>\n\nType: <b>${escapeHtml(row.label_type)}</b>\nName: <b>${escapeHtml(row.nickname || "Unnamed")}</b>\nWallet: <code>${escapeHtml(row.wallet)}</code>\nAlerts: <b>${row.alerts_enabled ? "On" : "Off"}</b>`,
        buildWalletItemMenu(row)
      );
    }

    if (data.startsWith("wallet_toggle:")) {
  const id = data.split(":")[1];
  await run(
    `UPDATE wallet_tracks
     SET alerts_enabled = CASE WHEN alerts_enabled = 1 THEN 0 ELSE 1 END,
         updated_at = ?
     WHERE id = ?`,
    [nowTs(), String(id)]
  );
  return showWhaleMenu(chatId);
}

    if (data.startsWith("wallet_remove:")) {
      const id = data.split(":")[1];
      await run(`DELETE FROM wallet_tracks WHERE id = ?`, [String(id)]);
      return showWhaleMenu(chatId);
    }

    if (data.startsWith("wallet_check:")) {
      const id = data.split(":")[1];
      const row = await get(`SELECT * FROM wallet_tracks WHERE id = ?`, [String(id)]);
      if (!row) return sendText(chatId, `Wallet not found.`, buildMainMenuOnlyButton("refresh:wallets"));
      return sendText(
        chatId,
        `🧠 <b>Wallet Check</b>\n\nWallet: <code>${escapeHtml(row.wallet)}</code>\nThis shell is active. Add your preferred wallet intelligence flow here next.`,
        buildWalletItemMenu(row)
      );
    }

    if (data.startsWith("wallet_rename:")) {
      return sendText(chatId, `Rename flow can be added next.`, buildMainMenuOnlyButton("refresh:wallets"));
    }

    if (data.startsWith("set_mode:")) {
      const mode = data.split(":")[1];
      await setUserSetting(userId, "mode", safeMode(mode));
      return showModeLab(chatId, userId);
    }

    if (data.startsWith("toggle_setting:")) {
      const field = data.split(":")[1];
      const settings = await getUserSettings(userId);
      const next = num(settings[field]) ? 0 : 1;
      await setUserSetting(userId, field, next);
      return showAlertCenter(chatId, userId);
    }

    if (data.startsWith("scan_direct:")) {
      const [, chainId, tokenAddress] = data.split(":");
      return runTokenScan(chatId, tokenAddress, userId);
    }
if (data.startsWith("watchadd:")) {
  const payload = getShortCallbackPayload(data);
  if (!payload) {
    return sendText(
      chatId,
      `Callback expired. Please rescan the token.`,
      buildMainMenuOnlyButton()
    );
  }

  await addToWatchlist(chatId, payload.chainId, payload.tokenAddress);
  return sendText(
    chatId,
    `👁 Token added to watchlist.`,
    buildMainMenuOnlyButton("refresh:watchlist")
  );
}

if (data.startsWith("feedbackgood:")) {
  const payload = getShortCallbackPayload(data);
  if (!payload) {
    return sendText(chatId, `Feedback callback expired. Please rescan the token.`, buildMainMenuOnlyButton());
  }

  const pair = await resolveTokenToBestPair(payload.chainId, payload.tokenAddress);
  if (!pair) {
    return sendText(chatId, `Could not resolve token for feedback save.`, buildMainMenuOnlyButton());
  }

  const verdict = await buildRiskVerdict(pair, userId);
  await addScanFeedback(userId, pair, "good", verdict.score);
  return sendText(chatId, `🧠 <b>Feedback Saved</b>\n\nMarked as: <b>good</b>`, buildMainMenuOnlyButton());
}

if (data.startsWith("feedbackbad:")) {
  const payload = getShortCallbackPayload(data);
  if (!payload) {
    return sendText(chatId, `Feedback callback expired. Please rescan the token.`, buildMainMenuOnlyButton());
  }

  const pair = await resolveTokenToBestPair(payload.chainId, payload.tokenAddress);
  if (!pair) {
    return sendText(chatId, `Could not resolve token for feedback save.`, buildMainMenuOnlyButton());
  }

  const verdict = await buildRiskVerdict(pair, userId);
  await addScanFeedback(userId, pair, "bad", verdict.score);
  return sendText(chatId, `🧠 <b>Feedback Saved</b>\n\nMarked as: <b>bad</b>`, buildMainMenuOnlyButton());
}
    if (data.startsWith("watch_add:")) {
      const [, chainId, tokenAddress] = data.split(":");
      const pair = await resolveTokenToBestPair(chainId, tokenAddress);
      if (!pair) return sendText(chatId, `Could not resolve token for watchlist.`, buildMainMenuOnlyButton("refresh:watchlist"));
      await addWatchlistItem(chatId, pair);
      return sendText(chatId, `👁 <b>Added to Watchlist</b>\n\n${escapeHtml(pair.baseSymbol || pair.baseAddress)}`, buildMainMenuOnlyButton("refresh:watchlist"));
    }

    if (data.startsWith("watch_open:")) {
      const [, chainId, tokenAddress] = data.split(":");
      return handleWatchOpen(chatId, userId, chainId, tokenAddress);
    }

    if (data.startsWith("watch_rescan:")) {
      const [, chainId, tokenAddress] = data.split(":");
      return runTokenScan(chatId, tokenAddress, userId);
    }

    if (data.startsWith("watch_remove:")) {
      const [, chainId, tokenAddress] = data.split(":");
      await removeWatchlistItem(chatId, chainId, tokenAddress);
      return showWatchlist(chatId);
    }

    if (data.startsWith("feedback:")) {
      const [, feedback, chainId, tokenAddress] = data.split(":");
      const pair = await resolveTokenToBestPair(chainId, tokenAddress);
      if (!pair) return sendText(chatId, `Could not resolve token for feedback save.`, buildMainMenuOnlyButton());
      const verdict = await buildRiskVerdict(pair, userId);
      await addScanFeedback(userId, pair, feedback, verdict.score);
      return sendText(chatId, `🧠 <b>Feedback Saved</b>\n\nMarked as: <b>${escapeHtml(feedback)}</b>`, buildMainMenuOnlyButton());
    }

    if (data.startsWith("refresh_scan:")) {
      const queryText = decodeURIComponent(data.split(":")[1] || "");
      return runTokenScan(chatId, queryText, userId);
    }

    if (data.startsWith("refresh:")) {
      const key = data.split(":")[1];
      return handleRefresh(chatId, userId, key);
    }
  } catch (err) {
    console.log("callback error:", err.message);
    await sendText(chatId, `🧠 <b>Gorktimus</b>\n\nSomething broke in the callback flow.\n\nError: <code>${escapeHtml(err.message)}</code>`, buildMainMenuOnlyButton());
  }


// ================= BOOT =================
(async () => {
  try {
    await initDb();
    const me = await bot.getMe();
    BOT_USERNAME = me?.username || "";
    console.log(`✅ Gorktimus online as @${BOT_USERNAME || "unknown_bot"}`);
  } catch (err) {
    console.error("❌ Boot error:", err.message);
    process.exit(1);
  }
})();

process.on("SIGINT", () => {
  try {
    db.close();
  } catch (_) {}
  process.exit(0);
});

process.on("SIGTERM", () => {
  try {
    db.close();
  } catch (_) {}
  process.exit(0);
}); 15
