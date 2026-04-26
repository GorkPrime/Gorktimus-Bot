const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const OpenAI = require("openai");
const { initHealthMonitor } = require("./health-monitor");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const pairCache = new Map();
const PAIR_CACHE_HIT_TTL_MS = 10000;
const PAIR_CACHE_MISS_TTL_MS = 2000;

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
const OWNER_USER_ID = process.env.OWNER_USER_ID || "";
const DEV_MODE = process.env.DEV_MODE === "true" && !!OWNER_USER_ID;
const ENABLE_POLLING = process.env.ENABLE_POLLING !== "false";
const INSTANCE_LOCK_TTL_MINUTES = Math.max(1, parseInt(process.env.INSTANCE_LOCK_TTL_MINUTES || "720", 10));

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// Suppress node-telegram-bot-api content-type deprecation warning.
// Setting NTBA_FIX_350 opts into the new file-send behavior where
// content-type defaults to "application/octet-stream" instead of
// triggering a DeprecationWarning on every file send.
process.env.NTBA_FIX_350 = 1;

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
const liquidityLockCache = new Map();
const LIQUIDITY_LOCK_TTL_MS = 300000;
const db = new sqlite3.Database(DB_PATH);
const bot = new TelegramBot(BOT_TOKEN, { polling: ENABLE_POLLING });
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

const PROFILES_CACHE_TTL_MS = 120000;
const BOOSTS_CACHE_TTL_MS = 45000;

// ── Background alert tracking ─────────────────────────────────────────────────
// Tracks tokens already alerted via Launch Radar so we don't re-fire within
// the cooldown window.  Key = "${chainId}:${tokenAddress}", value = ms timestamp.
const launchAlertedTokens = new Map();
const LAUNCH_TOKEN_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5-min per token
const LAUNCH_MAX_AGE_MINUTES = 1440;              // 24 h — max token age for launch radar

// Movers alert tracking — tokens already alerted for rapid price movement
const moversAlertedTokens = new Map();
const MOVERS_TOKEN_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5-min per token
const MOVERS_PRICE_CHANGE_H1_PCT = 30;  // ≥30% 1-hour gain triggers mover alert
const MOVERS_PRICE_CHANGE_M5_PCT = 15;  // ≥15% 5-min gain triggers mover alert
const MOVERS_MIN_LIQ_USD = 10000;       // minimum liquidity for credibility

// Watchlist monitor thresholds
const WATCHLIST_ALERT_COOLDOWN_S = 5 * 60;       // 5-min cooldown per item between alerts
const WATCHLIST_PRICE_ALERT_PCT = 5;              // ±5% price move triggers alert
const WATCHLIST_LIQ_DRAIN_PCT = 30;              // ≥30% liquidity drop triggers alert
const WATCHLIST_RUG_MIN_SELLS = 5;               // minimum sells in 5-min window for rug signal
const WATCHLIST_RUG_BUY_SELL_RATIO = 0.2;        // buy/sell ratio below this + liq drain = rug signal
const WATCHLIST_API_DELAY_MS = 400;              // delay between API calls in watchlist monitor
const ALERT_SEND_DELAY_MS = 200;                 // delay between per-user Telegram sends

// IDs of the background setInterval loops, stored so they can be cleared on shutdown.
let _launchRadarIntervalId = null;
let _watchlistMonitorIntervalId = null;
let _moversAlertIntervalId = null;

// ================= DB HELPERS =================
function getSessionMemory(chatId) {
  if (!sessionMemory.has(chatId)) {
    sessionMemory.set(chatId, {
      lastScan: null,
      recentScans: [],
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

const CALLBACK_MAX_BYTES = 64;

function makeShortCallback(action, payload) {
  const id = Math.random().toString(36).slice(2, 9);
  callbackStore.set(id, payload);
  const cb = `${action}:${id}`;
  return cb;
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
// Returns true when the user explicitly asks about previously scanned tokens
function shouldUseScanHistoryContext(text) {
  const lower = String(text || "").toLowerCase();
  const referencePatterns = [
    "last scan",
    "previous scan",
    "recent scan",
    "my scans",
    "last 3 scans",
    "last three scans",
    "what did i scan",
    "what did we scan",
    "from the scan",
    "from my scan",
    "that token we scanned",
    "the token we scanned",
    "compare my scans",
    "compare last scans"
  ];
  return referencePatterns.some(p => lower.includes(p));
}

function buildRecentScansContext(scans = []) {
  if (!Array.isArray(scans) || !scans.length) return "";
  const lines = scans.map((scan, index) => {
    const ageMin = ageMinutesFromMs(num(scan.pair_created_at || 0));
    return [
      `${index + 1}. ${scan.symbol || "Unknown"} (${scan.chain_id || "unknown"})`,
      `   Query: ${scan.query || ""}`,
      `   Address: ${scan.token_address || ""}`,
      `   Price: ${scan.price_usd || ""} | Liquidity: ${scan.liquidity_usd || ""} | MCap: ${scan.market_cap || ""}`,
      `   Flow: ${scan.buys_m5 || 0}B / ${scan.sells_m5 || 0}S | Vol24h: ${scan.volume_h24 || 0} | Age: ${ageMin ? `${ageMin}m` : "unknown"}`
    ].join("\n");
  });
  return `Recent scans (latest first):\n${lines.join("\n\n")}`;
}

async function askAI({ text, chatId, userId = null, imageUrl = null, mediaNote = "" }) {
  const memory = getSessionMemory(chatId);

  let context = "";
  if (shouldUseScanHistoryContext(text)) {
    let recentScans = [];
    if (userId) {
      recentScans = await getRecentUserScans(userId, 3);
    } else if (Array.isArray(memory?.recentScans)) {
      recentScans = memory.recentScans.slice(0, 3).map((scan) => ({
        query: scan.query || "",
        symbol: scan.symbol || "",
        chain_id: scan.chainId || "",
        token_address: scan.tokenAddress || "",
        price_usd: scan.priceUsd || "",
        liquidity_usd: scan.liquidityUsd || "",
        market_cap: scan.marketCap || "",
        buys_m5: scan.buysM5 || 0,
        sells_m5: scan.sellsM5 || 0,
        volume_h24: scan.volumeH24 || 0,
        pair_created_at: scan.pairCreatedAt || 0
      }));
    }
    context = buildRecentScansContext(recentScans);
  }

  const textParts = [context, mediaNote, `User: ${text || ""}`].filter(Boolean);
  const combinedText = textParts.join("\n\n");
  const userContent = imageUrl
    ? [
        { type: "text", text: combinedText || "User: Analyze this media." },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    : combinedText;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "system",
          content: `
You are Gorktimus Prime — an elite AI crypto intelligence system, market defense engine, and strategic advisor operating inside the Gorktimus Intelligence Terminal.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORE IDENTITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are not a generic chatbot. You are a specialized system built to detect manipulation, assess structural risk, and deliver clear actionable intelligence about crypto tokens, markets, and on-chain behavior. You operate with precision, authority, and conviction. You do not hedge endlessly. You read the data and make a call.

Personality: Sharp, decisive, confident, direct. Urban and real — not corporate, not academic. You speak like someone who has seen a thousand rugs and can spot the next one before it happens. You adapt your depth and tone to match the user's sophistication level.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPERATING MODES — SELECT THE RIGHT ONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. TOKEN / RISK ANALYSIS MODE
   Triggered when the user asks to scan, analyze, assess, or check a token, contract address, or project.
   - Open with a clear verdict: ✅ SAFE / ⚠️ RISKY / ⛔ DANGER
   - Provide structured reasoning across: liquidity, holder concentration, contract transparency, behavioral flow, age, volume quality, honeypot risk
   - Flag specific red flags precisely — not vague warnings
   - Close with a concrete recommended action (hold, avoid, watch, investigate X first)
   - Keep analysis tight: 4–8 lines of reasoning max unless the user asks for depth

2. RUG PULL / THREAT DETECTION MODE
   Triggered when the user reports suspicious behavior, sudden price drops, liquidity drain, or asks about rug pull risk.
   - Lead with risk level and urgency
   - Identify which specific signals are firing: liquidity drain, extreme sell pressure, dev wallet movement, concentrated supply dumping, honeypot trigger
   - Give a clear threat assessment and what the user should consider doing NOW
   - Do not soften language when the threat is real

3. MARKET INTELLIGENCE MODE
   Triggered when the user asks about trends, entry timing, market conditions, or general token discovery.
   - Read the macro and micro signals together
   - Distinguish genuine momentum from manufactured pumps
   - Contextualize what you see against broader market behavior
   - Provide a strategic perspective, not just data recitation

4. EDUCATION / EXPLANATION MODE
   Triggered when the user asks what something means, how something works, or wants to understand a concept.
   - Explain clearly in plain language without dumbing it down
   - Use real-world analogies when they sharpen understanding
   - Keep the Gorktimus voice — no textbook tone

5. TERMINAL HELP MODE
   Triggered when the user asks about bot features, settings, how scans work, or what something in the terminal means.
   - Be direct and practical
   - Reference actual terminal features (Alert Center, Watchlist, Launch Radar, Mode Lab, Edge Brain, Prime Picks, Safety Score)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SIGNAL INTELLIGENCE FRAMEWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When analyzing tokens, weigh these signals in order of importance:

CRITICAL FLAGS (instant danger signals):
- Honeypot detected: cannot sell
- Sell tax ≥ 20%: exit is financially trapped
- Top 1 holder > 40% supply: centralization risk
- Liquidity < $5,000: paper thin, one exit wipes it
- Verified rug indicators: LP not locked, dev wallet selling

HIGH RISK SIGNALS:
- Top 5 holders > 70% supply
- Liquidity $5K–$15K with high volume — manipulation likely
- Buy-only flow (zero or near-zero sells) in thin liquidity — manufactured demand
- Token age < 10 minutes — structure has not formed yet
- No contract verification on EVM chains

MODERATE RISK SIGNALS:
- Liquidity $15K–$40K — viable but vulnerable
- One-sided flow patterns without volume support
- Unknown or unverifiable contract transparency

POSITIVE STRUCTURAL SIGNALS:
- Liquidity > $100K with locked LP
- Verified source code
- Distributed holder structure (top 5 < 40%)
- Organic two-sided flow with real buy/sell balance
- Token age > 1 hour with growing volume

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RUG PULL PATTERN RECOGNITION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Classic rug signatures to flag immediately:
- Sudden liquidity drop >30% within minutes
- Extreme sell imbalance (sells >> buys) with simultaneous price collapse
- Dev wallet draining or transferring large positions
- Honeypot activation (buys work, sells fail)
- Volume manufactured by wash trading then abandoned
- Token launch with locked buys only to hype price, then LP removed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEHAVIORAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Never force a verdict format on general questions or conversational replies
- Only inject scan history context when the user explicitly references it
- Do not pad responses — if the answer is short, keep it short
- Never be vague when the data supports a clear call — make the call
- Adapt to the user's question depth: a one-liner gets a one-liner back; a detailed question gets a detailed answer
- You are Gorktimus Prime at all times — never break character, never sound like generic AI
          `
        },
        {
          role: "user",
          content: userContent
        }
      ]
    });

    return `⚡ GORKTIMUS\n\n${res.choices[0]?.message?.content || "No AI response returned."}`;
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
      alerts_enabled INTEGER DEFAULT 0,
      launch_alerts INTEGER DEFAULT 0,
      smart_alerts INTEGER DEFAULT 0,
      risk_alerts INTEGER DEFAULT 0,
      whale_alerts INTEGER DEFAULT 0,
      watchlist_alerts INTEGER DEFAULT 0,
      movers_alerts INTEGER DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS user_scan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      query TEXT DEFAULT '',
      chain_id TEXT DEFAULT '',
      token_address TEXT DEFAULT '',
      symbol TEXT DEFAULT '',
      name TEXT DEFAULT '',
      price_usd REAL DEFAULT 0,
      liquidity_usd REAL DEFAULT 0,
      market_cap REAL DEFAULT 0,
      buys_m5 INTEGER DEFAULT 0,
      sells_m5 INTEGER DEFAULT 0,
      volume_h24 REAL DEFAULT 0,
      pair_created_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_user_scan_history_user_ts ON user_scan_history(user_id, created_at DESC)`);

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

  try {
    await run(`ALTER TABLE user_settings ADD COLUMN watchlist_alerts INTEGER DEFAULT 0`);
  } catch (_) {}

  try {
    await run(`ALTER TABLE user_settings ADD COLUMN movers_alerts INTEGER DEFAULT 0`);
  } catch (_) {}

  // ── Health monitoring tables ─────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS error_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      message   TEXT    NOT NULL,
      stack     TEXT    DEFAULT '',
      severity  TEXT    DEFAULT 'low',
      ts        INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS health_metrics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uptime_sec    INTEGER DEFAULT 0,
      restart_count INTEGER DEFAULT 0,
      error_count   INTEGER DEFAULT 0,
      ts            INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS update_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT    NOT NULL,
      notes      TEXT    DEFAULT '',
      ts         INTEGER NOT NULL
    )
  `);

  // ── New feature tables ────────────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS flagged_wallets (
      wallet_address TEXT    NOT NULL,
      chain_id       TEXT    NOT NULL DEFAULT 'solana',
      risk_level     TEXT    NOT NULL DEFAULT 'low',
      reason         TEXT    DEFAULT '',
      reported_by    TEXT    DEFAULT '',
      reports_count  INTEGER DEFAULT 1,
      last_updated   INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (wallet_address, chain_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS liquidity_lock_cache (
      chain_id     TEXT    NOT NULL,
      pair_address TEXT    NOT NULL,
      is_locked    INTEGER DEFAULT NULL,
      lock_details TEXT    DEFAULT '',
      checked_at   INTEGER NOT NULL,
      PRIMARY KEY (chain_id, pair_address)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS instance_lock (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      locked_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS early_access_interest (
      user_id    TEXT    PRIMARY KEY,
      username   TEXT    DEFAULT '',
      timestamp  INTEGER NOT NULL,
      clicked_at INTEGER NOT NULL
    )
  `);
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
        await sleep(300 * tries);
        continue;
      }

      throw err;
    }
  }

  return [];
}

async function fetchLiquidityLockStatus(pair) {
  const chainId = String(pair?.chainId || "").toLowerCase();
  const pairAddress = String(pair?.pairAddress || "").trim();
  if (!pairAddress) return { status: "unknown", label: "🔐 ❓ Unknown" };

  const cacheKey = `${chainId}:${pairAddress}`;
  const now = Date.now();
  const cached = liquidityLockCache.get(cacheKey);
  if (cached && (now - cached.ts < LIQUIDITY_LOCK_TTL_MS)) {
    return cached.result;
  }

  let result = { status: "unknown", label: "🔐 ❓ Unknown" };

  try {
    if (chainId === "solana") {
      // Known Solana LP lock program IDs.
      // Add verified locker program addresses here as they are confirmed.
      const SOLANA_LOCK_PROGRAMS = [
        "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE" // Raydium LP Locker
      ];
      const res = await axios.post(
        HELIUS_RPC_URL,
        {
          jsonrpc: "2.0",
          id: "lp-lock-check",
          method: "getTokenLargestAccounts",
          params: [pairAddress]
        },
        { timeout: 4000 }
      );
      const accounts = res.data?.result?.value || [];
      const locked = accounts.some((acc) =>
        SOLANA_LOCK_PROGRAMS.includes(acc.address)
      );
      // Only conclude "locked" when a known program address is confirmed in
      // the top accounts.  We cannot conclude "unlocked" from this check
      // because getTokenLargestAccounts returns SPL token-account addresses,
      // not their owning program IDs — the locker program address will never
      // appear in acc.address.  Return "unknown" when no match is found so
      // the score is not incorrectly penalised.
      result = locked
        ? { status: "locked", label: "🔐 ✅ Locked - Passed" }
        : { status: "unknown", label: "🔐 ❓ Unknown" };
    } else if (isEvmChain(chainId)) {
      // Known EVM LP locker contract addresses (Unicrypt, Team Finance, etc.)
      // All addresses are stored in lowercase so the case-insensitive comparison
      // below (which lowercases the holder address from the API) works correctly.
      const EVM_LOCK_CONTRACTS = [
        "0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214", // Unicrypt v2
        "0xdba68f07d1b7ca219f78ae8582c213d975c25caf", // Team Finance
        "0x71b5759d73262fbb223956913ecf4ecc51057641"  // PinkLock
      ];
      const chainNum = EVM_CHAIN_IDS[chainId];
      if (chainNum && ETHERSCAN_API_KEY) {
        // Check if LP token's top holders include a known locker address
        const url = `${ETHERSCAN_V2_URL}?chainid=${chainNum}&module=token&action=tokenholderlist&contractaddress=${encodeURIComponent(pairAddress)}&page=1&offset=10&apikey=${ETHERSCAN_API_KEY}`;
        const res = await axios.get(url, { timeout: 4000 });
        const holders = res.data?.result || [];
        const locked = Array.isArray(holders) && holders.some((h) =>
          EVM_LOCK_CONTRACTS.includes(String(h.TokenHolderAddress || "").toLowerCase())
        );
        result = locked
          ? { status: "locked", label: "🔐 ✅ Locked - Passed" }
          : { status: "unlocked", label: "🔐 ❌ Unlocked - Failed" };
      }
    }
  } catch (_) {
    // Gracefully fall back to unknown on any error
    result = { status: "unknown", label: "🔐 ❓ Unknown" };
  }

  liquidityLockCache.set(cacheKey, { ts: now, result });
  return result;
}

async function checkDevWalletReputation(walletAddress, chainId) {
  if (!walletAddress) return null;
  try {
    const row = await get(
      `SELECT * FROM flagged_wallets WHERE wallet_address = ? AND (chain_id = ? OR chain_id = 'all') LIMIT 1`,
      [String(walletAddress).toLowerCase(), String(chainId || "").toLowerCase()]
    );
    return row || null;
  } catch (_) {
    return null;
  }
}

function computeRiskRank(score, devReputation, liquidityLockStatus) {
  // Start from the safety score and apply modifiers
  // Critical: score < 25 OR dev is critical
  // High: score < 40 OR dev is high
  // Medium: score < 55 OR dev is medium
  // Low: score < 70
  // None: score >= 70

  const devLevel = String(devReputation?.risk_level || "none").toLowerCase();

  if (score < 25 || devLevel === "critical") return "Critical";
  if (score < 40 || devLevel === "high") return "High";
  if (score < 55 || devLevel === "medium") return "Medium";
  if (score < 70 || devLevel === "low") return "Low";
  return "None";
}

function riskRankEmoji(rank) {
  switch (rank) {
    case "None":     return "🟢 None";
    case "Low":      return "🟡 Low";
    case "Medium":   return "🟠 Medium";
    case "High":     return "🔴 High";
    case "Critical": return "⛔ Critical";
    default:         return "❓ Unknown";
  }
}

async function acquireInstanceLock() {
  const now = nowTs();
  const expiresAt = now + INSTANCE_LOCK_TTL_MINUTES * 60;
  try {
    // Try to insert lock row (id=1). If it already exists, check if it's expired.
    await run(
      `INSERT INTO instance_lock (id, locked_at, expires_at) VALUES (1, ?, ?)`,
      [now, expiresAt]
    );
    return true;
  } catch (_) {
    // Row exists — check if expired
    const existing = await get(`SELECT * FROM instance_lock WHERE id = 1`);
    if (!existing) return true; // shouldn't happen
    if (existing.expires_at < now) {
      // Expired lock — take over
      await run(
        `UPDATE instance_lock SET locked_at = ?, expires_at = ? WHERE id = 1`,
        [now, expiresAt]
      );
      return true;
    }
    return false; // Another instance holds the lock
  }
}

async function releaseInstanceLock() {
  try {
    await run(`DELETE FROM instance_lock WHERE id = 1`);
  } catch (_) {}
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
    alerts_enabled: 0,
    launch_alerts: 0,
    smart_alerts: 0,
    risk_alerts: 0,
    whale_alerts: 0,
    watchlist_alerts: 0,
    movers_alerts: 0,
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
    "watchlist_alerts",
    "movers_alerts",
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
  
  // ✅ DEV MODE: Owner bypasses all checks
  if (DEV_MODE && String(from.id) === OWNER_USER_ID) {
    return true;
  }
  
  // ✅ DEV MODE: Non-owners blocked
  if (DEV_MODE && String(from.id) !== OWNER_USER_ID) {
    return false;
  }
  
  // Normal mode: Check subscription
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
      { text: "💎 Prime Picks", callback_data: "prime_picks" }
    ],
    [
      { text: "👁 Watchlist", callback_data: "watchlist" },
      { text: "🧬 Mode Lab", callback_data: "mode_lab" }
    ],
    [
      { text: "🚨 Alert Center", callback_data: "alert_center" }
    ],
    [
      { text: "🧠 Edge Brain", callback_data: "edge_brain" },
      { text: "🤖 AI Assistant", callback_data: "ai_assistant" }
    ],
    [{ text: "❓ Help", callback_data: "help_menu" }],
    [{ text: "🔄 Refresh", callback_data: "refresh:main" }],
    [{ text: "⭐ Early Access", callback_data: "early_access" }]
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
        [{ text: `${mark(settings.launch_alerts)} 📡 Launch Radar Alerts`, callback_data: "toggle_setting:launch_alerts" }],
        [{ text: `${mark(settings.watchlist_alerts)} 👁 Watchlist Alerts`, callback_data: "toggle_setting:watchlist_alerts" }],
        [{ text: `${mark(settings.risk_alerts)} 🛡 Risk Alerts`, callback_data: "toggle_setting:risk_alerts" }],
        [{ text: `${mark(settings.movers_alerts)} 🚀 Movers Alerts`, callback_data: "toggle_setting:movers_alerts" }],
        [{ text: "🔄 Refresh", callback_data: "refresh:alert_center" }],
        [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };
}

function buildWatchlistItemCallback(chainId, tokenAddress) {
  return makeShortCallback("wopen", { chainId: String(chainId), tokenAddress: String(tokenAddress) });
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
  const rescanCb  = makeShortCallback("wrescan",  { chainId: pair.chainId, tokenAddress: pair.baseAddress });
  const removeCb  = makeShortCallback("wremove",  { chainId: pair.chainId, tokenAddress: pair.baseAddress });
  const feedGoodCb = makeShortCallback("feedbackgood", { chainId: pair.chainId, tokenAddress: pair.baseAddress });
  const feedBadCb  = makeShortCallback("feedbackbad",  { chainId: pair.chainId, tokenAddress: pair.baseAddress });
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔁 Re-Scan", callback_data: rescanCb }],
        [{ text: "❌ Remove", callback_data: removeCb }],
        [
          { text: "👍 Good Call", callback_data: feedGoodCb },
          { text: "👎 Bad Call", callback_data: feedBadCb }
        ],
        [{ text: "🔄 Refresh", callback_data: rescanCb }],
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
    const scanCb = makeShortCallback("sdirect", { chainId: pair.chainId, tokenAddress: pair.baseAddress });

    rows.push([
      { text: `📈 ${clip(pair.baseSymbol || "Token", 18)}`, url: dexUrl },
      { text: "📋 Copy Address", copy_text: { text: pair.baseAddress || "" } }
    ]);

    rows.push([
      { text: "🔎 Full Scan", callback_data: scanCb }
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
   chainId: String(pair.chainId || pair.chain || "solana").toLowerCase(),
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
    priceChangeM5: num(pair.priceChange?.m5 || 0),
    priceChangeH1: num(pair.priceChange?.h1 || 0),
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
  try {
    const data = await safeGet(
      `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`
    );
    
    // Handle both direct array and wrapped structure
    let pairs = [];
    if (Array.isArray(data)) {
      pairs = data;
    } else if (data?.pairs && Array.isArray(data.pairs)) {
      pairs = data.pairs;
    }
    
    if (!pairs.length) return [];
    
    // CRITICAL: Filter out incomplete pairs before normalizing
    return pairs
      .filter(p => p.pairAddress && p.baseToken?.address) // ✅ Verify essential fields
      .map(normalizePair)
      .filter((p) => p && supportsChain(p.chainId) && p.baseAddress && p.pairAddress);
  } catch (err) {
    console.log(`fetchPairsByToken error for ${chainId}:${tokenAddress}`, err.message);
    return [];
  }
}
async function resolveBestPair(query, forceFresh = false) {
  const q = String(query || "").trim();
  if (!q) return null;

  const cacheKey = q.toLowerCase();
  const now = Date.now();
  const cached = pairCache.get(cacheKey);

  // Separate TTL for null (miss) vs successful results to avoid suppressing fresh tokens
  if (!forceFresh && cached) {
    const ttl = cached.data === null ? PAIR_CACHE_MISS_TTL_MS : PAIR_CACHE_HIT_TTL_MS;
    if (now - cached.ts < ttl) return cached.data;
  }

  let result = null;
  let tries = 0;

  while (tries < 3) {
    try {
      // Stage 1: Address input — search token-pairs endpoint across likely chains
      if (isAddressLike(q)) {
        const chainCandidates = q.startsWith("0x")
          ? ["base", "ethereum"]
          : ["solana", "base", "ethereum"];
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
          console.log(`resolveBestPair stage1 hit for ${q}`);
          result = byTokenResults.sort((a, b) => rankPairQuality(b) - rankPairQuality(a))[0];
          break;
        }
        console.log(`resolveBestPair stage1 miss for ${q} — falling through to search`);
      }

      // Stage 2: DexScreener search endpoint
      const pairs = await searchDexPairs(q);
      if (pairs.length) {
        console.log(`resolveBestPair stage2 hit for ${q} (${pairs.length} candidates)`);
        const lowered = q.toLowerCase();
        result = pairs.sort((a, b) => {
          const exactA = String(a.baseSymbol || "").toLowerCase() === lowered;
          const exactB = String(b.baseSymbol || "").toLowerCase() === lowered;
          if (exactA !== exactB) return exactB - exactA;
          return rankPairQuality(b) - rankPairQuality(a);
        })[0];
        break;
      }

      console.log(`resolveBestPair stage2 miss for ${q} — trying normalized variations`);

      // Stage 3: Normalized query variations (strip symbols, try uppercase/lowercase)
      const rawVariations = [
        q.replace(/[$]/g, ""),
        q.replace(/[^a-zA-Z0-9]/g, ""),
        q !== q.toUpperCase() ? q.toUpperCase() : null,
        q !== q.toLowerCase() ? q.toLowerCase() : null
      ];
      const variations = [...new Set(rawVariations.filter(v => v && v !== q))];

      for (const variant of variations) {
        const varPairs = await searchDexPairs(variant).catch(() => []);
        if (varPairs.length) {
          console.log(`resolveBestPair stage3 hit for variant "${variant}" of "${q}"`);
          const lowered = variant.toLowerCase();
          result = varPairs.sort((a, b) => {
            const exactA = String(a.baseSymbol || "").toLowerCase() === lowered;
            const exactB = String(b.baseSymbol || "").toLowerCase() === lowered;
            if (exactA !== exactB) return exactB - exactA;
            return rankPairQuality(b) - rankPairQuality(a);
          })[0];
          break;
        }
      }

      if (result) break;

      // Stage 4: Inspect latest profiles for very new tokens
      console.log(`resolveBestPair stage3 miss for ${q} — checking latest profiles`);
      const profiles = await fetchLatestProfiles().catch(() => []);
      const profileHit = profiles.find(p =>
        String(p?.tokenAddress || "") === q ||
        String(p?.symbol || "").toLowerCase() === q.toLowerCase()
      );
      if (profileHit) {
        const chainId = String(profileHit.chainId || "solana").toLowerCase();
        const tokenAddress = String(profileHit.tokenAddress || "");
        if (tokenAddress) {
          const profilePairs = await fetchPairsByToken(chainId, tokenAddress).catch(() => []);
          if (profilePairs.length) {
            console.log(`resolveBestPair stage4 hit via profiles for ${q}`);
            result = profilePairs.sort((a, b) => rankPairQuality(b) - rankPairQuality(a))[0];
          }
        }
      }

      if (!result) console.log(`resolveBestPair all stages exhausted for ${q}`);
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
  const fetchWithTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
]);

const [honeypotData, topHoldersData, etherscanData] = await Promise.all([
  fetchWithTimeout(fetchEvmHoneypot(pair.baseAddress, chain), 3000),
  fetchWithTimeout(fetchEvmTopHolders(pair.baseAddress, chain), 3000),
  fetchWithTimeout(fetchEtherscanSourceCode(pair.baseAddress, chain), 3000)
]).catch(() => [null, null, null]);
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

  // Liquidity lock status (fetched with timeout to avoid hanging)
  let liquidityLock = { status: "unknown", label: "🔐 ❓ Unknown" };
  try {
    liquidityLock = await Promise.race([
      fetchLiquidityLockStatus(pair),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))
    ]);
  } catch (_) {}

  // Dev wallet reputation check
  const devReputation = await checkDevWalletReputation(pair.baseAddress, chain);

  let score =
    liquidity.score +
    age.score +
    flow.score +
    volume.score +
    transparencyScore +
    honeypotScore +
    holderScore -
    behavior.penalty;

  // Liquidity lock modifier
  if (liquidityLock.status === "locked")   score += 4;
  if (liquidityLock.status === "unlocked") score -= 3;

  // Dev wallet penalty
  if (devReputation) {
    const devLevel = String(devReputation.risk_level || "").toLowerCase();
    if (devLevel === "low")      score -= 3;
    else if (devLevel === "medium")   score -= 6;
    else if (devLevel === "high")     score -= 9;
    else if (devLevel === "critical") score -= 12;
  }

  if (mode === "aggressive") score += 3;
  if (mode === "guardian") score -= 3;

  score = Math.max(1, Math.min(99, Math.round(score)));

  let grade = "Caution";
  if (score >= 75) grade = "Strong";
  else if (score >= 55) grade = "Constructive";
  else if (score < 35) grade = "Danger";

  const riskRank = computeRiskRank(score, devReputation, liquidityLock);

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
    sellTax,
    liquidityLock,
    devReputation,
    riskRank
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
    verdict.confidenceMeta.confidence === "Low" ? `⚠️ <i>Limited data available — token may be too new or partially indexed.</i>` : ``,
    ``,
    `⚠️ <b>Dev Wallet Risk:</b> ${escapeHtml(riskRankEmoji(verdict.riskRank))}`,
    ``,
    `💧 <b>Liquidity:</b> ${shortUsd(pair.liquidityUsd)} • ${escapeHtml(verdict.liquidity.label)}`,
    `${escapeHtml(verdict.liquidityLock.label)}`,
    `📊 <b>24H Volume:</b> ${shortUsd(pair.volumeH24)} • ${escapeHtml(verdict.volume.label)}`,
    `⚡ <b>Flow:</b> ${escapeHtml(verdict.flow.label)} | Buys ${num(pair.buysM5)} / Sells ${num(pair.sellsM5)}`,
    `⏳ <b>Age:</b> ${escapeHtml(ageFromMs(pair.pairCreatedAt))} • ${escapeHtml(verdict.age.label)}`,
    `🏦 <b>Market Cap:</b> ${shortUsd(pair.marketCap || pair.fdv)}`,
    ``,
    `🔍 <b>Transparency:</b> ${escapeHtml(verdict.transparencyLabel)}`,
    `🧪 <b>Trap / Honeypot:</b> ${escapeHtml(verdict.honeypotLabel)}`,
    `👥 <b>Holder Structure:</b> ${escapeHtml(verdict.holderLabel)}`,
    `🧠 <b>Behavior:</b> ${escapeHtml(verdict.behavior.detail)}`,
    verdict.devReputation
      ? `🚩 <b>Dev Wallet:</b> ${escapeHtml((verdict.devReputation.risk_level || "").toUpperCase())} — ${escapeHtml(verdict.devReputation.reason || "Flagged in scam database")}`
      : ``,
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

async function addUserScanHistory(userId, chatId, query, pair) {
  if (!userId || !chatId || !pair) return;
  await run(
    `INSERT INTO user_scan_history
      (user_id, chat_id, query, chain_id, token_address, symbol, name, price_usd, liquidity_usd, market_cap, buys_m5, sells_m5, volume_h24, pair_created_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(userId),
      String(chatId),
      String(query || ""),
      String(pair.chainId || ""),
      String(pair.baseAddress || ""),
      String(pair.baseSymbol || ""),
      String(pair.baseName || ""),
      num(pair.priceUsd),
      num(pair.liquidityUsd),
      num(pair.marketCap),
      num(pair.buysM5),
      num(pair.sellsM5),
      num(pair.volumeH24),
      num(pair.pairCreatedAt),
      nowTs()
    ]
  );
}

async function getRecentUserScans(userId, limit = 3) {
  if (!userId) return [];
  return all(
    `SELECT query, chain_id, token_address, symbol, name, price_usd, liquidity_usd, market_cap, buys_m5, sells_m5, volume_h24, pair_created_at, created_at
     FROM user_scan_history
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [String(userId), Math.max(1, num(limit))]
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

async function logEarlyAccessInterest(userId, username) {
  const now = nowTs();
  await run(
    `INSERT INTO early_access_interest (user_id, username, timestamp, clicked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, clicked_at = excluded.clicked_at`,
    [String(userId), String(username || ""), now, now]
  );
}

async function showEarlyAccessMessage(chatId) {
  const text = [
    `🚀 <b>Gorktimus Early Access</b>`,
    ``,
    `We're preparing to release Deep Analysis Mode — a new intelligence layer designed to:`,
    ``,
    `• Detect hidden risks before entry`,
    `• Filter out rugs and traps automatically`,
    `• Evaluate real trade viability`,
    `• Deliver a clear verdict before you trade`,
    ``,
    `This feature will be released to a limited group first.`,
    ``,
    `<b>How to join:</b>`,
    `Go to the website and submit:`,
    `<i>"I want early access"</i>`,
    `through the Feedback &amp; Support box.`,
    ``,
    `Early access users will:`,
    `• Get first access`,
    `• Help shape the system`,
    `• Receive priority upgrades`,
    ``,
    `Spots may be prioritized based on activity and engagement.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
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
  // Warn about ambiguity but still attempt the lookup — don't hard-stop
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n⚠️ <b>Ticker search — attempting match</b>\n\nMultiple coins can share the same ticker. Running best-match search now...`,
    buildMainMenuOnlyButton("scan_token")
  );
}
  const pair = await resolveBestPair(query, false);

  if (userId) {
    await setUserSetting(userId, "last_scan_query", String(query || ""));
    await trackScan(userId);
  }

  if (!pair) {
    const isTickerInput = inputInfo.type === "ticker";
    const isAddressInput = isAddressLike(query);
    let noMatchMsg;

    if (isTickerInput) {
      noMatchMsg = `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 <b>Token Scan</b>\n\n⚠️ No strong match found for ticker <b>${escapeHtml(query)}</b>.\n\nTicker searches can match multiple coins or return nothing if the token is very new.\n\n📋 For an exact result, send the <b>contract address</b> or a DexScreener link.`;
    } else if (isAddressInput) {
      noMatchMsg = `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 <b>Token Scan</b>\n\n⚠️ No data found for that address.\n\nThis token may be <b>very new</b>, not yet indexed on DexScreener, or on an unsupported chain.\n\n📋 Try again in a few minutes, or send a DexScreener link if you have one.`;
    } else {
      noMatchMsg = `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 <b>Token Scan</b>\n\n⚠️ Could not resolve <b>${escapeHtml(query)}</b> as a token.\n\nTry sending a <b>contract address</b>, ticker symbol, or DexScreener link for best results.`;
    }

    await sendText(chatId, noMatchMsg, buildMainMenuOnlyButton("scan_token"));
    return;
  }

  const snapshotPromise = savePairMemorySnapshot(pair).catch(() => {});
  const cardPromise = buildScanCard(pair, "🔎 <b>Token Scan</b>", userId);

  const card = await cardPromise;
  snapshotPromise.catch(() => {});

  await sendCard(chatId, card, buildScanActionButtons(pair, query), "");
  await addUserScanHistory(userId, chatId, query, pair).catch(() => {});
  const currentMemory = getSessionMemory(chatId);
  const scanSnapshot = {
    query,
    symbol: pair?.baseSymbol || "",
    name: pair?.baseName || "",
    tokenAddress: pair?.baseAddress || "",
    chainId: pair?.chainId || "",
    priceUsd: pair?.priceUsd || "",
    liquidityUsd: pair?.liquidityUsd || "",
    marketCap: pair?.marketCap || "",
    buysM5: pair?.buysM5 || 0,
    sellsM5: pair?.sellsM5 || 0,
    volumeH24: pair?.volumeH24 || 0,
    pairCreatedAt: pair?.pairCreatedAt || 0
  };
  const recentScans = [scanSnapshot, ...(Array.isArray(currentMemory?.recentScans) ? currentMemory.recentScans : [])].slice(0, 3);
  updateSessionMemory(chatId, {
    lastScan: scanSnapshot,
    recentScans
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
    `📈 <b>Trending</b>`,
    ``,
    `Live momentum board filtered through Gorktimus intelligence — not just raw Dex volume. Tokens appear here because they show real on-chain attention backed by sufficient liquidity and structural surface strength. Tokens that are simply loud but structurally weak are ranked lower or excluded entirely.`,
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
  try {
    const profiles = await fetchLatestProfiles().catch(() => []);
    const candidates = [];

    for (const p of profiles.slice(0, 50)) {
      if (!supportsChain(p.chainId)) continue;
      const pair = await resolveTokenToBestPair(p.chainId, p.tokenAddress, true);
      if (!pair) continue;

      const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
      if (
        pair.liquidityUsd >= LAUNCH_MIN_LIQ_USD &&
        pair.volumeH24 >= LAUNCH_MIN_VOL_USD &&
        ageMin <= LAUNCH_MAX_AGE_MINUTES
      ) {
        candidates.push(pair);
      }

      if (candidates.length >= 5) break;
    }

    if (!candidates.length) {
      await sendText(
        chatId,
        `📡 <b>Launch Radar</b>\n\nNo fresh launches passed minimum live filters right now. Radar is still scanning — check back shortly.`,
        buildMainMenuOnlyButton("refresh:launch_radar")
      );
      return;
    }

    const lines = [
      `📡 <b>Launch Radar</b>`,
      ``,
      `Gorktimus scans live launch data in real-time, filtering out the noise and surfacing only the earliest opportunities with verified liquidity, confirmed volume, and structural integrity worth watching.`,
      ``
    ];

    for (const [index, pair] of candidates.entries()) {
      lines.push(buildMiniSignalCard(pair, index + 1, "launch"));
    }

    await sendText(
      chatId,
      lines.join("\n\n"),
      buildSignalListButtons(candidates, "refresh:launch_radar")
    );
  } catch (err) {
    console.error("[launch-radar] showLaunchRadar error:", err.message);
    await sendText(
      chatId,
      `📡 <b>Launch Radar</b>\n\nUnable to load radar data right now. Please try again shortly.`,
      buildMainMenuOnlyButton("refresh:launch_radar")
    );
  }
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
    `🧬 <b>Mode Lab</b>\n\nCurrent mode: <b>${escapeHtml(modeTitle(settings.mode))}</b>\n\nYour active mode shapes how the Safety Score is weighted and which thresholds trigger warnings. Select the mode that matches your risk tolerance.\n\n<b>A — Aggressive</b>\nPermissive scoring bias. Earlier entries, higher tolerance for fresh launches, thinner liquidity, and hotter setups. Best for experienced traders who accept more structural uncertainty in exchange for earlier positioning.\n\n<b>B — Balanced</b>\nThe strongest default for most users. Neutral scoring with no bias in either direction. Catches the broadest range of legitimate setups while still penalizing clear danger signals.\n\n<b>C — Guardian</b>\nStrict defense mode. Applies additional scoring penalties to weak liquidity, elevated concentration risk, unverified contracts, and borderline behavior patterns. Best when capital preservation is the priority over early entry.`,
    buildModeMenu(settings.mode)
  );
}

async function showAlertCenter(chatId, userId) {
  const settings = await getUserSettings(userId);
  await sendText(
    chatId,
    `🚨 <b>Alert Center</b>\n\nAutomatic background monitoring. Gorktimus runs continuous scans in the background and pushes real-time notifications when conditions are met. Toggle each alert layer below.\n\n📡 <b>Launch Radar Alerts</b>\nContinuously scans new token launches against live liquidity, volume, and structural thresholds. Fires an alert when qualifying launches are detected — maximum one alert cycle per minute.\n\n👁 <b>Watchlist Alerts</b>\nActive price surveillance on every token you have saved. Triggers when price moves ±5% or more from the last checkpoint, liquidity is suddenly drained, or early rug pull signals are detected simultaneously.\n\n🛡 <b>Risk Alerts</b>\nFires when a tracked token's structural risk score escalates into elevated territory based on live on-chain data.\n\n🚀 <b>Movers Alerts</b>\nScans for tokens moving at a high rate of speed. Fires when a token gains 30%+ in the last hour or 15%+ in the last 5 minutes with confirmed buy pressure. Each alert shows buy pressure, current market rate, and a quick rug risk read.`,
    buildAlertCenterMenu(settings)
  );
}

async function showEdgeBrain(chatId) {
  await sendText(
    chatId,
    `🧠 <b>Gorktimus Edge Brain</b>\n\nEdge is the core intelligence layer of the terminal — a multi-signal defense engine that translates raw on-chain data into structured risk intelligence before you make a move.\n\n<b>What it does:</b>\n• Scores token safety across liquidity depth, holder concentration, contract transparency, honeypot simulation, and behavioral flow patterns\n• Identifies manipulation signatures — manufactured volume, one-sided buy walls, and spammy transaction patterns designed to trap buyers\n• Tracks launch structure integrity so you can distinguish genuine early momentum from artificial pump setups\n• Cross-references dev wallet reputation against the flagged address database\n• Applies learned memory bias from prior outcomes on the same token to sharpen future reads\n• Adapts scoring dynamically based on your selected mode — Aggressive, Balanced, or Guardian\n\nEdge does not just surface numbers. It synthesizes them into a clear verdict with a recommendation so you know what you are actually looking at.`,
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
  if (key === "wallets") return sendText(chatId, `🧠 <b>Wallet tracker</b> has been retired.`, buildMainMenuOnlyButton("refresh:main"));
  if (key === "ai") return showAIAssistant(chatId);
  if (key === "invite") return showInviteFriends(chatId);
}


// ================= COMMANDS =================
bot.onText(/\/start/, async (msg) => {
  try {
    if (!msg?.from?.id || !msg?.chat?.id) return;
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
async function getTelegramFileUrl(fileId) {
  if (!fileId) return null;
  const file = await bot.getFile(fileId);
  if (!file?.file_path) return null;
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
}

function isImageDocument(doc) {
  const mime = String(doc?.mime_type || "").toLowerCase();
  const name = String(doc?.file_name || "").toLowerCase();
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
}

async function getTelegramMediaContext(msg) {
  if (Array.isArray(msg?.photo) && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    const imageUrl = await getTelegramFileUrl(best?.file_id);
    return {
      imageUrl,
      mediaNote: imageUrl ? "User sent a photo. Analyze visible signal patterns and risk cues from the image." : ""
    };
  }

  if (msg?.document?.file_id) {
    const url = await getTelegramFileUrl(msg.document.file_id);
    if (!url) return { imageUrl: null, mediaNote: "" };
    if (isImageDocument(msg.document)) {
      return {
        imageUrl: url,
        mediaNote: `User sent an image document (${msg.document.file_name || "file"}). Analyze visual details and extract relevant crypto signal context if present.`
      };
    }
    return {
      imageUrl: null,
      mediaNote: `User sent a document file (${msg.document.file_name || "file"}, ${msg.document.mime_type || "unknown mime"}). If the user asks for analysis, reason using the message text and file metadata.`
    };
  }

  if (msg?.video?.file_id) {
    const url = await getTelegramFileUrl(msg.video.file_id);
    return {
      imageUrl: null,
      mediaNote: url
        ? `User sent a video (${msg.video.mime_type || "video"}). Use user text + metadata for guidance and ask for key frame screenshots if deeper visual analysis is needed.`
        : "User sent a video. Use user text for analysis."
    };
  }

  return { imageUrl: null, mediaNote: "" };
}

async function sendWhaleTrackerRetired(chatId) {
  return sendText(
    chatId,
    `🧠 <b>Feature update</b>\n\nWhale Tracker has been retired to keep the terminal focused on signal detection.`,
    buildMainMenuOnlyButton("refresh:main")
  );
}
bot.on("message", async (msg) => {
  try {
    if (!isPrivateChat(msg)) return;
    if (!msg?.from?.id || !msg?.chat?.id) return;
    if (msg.text && msg.text.startsWith("/")) return; // commands handled by their own handlers

    const ok = await ensureSubscribedOrBlock(msg);
    await upsertUserFromMessage(msg, ok ? 1 : 0);
    await ensureUserSettings(msg.from.id);
    await trackUserActivity(msg.from.id);
    if (!ok) return;

    const chatId = msg.chat.id;
    const cleaned = String(msg.text || msg.caption || "").trim();
    const media = await getTelegramMediaContext(msg);
    const imageUrl = media.imageUrl;
    const mediaNote = media.mediaNote;
    if (!cleaned && !mediaNote && !imageUrl) return;
    const pending = pendingAction.get(chatId);
   
    if (pending?.type === "SCAN_TOKEN") {
      pendingAction.delete(chatId);
      await runTokenScan(chatId, cleaned, msg.from.id);
      return;
    }

    if (pending?.type === "ADD_WHALE" || pending?.type === "ADD_WHALE_NAME" || pending?.type === "ADD_DEV" || pending?.type === "ADD_DEV_NAME" || pending?.type === "CHECK_WALLET") {
      pendingAction.delete(chatId);
      return sendWhaleTrackerRetired(chatId);
    }

if (pending?.type === "AI") {
  const reply = await askAI({
    text: cleaned || "Analyze this media input.",
    chatId,
    userId: msg.from.id,
    imageUrl,
    mediaNote
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
  const chainId = parts[1];
  const tokenAddress = parts[2];
  await answerCallbackSafe(query.id);
  return await runTokenScan(chatId, tokenAddress, userId);
}

  if (data.startsWith("wrescan:")) {
    const payload = getShortCallbackPayload(data);
    await answerCallbackSafe(query.id);
    if (!payload) return sendText(chatId, `Callback expired. Please rescan the token.`, buildMainMenuOnlyButton());
    return runTokenScan(chatId, payload.tokenAddress, userId);
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
    if (data === "whale_menu") return sendWhaleTrackerRetired(chatId);
    if (data === "invite_friends") return showInviteFriends(chatId);
    if (data === "check_subscription") return showMainMenu(chatId);
    if (data === "early_access") {
      try {
      await logEarlyAccessInterest(userId, query.from.username ?? query.from.first_name ?? "");
      } catch (_) {
        // fail-safe: logging failure must not block message display
      }
      return showEarlyAccessMessage(chatId);
    }

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
      return sendText(chatId, `🛡 <b>Safety Score + Confidence</b>\n\nThe Safety Score (1–99) is a composite risk rating computed across six weighted signal categories:\n\n• <b>Liquidity Depth</b> — raw liquidity available and whether it is locked\n• <b>Token Age</b> — newer tokens carry higher structural uncertainty\n• <b>Flow Quality</b> — buy/sell ratio and whether transaction patterns look organic or manufactured\n• <b>Volume Health</b> — 24H volume relative to liquidity — inflated ratios signal wash trading\n• <b>Contract Transparency</b> — source code verification and honeypot simulation results\n• <b>Holder Concentration</b> — how much supply is controlled by the top wallets\n\nScores are then shaped by your active Mode (Aggressive, Balanced, or Guardian) and any learned memory bias from prior scans on the same token.\n\n<b>Confidence</b> reflects how many of the expected data sources returned usable results. Low confidence means the token may be too new or not fully indexed.`, buildHelpMenu());
    }

    if (data === "help_transactions") {
      return sendText(chatId, buildAssistantGenericReply("transactions"), buildHelpMenu());
    }

    if (data === "help_sources") {
      return sendText(chatId, `⚙️ <b>Data Sources</b>\n\nGorktimus pulls from multiple live data layers simultaneously:\n\n• <b>DexScreener</b> — primary market data engine for price, liquidity, volume, flow, and pair discovery across Solana, Base, and Ethereum\n• <b>Helius RPC</b> — Solana-native holder account reads and LP structure analysis\n• <b>Honeypot.is</b> — EVM buy/sell simulation and tax detection for Base and Ethereum tokens\n• <b>Etherscan v2 API</b> — EVM contract source verification, top holder lists, and LP locker detection\n• <b>Internal Pair Memory</b> — learned bias system that tracks prior scan outcomes on the same token pair\n• <b>Flagged Wallet Database</b> — cross-referenced dev wallet reputation checks against known bad actors\n\nData freshness varies by source. DexScreener market data updates in near real-time. On-chain reads are fetched on demand with caching applied to reduce API load.`, buildHelpMenu());
    }

    if (data === "help_community") {
      return sendText(chatId, `🧠 <b>Community</b>\n\nX: ${escapeHtml(COMMUNITY_X_URL)}\nTelegram: ${escapeHtml(COMMUNITY_TELEGRAM_URL)}`, buildHelpMenu());
    }

    if (data === "add_whale" || data === "add_dev" || data === "check_wallet" || data === "whale_list" || data === "dev_list" || data === "wallet_alert_settings") {
      return sendWhaleTrackerRetired(chatId);
    }

    if (data.startsWith("wallet_item:")) {
      return sendWhaleTrackerRetired(chatId);
    }

    if (data.startsWith("wallet_toggle:")) {
  return sendWhaleTrackerRetired(chatId);
}

    if (data.startsWith("wallet_remove:")) {
      return sendWhaleTrackerRetired(chatId);
    }

    if (data.startsWith("wallet_check:")) {
      return sendWhaleTrackerRetired(chatId);
    }

    if (data.startsWith("wallet_rename:")) {
      return sendWhaleTrackerRetired(chatId);
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

    if (data.startsWith("sdirect:")) {
      const payload = getShortCallbackPayload(data);
      if (!payload) return sendText(chatId, `Callback expired. Please rescan the token.`, buildMainMenuOnlyButton());
      return runTokenScan(chatId, payload.tokenAddress, userId);
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

  // Resolve the payload to a full pair object
  const pair = await resolveTokenToBestPair(payload.chainId, payload.tokenAddress);
  if (!pair) {
    return sendText(
      chatId,
      `Could not resolve token for watchlist.`,
      buildMainMenuOnlyButton("refresh:watchlist")
    );
  }

  // Call the correct function with the pair object
  await addWatchlistItem(chatId, pair);  // ✅ FIXED
  
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

    if (data.startsWith("wopen:")) {
      const payload = getShortCallbackPayload(data);
      if (!payload) return sendText(chatId, `Callback expired. Please try again.`, buildMainMenuOnlyButton());
      return handleWatchOpen(chatId, userId, payload.chainId, payload.tokenAddress);
    }

  
if (data.startsWith("watch_remove:")) {
  const [, chainId, tokenAddress] = data.split(":");
  if (!chainId || !tokenAddress) {
    return sendText(chatId, `Invalid removal data.`, buildMainMenuOnlyButton("refresh:watchlist"));
  }
  await removeWatchlistItem(chatId, chainId, tokenAddress);
  return showWatchlist(chatId);
}

if (data.startsWith("wremove:")) {
  const payload = getShortCallbackPayload(data);
  if (!payload) return sendText(chatId, `Callback expired. Please try again.`, buildMainMenuOnlyButton("refresh:watchlist"));
  await removeWatchlistItem(chatId, payload.chainId, payload.tokenAddress);
  return showWatchlist(chatId);
}if (data.startsWith("feedback:")) {
  const parts = data.split(":");
  const feedback = parts[1];
  const chainId = parts[2];
  const tokenAddress = parts[3];
  
  if (!feedback || !chainId || !tokenAddress) {
    return sendText(chatId, `Invalid feedback data.`, buildMainMenuOnlyButton());
  }
  
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


});

// ================= BACKGROUND MONITORS =================

/**
 * Scans for new token launches meeting live thresholds and pushes alerts to
 * all users who have launch_alerts enabled.  Called every 60 seconds.
 */
async function runLaunchRadarAlerts() {
  const userRows = await all(
    `SELECT s.launch_alerts, u.chat_id
     FROM user_settings s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.launch_alerts = 1 AND u.chat_id IS NOT NULL AND u.chat_id != ''`
  ).catch(() => []);

  if (!userRows.length) return;

  // In dev mode, restrict alerts to the owner only so test runs don't spam real users
  const alertTargets = DEV_MODE
    ? userRows.filter(row => String(row.chat_id) === OWNER_USER_ID)
    : userRows;

  if (!alertTargets.length) return;

  const profiles = await fetchLatestProfiles().catch(() => []);
  const now = Date.now();
  const newLaunches = [];

  for (const p of profiles.slice(0, 50)) {
    if (!supportsChain(p.chainId)) continue;
    const tokenKey = `${p.chainId}:${p.tokenAddress}`;
    const lastAlertedAt = launchAlertedTokens.get(tokenKey) || 0;
    if (now - lastAlertedAt < LAUNCH_TOKEN_ALERT_COOLDOWN_MS) continue;

    const pair = await resolveTokenToBestPair(p.chainId, p.tokenAddress, true).catch(() => null);
    if (!pair) continue;

    const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
    if (
      pair.liquidityUsd >= LAUNCH_MIN_LIQ_USD &&
      pair.volumeH24 >= LAUNCH_MIN_VOL_USD &&
      ageMin <= LAUNCH_MAX_AGE_MINUTES
    ) {
      newLaunches.push(pair);
      launchAlertedTokens.set(tokenKey, now);
    }

    if (newLaunches.length >= 5) break;
  }

  if (!newLaunches.length) return;

  const lines = [
    `📡 <b>Launch Radar Alert</b>`,
    ``,
    `${newLaunches.length} new launch${newLaunches.length > 1 ? "es" : ""} detected meeting live entry thresholds:`,
    ``
  ];

  // Build per-token scan buttons so the user can scan each token directly
  // without waiting for a fresh radar re-scan.  scan_direct: callbacks are
  // plain strings (no callbackStore dependency) and stay within Telegram's
  // 64-byte callback_data limit for all supported chains.
  const tokenRows = [];
  for (const [i, pair] of newLaunches.entries()) {
    const dexUrl = makeDexUrl(pair.chainId, pair.pairAddress, pair.url || "");
    const flowLabel = pair.buysM5 > pair.sellsM5 ? "🟢" : "🔴";
    lines.push(
      `${i + 1}. <b>${escapeHtml(pair.baseSymbol || shortAddr(pair.baseAddress, 6))}</b> — ${escapeHtml(humanChain(pair.chainId))}` +
      `\n   💰 Mcap: ${shortUsd(pair.marketCap)} | 💧 Liq: ${shortUsd(pair.liquidityUsd)} | 📊 Vol: ${shortUsd(pair.volumeH24)} | ⏳ ${ageFromMs(pair.pairCreatedAt)}` +
      `\n   ${flowLabel} Flow: ${pair.buysM5}B / ${pair.sellsM5}S` +
      (dexUrl ? `\n   🔗 ${dexUrl}` : "")
    );
    // scan_direct:chainId:tokenAddress — handled by the callback router without
    // callbackStore so it never expires.  Strip any colons from the address as a
    // safety measure (Solana base58 and EVM hex addresses never contain colons,
    // but this ensures the split(":") in the callback router always works).
    const safeAddress = String(pair.baseAddress || "").replace(/:/g, "");
    const safeChain = String(pair.chainId || "").replace(/:/g, "");
    const scanCb = `scan_direct:${safeChain}:${safeAddress}`;
    const buttonLabel = pair.baseSymbol ? `🔎 Scan ${pair.baseSymbol}` : `🔎 Scan ${shortAddr(pair.baseAddress, 4)}`;
    tokenRows.push([{ text: buttonLabel, callback_data: scanCb }]);
  }

  lines.push(``, `Tap a Scan button below to run a full analysis on any of these tokens.`);

  const alertText = lines.join("\n");
  const alertKeyboard = {
    reply_markup: {
      inline_keyboard: [
        ...tokenRows,
        [{ text: "📡 Launch Radar", callback_data: "launch_radar" }, { text: "🏠 Main Menu", callback_data: "main_menu" }]
      ]
    }
  };

  for (const row of alertTargets) {
    if (!row.chat_id) continue;
    await sendText(String(row.chat_id), alertText, alertKeyboard).catch(() => {});
    await sleep(ALERT_SEND_DELAY_MS);
  }

  console.log(`[launch-radar-alerts] Alerted ${alertTargets.length} user(s) about ${newLaunches.length} new launch(es)`);
}

/**
 * Monitors every active watchlist item across all users with watchlist_alerts
 * enabled.  Triggers alerts on:
 *   • ±5% price move from last checkpoint
 *   • Liquidity drain ≥ 30% in one cycle
 *   • Simultaneous sell spike + liquidity drain (rug pull signal)
 * Called every 90 seconds.
 */
async function runWatchlistMonitor() {
  const nowSec = nowTs();

  const items = await all(
    `SELECT w.*
     FROM watchlist w
     LEFT JOIN users u ON u.chat_id = w.chat_id
     LEFT JOIN user_settings us ON us.user_id = u.user_id
     WHERE w.active = 1
       AND w.alerts_enabled = 1
       AND (us.watchlist_alerts IS NULL OR us.watchlist_alerts = 1)`
  ).catch(() => []);

  if (!items.length) return;

  // In dev mode, restrict watchlist alerts to the owner only
  const monitorItems = DEV_MODE
    ? items.filter(item => String(item.chat_id) === OWNER_USER_ID)
    : items;

  if (!monitorItems.length) return;

  for (const item of monitorItems) {
    try {
      if (nowSec - num(item.last_alert_ts) < WATCHLIST_ALERT_COOLDOWN_S) {
        // Still in cooldown — refresh price silently
        const pair = await resolveTokenToBestPair(item.chain_id, item.token_address, true).catch(() => null);
        if (pair) {
          await run(
            `UPDATE watchlist SET last_price = ?, last_liquidity = ?, last_volume = ?, updated_at = ? WHERE id = ?`,
            [num(pair.priceUsd), num(pair.liquidityUsd), num(pair.volumeH24), nowSec, item.id]
          ).catch(() => {});
        }
        continue;
      }

      await sleep(WATCHLIST_API_DELAY_MS);

      const pair = await resolveTokenToBestPair(item.chain_id, item.token_address, true).catch(() => null);
      if (!pair) continue;

      const currentPrice = num(pair.priceUsd);
      const currentLiq = num(pair.liquidityUsd);
      const currentVol = num(pair.volumeH24);
      const storedPrice = num(item.last_price);
      const storedLiq = num(item.last_liquidity);
      const recentBuys = num(pair.buysM5);
      const recentSells = num(pair.sellsM5);

      let alertLines = null;
      let alertType = "";

      // Rug pull composite signal: liquidity drain + extreme sell pressure
      const liqDropPct = storedLiq > 0 ? ((storedLiq - currentLiq) / storedLiq) * 100 : 0;
      const isLiqDrain = liqDropPct >= WATCHLIST_LIQ_DRAIN_PCT;
      const isExtremeSellPressure = recentSells >= WATCHLIST_RUG_MIN_SELLS && recentBuys < recentSells * WATCHLIST_RUG_BUY_SELL_RATIO;
      const isRugSignal = isLiqDrain && isExtremeSellPressure;

      if (isRugSignal) {
        alertType = "rug";
        alertLines = [
          `🚨 <b>GORKTIMUS RUG ALERT — HIGH PRIORITY</b>`,
          ``,
          `<b>${escapeHtml(item.symbol || shortAddr(item.token_address, 6))}</b> — ${escapeHtml(humanChain(item.chain_id))}`,
          ``,
          `⚠️ Multiple rug pull signals firing simultaneously:`,
          `• Liquidity drained <b>-${toPct(liqDropPct)}</b> (${shortUsd(storedLiq)} → ${shortUsd(currentLiq)})`,
          `• Extreme sell pressure: <b>${recentSells} sells / ${recentBuys} buys</b> (5-min window)`,
          ``,
          `Consider your position carefully. Conditions are deteriorating fast.`,
          ``,
          `📍 <code>${escapeHtml(item.token_address)}</code>`
        ];
      } else if (isLiqDrain) {
        alertType = "liq_drain";
        alertLines = [
          `⚠️ <b>Watchlist Alert — Liquidity Drain Detected</b>`,
          ``,
          `<b>${escapeHtml(item.symbol || shortAddr(item.token_address, 6))}</b> — ${escapeHtml(humanChain(item.chain_id))}`,
          ``,
          `💧 Liquidity dropped <b>-${toPct(liqDropPct)}</b> since last checkpoint`,
          `Previous: ${shortUsd(storedLiq)} → Current: ${shortUsd(currentLiq)}`,
          ``,
          `Monitor this closely. A continued drain may signal LP removal in progress.`,
          ``,
          `📍 <code>${escapeHtml(item.token_address)}</code>`
        ];
      } else if (storedPrice > 0 && currentPrice > 0) {
        const priceChangePct = ((currentPrice - storedPrice) / storedPrice) * 100;
        if (Math.abs(priceChangePct) >= WATCHLIST_PRICE_ALERT_PCT) {
          alertType = "price";
          const dir = priceChangePct > 0 ? "📈 UP" : "📉 DOWN";
          const sign = priceChangePct > 0 ? "+" : "";
          alertLines = [
            `⚡ <b>Watchlist Alert — Price Move</b>`,
            ``,
            `<b>${escapeHtml(item.symbol || shortAddr(item.token_address, 6))}</b> — ${escapeHtml(humanChain(item.chain_id))}`,
            ``,
            `${dir} <b>${sign}${toPct(Math.abs(priceChangePct))}</b> from last checkpoint`,
            `Previous: ${shortUsd(storedPrice)} → Current: ${shortUsd(currentPrice)}`,
            `💧 Liquidity: ${shortUsd(currentLiq)} | Vol24h: ${shortUsd(currentVol)}`,
            ``,
            `📍 <code>${escapeHtml(item.token_address)}</code>`
          ];
        }
      }

      if (alertLines) {
        const alertText = alertLines.join("\n");
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔎 Scan Now", callback_data: `scan_direct:${item.chain_id}:${item.token_address}` },
                { text: "👁 Watchlist", callback_data: "watchlist" }
              ],
              [{ text: "🏠 Main Menu", callback_data: "main_menu" }]
            ]
          }
        };

        await sendText(String(item.chat_id), alertText, keyboard).catch(() => {});

        // Update last_alert_ts and reset price baseline to current price
        await run(
          `UPDATE watchlist SET last_alert_ts = ?, last_price = ?, last_liquidity = ?, last_volume = ?, updated_at = ? WHERE id = ?`,
          [nowSec, currentPrice, currentLiq, currentVol, nowSec, item.id]
        ).catch(() => {});

        console.log(`[watchlist-monitor] ${alertType} alert sent for ${item.symbol || item.token_address} → chat ${item.chat_id}`);
      } else {
        // No alert — update stored values to track current state
        await run(
          `UPDATE watchlist SET last_price = ?, last_liquidity = ?, last_volume = ?, updated_at = ? WHERE id = ?`,
          [currentPrice, currentLiq, currentVol, nowSec, item.id]
        ).catch(() => {});
      }
    } catch (itemErr) {
      console.log(`[watchlist-monitor] error on item ${item.id}:`, itemErr.message);
    }
  }
}

/**
 * Returns a quick rug-risk label based purely on pair data available from DexScreener.
 * Used in Movers Alert messages to give a fast structural read without running the full
 * on-chain analysis (which would be too slow for a rapid-fire scan).
 */
function quickRugRisk(pair) {
  const liq = num(pair.liquidityUsd);
  const buys = num(pair.buysM5);
  const sells = num(pair.sellsM5);
  if (liq < 5000) return "🔴 HIGH — Thin liquidity";
  if (liq < 15000) return "🟠 MEDIUM — Low liquidity";
  if (sells > buys * 3 && sells >= 5) return "🟠 MEDIUM — Sell pressure detected";
  if (liq >= 50000 && buys >= sells) return "🟢 LOW — Strong structure";
  return "🟡 MODERATE — Monitor closely";
}

/**
 * Scans for tokens that are moving fast (large 1-hour or 5-minute price gain with
 * buy pressure) and alerts all users who have movers_alerts enabled.
 * Called every 2 minutes.
 */
async function runMoversAlert() {
  const userRows = await all(
    `SELECT s.movers_alerts, u.chat_id
     FROM user_settings s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.movers_alerts = 1 AND u.chat_id IS NOT NULL AND u.chat_id != ''`
  ).catch(() => []);

  if (!userRows.length) return;

  const alertTargets = DEV_MODE
    ? userRows.filter(row => String(row.chat_id) === OWNER_USER_ID)
    : userRows;

  if (!alertTargets.length) return;

  // Combine profiles and boosts as candidate token sources
  const [profiles, boosts] = await Promise.all([
    fetchLatestProfiles().catch(() => []),
    fetchLatestBoosts().catch(() => [])
  ]);

  const seen = new Set();
  const candidates = [];

  for (const source of [profiles.slice(0, 50), boosts.slice(0, 30)]) {
    for (const item of source) {
      const chainId = String(item.chainId || "").toLowerCase();
      const tokenAddress = String(item.tokenAddress || "");
      if (!tokenAddress || !supportsChain(chainId)) continue;
      const key = `${chainId}:${tokenAddress}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ chainId, tokenAddress, key });
    }
  }

  const now = Date.now();
  const movers = [];

  for (const c of candidates) {
    if (movers.length >= 5) break;
    const lastAlertedAt = moversAlertedTokens.get(c.key) || 0;
    if (now - lastAlertedAt < MOVERS_TOKEN_ALERT_COOLDOWN_MS) continue;

    const pair = await resolveTokenToBestPair(c.chainId, c.tokenAddress, true).catch(() => null);
    if (!pair) continue;

    const h1 = num(pair.priceChangeH1);
    const m5 = num(pair.priceChangeM5);
    const buys = num(pair.buysM5);
    const sells = num(pair.sellsM5);
    const liq = num(pair.liquidityUsd);

    // Must have meaningful liquidity and be gaining fast with buy pressure
    const isGainingFast = h1 >= MOVERS_PRICE_CHANGE_H1_PCT || m5 >= MOVERS_PRICE_CHANGE_M5_PCT;
    const hasBuyPressure = buys > sells;
    const hasLiquidity = liq >= MOVERS_MIN_LIQ_USD;

    if (isGainingFast && hasBuyPressure && hasLiquidity) {
      movers.push(pair);
      moversAlertedTokens.set(c.key, now);
    }
  }

  if (!movers.length) return;

  for (const pair of movers) {
    const symbol = escapeHtml(pair.baseSymbol || shortAddr(pair.baseAddress, 6));
    const chain = escapeHtml(humanChain(pair.chainId));
    const dexUrl = makeDexUrl(pair.chainId, pair.pairAddress, pair.url || "");
    const h1 = num(pair.priceChangeH1);
    const m5 = num(pair.priceChangeM5);
    const buys = num(pair.buysM5);
    const sells = num(pair.sellsM5);
    const totalTxns = buys + sells;
    const buyPressureLabel = totalTxns > 0
      ? `${Math.round((buys / totalTxns) * 100)}% buy (${buys}B / ${sells}S in 5m)`
      : `${buys}B / ${sells}S`;
    const rugRisk = quickRugRisk(pair);

    const lines = [
      `🚀 <b>MOVERS ALERT</b>`,
      ``,
      `<b>${symbol}</b> is moving — ${chain}`,
      ``,
      `📈 <b>Price Change:</b> ${h1 >= MOVERS_PRICE_CHANGE_H1_PCT ? `+${toPct(h1)} (1h)` : `+${toPct(m5)} (5m)`}`,
      `💵 <b>Current Rate:</b> ${shortUsd(pair.priceUsd)}`,
      `📊 <b>Market Cap:</b> ${shortUsd(pair.marketCap)}`,
      `💧 <b>Liquidity:</b> ${shortUsd(pair.liquidityUsd)}`,
      `⚡ <b>Buy Pressure:</b> ${buyPressureLabel}`,
      `🛡 <b>Rug Risk:</b> ${rugRisk}`,
      ``,
      `📍 <code>${escapeHtml(pair.baseAddress || "")}</code>`,
      dexUrl ? `🔗 ${dexUrl}` : ""
    ].filter(line => line !== "");

    const alertText = lines.join("\n");
    const safeAddress = String(pair.baseAddress || "").replace(/:/g, "");
    const safeChain = String(pair.chainId || "").replace(/:/g, "");
    const scanCb = `scan_direct:${safeChain}:${safeAddress}`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: `🔎 Scan ${pair.baseSymbol || "Token"}`, callback_data: scanCb }],
          [{ text: "🚀 Movers Alert", callback_data: "refresh:alert_center" }, { text: "🏠 Main Menu", callback_data: "main_menu" }]
        ]
      }
    };

    for (const row of alertTargets) {
      if (!row.chat_id) continue;
      await sendText(String(row.chat_id), alertText, keyboard).catch(() => {});
      await sleep(ALERT_SEND_DELAY_MS);
    }

    console.log(`[movers-alert] Alerted ${alertTargets.length} user(s) about mover: ${pair.baseSymbol || pair.baseAddress}`);
  }
}

// ================= BOOT =================
(async () => {
  try {
    await initDb();

    // ── Instance lock check (prevents 409 Conflict from multiple bots) ─────
    if (ENABLE_POLLING) {
      const lockAcquired = await acquireInstanceLock();
      if (!lockAcquired) {
        console.warn(
          `[instance-lock] Another bot instance holds the lock (TTL ${INSTANCE_LOCK_TTL_MINUTES}m). ` +
          `Set ENABLE_POLLING=false to disable polling on this instance, or wait for the lock to expire.`
        );
        // Don't exit — allow the process to continue without polling (e.g. for webhooks).
        // The bot object was already created with polling:true above, so we need to stop it.
        try { bot.stopPolling(); } catch (_) {}
      }

      // Release the lock when the process exits
      process.once("beforeExit", releaseInstanceLock);
    }

    // ── Graceful polling-error handler (409 Conflict) ──────────────────────
    bot.on("polling_error", (err) => {
      const msg = String(err?.message || "");
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.warn(`[polling_error] 409 Conflict detected — another instance may be running. Stopping polling.`);
        try { bot.stopPolling(); } catch (_) {}
      } else {
        console.error(`[polling_error] ${JSON.stringify({ code: err?.code, message: msg })}`);
      }
    });

    const me = await bot.getMe();
    BOT_USERNAME = me?.username || "";
    console.log(`✅ Gorktimus online as @${BOT_USERNAME || "unknown_bot"}`);

    // Start health monitoring after DB is ready
    initHealthMonitor({
      bot,
      run,
      get,
      callbackStore,
      sessionMemory,
      ownerUserId: OWNER_USER_ID,
      devMode: DEV_MODE
    });

    // ── Background alert loops ─────────────────────────────────────────────
    // Launch Radar: fire immediately then every 60 s
    runLaunchRadarAlerts().catch(() => {});
    _launchRadarIntervalId = setInterval(() => {
      runLaunchRadarAlerts().catch((err) => console.log("[launch-radar-alerts] interval error:", err.message));
    }, 60000);

    // Watchlist Monitor: fire after 30 s then every 90 s
    setTimeout(() => {
      runWatchlistMonitor().catch(() => {});
      _watchlistMonitorIntervalId = setInterval(() => {
        runWatchlistMonitor().catch((err) => console.log("[watchlist-monitor] interval error:", err.message));
      }, 90000);
    }, 30000);

    // Movers Alert: fire after 60 s then every 120 s
    setTimeout(() => {
      runMoversAlert().catch(() => {});
      _moversAlertIntervalId = setInterval(() => {
        runMoversAlert().catch((err) => console.log("[movers-alert] interval error:", err.message));
      }, 120000);
    }, 60000);

    console.log("✅ Background alert monitors started");
  } catch (err) {
    console.error("❌ Boot error:", err.message);
    process.exit(1);
  }
})();

process.on("SIGINT", async () => {
  if (_launchRadarIntervalId) clearInterval(_launchRadarIntervalId);
  if (_watchlistMonitorIntervalId) clearInterval(_watchlistMonitorIntervalId);
  if (_moversAlertIntervalId) clearInterval(_moversAlertIntervalId);
  await releaseInstanceLock().catch(() => {});
  try {
    db.close();
  } catch (_) {}
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (_launchRadarIntervalId) clearInterval(_launchRadarIntervalId);
  if (_watchlistMonitorIntervalId) clearInterval(_watchlistMonitorIntervalId);
  if (_moversAlertIntervalId) clearInterval(_moversAlertIntervalId);
  await releaseInstanceLock().catch(() => {});
  try {
    db.close();
  } catch (_) {}
  process.exit(0);
});
