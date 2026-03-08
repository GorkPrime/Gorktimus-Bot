const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// ================= ENV =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// ================= CONFIG =================
const INTRO_IMG = path.join(__dirname, "assets", "gorktimus_intro_1280.png");
const DB_PATH = "./gorktimus.db";

const WATCH_SCAN_INTERVAL_MS = 15000;
const WALLET_SCAN_INTERVAL_MS = 20000;
const LAUNCH_SCAN_INTERVAL_MS = 45000;

const DEFAULT_ALERT_PCT = 1;
const DEFAULT_LIQ_ALERT_PCT = 5;
const DEFAULT_TXN_DELTA = 2;
const DEFAULT_COOLDOWN_SEC = 60;

const LAUNCH_MIN_LIQ = 5000;
const LAUNCH_MIN_VOL = 1000;

// ================= GLOBALS =================
const db = new sqlite3.Database(DB_PATH);
const pendingAction = new Map();

let bot = null;
let watchScanInterval = null;
let walletScanInterval = null;
let launchScanInterval = null;
let watchScanRunning = false;
let walletScanRunning = false;
let launchScanRunning = false;
let shuttingDown = false;

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

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      query TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      pair_address TEXT NOT NULL,
      base_symbol TEXT,
      base_name TEXT,
      base_address TEXT,
      dex_id TEXT,
      pair_url TEXT,
      alert_pct REAL DEFAULT 1,
      liq_alert_pct REAL DEFAULT 5,
      txn_delta INTEGER DEFAULT 2,
      cooldown_sec INTEGER DEFAULT 60,
      active INTEGER DEFAULT 1,
      last_price REAL,
      last_liquidity REAL,
      last_buys_m5 INTEGER,
      last_sells_m5 INTEGER,
      last_alert_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(chat_id, chain_id, pair_address)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      chat_id TEXT PRIMARY KEY,
      global_alerts INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS wallet_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      label_type TEXT NOT NULL, -- whale | dev
      nickname TEXT,
      chain_id TEXT DEFAULT 'solana',
      last_signature TEXT,
      last_seen_at INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(chat_id, wallet, label_type)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS launch_seen (
      key TEXT PRIMARY KEY,
      chain_id TEXT,
      token_address TEXT,
      pair_address TEXT,
      base_symbol TEXT,
      created_at INTEGER NOT NULL
    )
  `);
}

// ================= HELPERS =================
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctChange(oldVal, newVal) {
  if (!oldVal || oldVal <= 0 || !newVal || newVal <= 0) return 0;
  return ((newVal - oldVal) / oldVal) * 100;
}

function shortUsd(n) {
  const x = num(n);
  if (x >= 1_000_000_000) return `$${(x / 1_000_000_000).toFixed(2)}B`;
  if (x >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(8)}`;
}

function shortAddr(s, len = 6) {
  const x = String(s || "");
  if (x.length <= len * 2 + 3) return x;
  return `${x.slice(0, len)}...${x.slice(-len)}`;
}

function clip(text, len = 24) {
  const s = String(text || "");
  return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
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

// ================= MENUS =================
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ Add Watch", callback_data: "add_watch" },
          { text: "📋 Watchlist", callback_data: "watchlist" }
        ],
        [
          { text: "🆕 New Launches", callback_data: "new_launches" },
          { text: "🐋 Whale Track", callback_data: "whale_track" }
        ],
        [
          { text: "👤 Dev Wallets", callback_data: "dev_wallets" },
          { text: "🌍 Global Alerts", callback_data: "global_alerts" }
        ],
        [
          { text: "📡 Status", callback_data: "status" },
          { text: "⚡ Scan Now", callback_data: "scan_now" }
        ],
        [
          { text: "🔄 Refresh", callback_data: "refresh_menu" }
        ]
      ]
    }
  };
}

function watchlistMenu(rows) {
  const buttons = rows.map((row) => ([
    { text: `❌ Remove ${row.base_symbol || row.query}`, callback_data: `remove_watch:${row.id}` }
  ]));

  buttons.push([{ text: "⬅️ Main Menu", callback_data: "main_menu" }]);

  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

function walletMenu(rows, type) {
  const title = type === "whale" ? "🐋" : "👤";
  const buttons = rows.map((row) => ([
    {
      text: `❌ Remove ${title} ${row.nickname || shortAddr(row.wallet)}`,
      callback_data: `remove_wallet:${row.id}`
    }
  ]));

  buttons.push([{ text: "⬅️ Main Menu", callback_data: "main_menu" }]);

  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

// ================= TELEGRAM =================
async function sendTerminal(chatId, caption, keyboard) {
  try {
    if (!fs.existsSync(INTRO_IMG)) {
      await bot.sendMessage(chatId, caption, keyboard);
      return;
    }

    await bot.sendPhoto(
      chatId,
      fs.createReadStream(INTRO_IMG),
      {
        caption,
        ...keyboard
      },
      {
        filename: "gorktimus_intro_1280.png",
        contentType: "image/png"
      }
    );
  } catch (err) {
    console.log("sendTerminal fallback:", err.message);
    await bot.sendMessage(chatId, caption, keyboard);
  }
}

async function ensureUserSettings(chatId) {
  const row = await get(`SELECT * FROM user_settings WHERE chat_id = ?`, [String(chatId)]);
  if (row) return row;

  const ts = nowTs();
  await run(
    `INSERT INTO user_settings (chat_id, global_alerts, created_at, updated_at)
     VALUES (?, 1, ?, ?)`,
    [String(chatId), ts, ts]
  );

  return get(`SELECT * FROM user_settings WHERE chat_id = ?`, [String(chatId)]);
}

// ================= DEX HELPERS =================
async function resolveWatchTarget(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  let pair = null;

  if (isAddressLike(q)) {
    const chainGuess = q.startsWith("0x") ? "base" : "solana";
    try {
      const byToken = await axios.get(
        `https://api.dexscreener.com/token-pairs/v1/${chainGuess}/${encodeURIComponent(q)}`,
        { timeout: 15000 }
      );

      if (Array.isArray(byToken.data) && byToken.data.length) {
        pair = [...byToken.data].sort((a, b) => {
          const scoreA = num(a.liquidity?.usd) + num(a.volume?.h24);
          const scoreB = num(b.liquidity?.usd) + num(b.volume?.h24);
          return scoreB - scoreA;
        })[0];
      }
    } catch (err) {
      console.log("token-pairs lookup fallback:", err.message);
    }
  }

  if (!pair) {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      { timeout: 15000 }
    );

    const pairs = Array.isArray(res.data?.pairs) ? res.data.pairs : [];
    if (!pairs.length) return null;

    pair = [...pairs].sort((a, b) => {
      const exactA = String(a.baseToken?.symbol || "").toLowerCase() === q.toLowerCase();
      const exactB = String(b.baseToken?.symbol || "").toLowerCase() === q.toLowerCase();

      if (exactA !== exactB) return exactB - exactA;

      const scoreA = num(a.liquidity?.usd) * 4 + num(a.volume?.h24) * 2 + num(a.marketCap);
      const scoreB = num(b.liquidity?.usd) * 4 + num(b.volume?.h24) * 2 + num(b.marketCap);
      return scoreB - scoreA;
    })[0];
  }

  if (!pair?.chainId || !pair?.pairAddress) return null;

  return {
    chainId: String(pair.chainId),
    pairAddress: String(pair.pairAddress),
    baseSymbol: String(pair.baseToken?.symbol || q),
    baseName: String(pair.baseToken?.name || q),
    baseAddress: String(pair.baseToken?.address || ""),
    dexId: String(pair.dexId || ""),
    pairUrl: String(pair.url || ""),
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(pair.liquidity?.usd),
    buysM5: num(pair.txns?.m5?.buys),
    sellsM5: num(pair.txns?.m5?.sells)
  };
}

async function fetchPair(chainId, pairAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`,
      { timeout: 15000 }
    );

    const pair = Array.isArray(res.data?.pairs) ? res.data.pairs[0] : null;
    if (!pair) return null;

    return {
      chainId: String(pair.chainId || chainId),
      pairAddress: String(pair.pairAddress || pairAddress),
      baseSymbol: String(pair.baseToken?.symbol || ""),
      baseName: String(pair.baseToken?.name || ""),
      baseAddress: String(pair.baseToken?.address || ""),
      priceUsd: num(pair.priceUsd),
      liquidityUsd: num(pair.liquidity?.usd),
      volumeH24: num(pair.volume?.h24),
      buysM5: num(pair.txns?.m5?.buys),
      sellsM5: num(pair.txns?.m5?.sells),
      fdv: num(pair.fdv),
      marketCap: num(pair.marketCap),
      url: String(pair.url || "")
    };
  } catch (err) {
    console.log("fetchPair error:", err.message);
    return null;
  }
}

async function fetchLatestProfiles() {
  try {
    const res = await axios.get("https://api.dexscreener.com/token-profiles/latest/v1", {
      timeout: 15000
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.log("fetchLatestProfiles error:", err.message);
    return [];
  }
}

async function fetchLatestBoosts() {
  try {
    const res = await axios.get("https://api.dexscreener.com/token-boosts/latest/v1", {
      timeout: 15000
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.log("fetchLatestBoosts error:", err.message);
    return [];
  }
}

async function fetchTokenOrders(chainId, tokenAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/orders/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      { timeout: 15000 }
    );
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    return [];
  }
}

async function resolveTokenToBestPair(chainId, tokenAddress) {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      { timeout: 15000 }
    );

    const pairs = Array.isArray(res.data) ? res.data : [];
    if (!pairs.length) return null;

    const pair = [...pairs].sort((a, b) => {
      const scoreA = num(a.liquidity?.usd) * 4 + num(a.volume?.h24) * 2 + num(a.marketCap);
      const scoreB = num(b.liquidity?.usd) * 4 + num(b.volume?.h24) * 2 + num(b.marketCap);
      return scoreB - scoreA;
    })[0];

    return {
      chainId: String(pair.chainId),
      pairAddress: String(pair.pairAddress),
      baseSymbol: String(pair.baseToken?.symbol || ""),
      baseName: String(pair.baseToken?.name || ""),
      baseAddress: String(pair.baseToken?.address || tokenAddress),
      priceUsd: num(pair.priceUsd),
      liquidityUsd: num(pair.liquidity?.usd),
      volumeH24: num(pair.volume?.h24),
      buysM5: num(pair.txns?.m5?.buys),
      sellsM5: num(pair.txns?.m5?.sells),
      url: String(pair.url || ""),
      marketCap: num(pair.marketCap),
      fdv: num(pair.fdv)
    };
  } catch (err) {
    console.log("resolveTokenToBestPair error:", err.message);
    return null;
  }
}

// ================= WATCHLIST =================
async function addWatch(chatId, query) {
  const resolved = await resolveWatchTarget(query);

  if (!resolved) {
    await bot.sendMessage(chatId, `❌ Could not find a solid pair for: ${query}`);
    return;
  }

  const ts = nowTs();

  try {
    await run(
      `INSERT INTO watches (
        chat_id, query, chain_id, pair_address, base_symbol, base_name, base_address, dex_id, pair_url,
        alert_pct, liq_alert_pct, txn_delta, cooldown_sec, active,
        last_price, last_liquidity, last_buys_m5, last_sells_m5, last_alert_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?)`,
      [
        String(chatId),
        String(query).trim(),
        resolved.chainId,
        resolved.pairAddress,
        resolved.baseSymbol,
        resolved.baseName,
        resolved.baseAddress,
        resolved.dexId,
        resolved.pairUrl,
        DEFAULT_ALERT_PCT,
        DEFAULT_LIQ_ALERT_PCT,
        DEFAULT_TXN_DELTA,
        DEFAULT_COOLDOWN_SEC,
        resolved.priceUsd,
        resolved.liquidityUsd,
        resolved.buysM5,
        resolved.sellsM5,
        ts
      ]
    );

    await sendTerminal(
      chatId,
      `✅ Watch added

${resolved.baseSymbol} (${resolved.baseName})
Chain: ${resolved.chainId}
Price: ${shortUsd(resolved.priceUsd)}
Liquidity: ${shortUsd(resolved.liquidityUsd)}
Buys m5: ${resolved.buysM5}
Sells m5: ${resolved.sellsM5}`,
      mainMenu()
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      await bot.sendMessage(chatId, "⚠️ That pair is already in your watchlist.");
      return;
    }
    throw err;
  }
}

async function showWatchlist(chatId) {
  const rows = await all(
    `SELECT id, query, base_symbol, chain_id, alert_pct, cooldown_sec
     FROM watches
     WHERE chat_id = ? AND active = 1
     ORDER BY created_at DESC`,
    [String(chatId)]
  );

  if (!rows.length) {
    await sendTerminal(chatId, "📭 Watchlist empty.", mainMenu());
    return;
  }

  const lines = rows.map((r, i) =>
    `${i + 1}. ${r.base_symbol || r.query} | ${r.chain_id} | ${r.alert_pct}% | ${r.cooldown_sec}s`
  );

  await sendTerminal(
    chatId,
    `📋 Your Watchlist

${lines.join("\n")}`,
    watchlistMenu(rows)
  );
}

async function removeWatch(chatId, id) {
  await run(`UPDATE watches SET active = 0 WHERE id = ? AND chat_id = ?`, [id, String(chatId)]);
  await showWatchlist(chatId);
}

// ================= WALLET TRACKING =================
async function addWalletTrack(chatId, wallet, labelType) {
  if (!hasHelius()) {
    await bot.sendMessage(
      chatId,
      "⚠️ HELIUS_API_KEY is missing in Railway variables. Add it first to enable wallet tracking."
    );
    return;
  }

  if (!isLikelySolanaWallet(wallet)) {
    await bot.sendMessage(chatId, "❌ That does not look like a valid Solana wallet address.");
    return;
  }

  const ts = nowTs();

  try {
    await run(
      `INSERT INTO wallet_tracks (chat_id, wallet, label_type, chain_id, created_at, active)
       VALUES (?, ?, ?, 'solana', ?, 1)`,
      [String(chatId), wallet.trim(), labelType, ts]
    );

    await sendTerminal(
      chatId,
      `${labelType === "whale" ? "🐋" : "👤"} Tracking added

${wallet}`,
      mainMenu()
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      await bot.sendMessage(chatId, "⚠️ That wallet is already being tracked in that category.");
      return;
    }
    throw err;
  }
}

async function showWalletTracks(chatId, labelType) {
  const rows = await all(
    `SELECT id, wallet, nickname, label_type
     FROM wallet_tracks
     WHERE chat_id = ? AND label_type = ? AND active = 1
     ORDER BY created_at DESC`,
    [String(chatId), labelType]
  );

  if (!rows.length) {
    await sendTerminal(
      chatId,
      `${labelType === "whale" ? "🐋" : "👤"} No ${labelType} wallets tracked yet.`,
      mainMenu()
    );
    return;
  }

  const lines = rows.map((r, i) =>
    `${i + 1}. ${r.nickname || shortAddr(r.wallet)}`
  );

  await sendTerminal(
    chatId,
    `${labelType === "whale" ? "🐋" : "👤"} ${labelType === "whale" ? "Whale" : "Dev"} Wallets

${lines.join("\n")}`,
    walletMenu(rows, labelType)
  );
}

async function removeWalletTrack(chatId, id) {
  await run(
    `UPDATE wallet_tracks SET active = 0 WHERE id = ? AND chat_id = ?`,
    [id, String(chatId)]
  );

  await sendTerminal(chatId, "✅ Wallet tracking removed.", mainMenu());
}

async function fetchHeliusLatestTx(address) {
  if (!HELIUS_API_KEY) return null;

  try {
    const res = await axios.get(
      `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(HELIUS_API_KEY)}`,
      { timeout: 20000 }
    );

    const rows = Array.isArray(res.data) ? res.data : [];
    if (!rows.length) return null;
    return rows[0];
  } catch (err) {
    console.log("fetchHeliusLatestTx error:", err.message);
    return null;
  }
}

function summarizeHeliusTx(tx) {
  if (!tx) return "No transaction data.";

  const parts = [];
  const sig = tx.signature || "";
  const type = tx.type || "UNKNOWN";
  const source = tx.source || "UNKNOWN";
  const desc = tx.description || "No description";

  parts.push(`Type: ${type}`);
  parts.push(`Source: ${source}`);
  parts.push(`Desc: ${desc}`);

  if (tx.events?.swap) {
    const swap = tx.events.swap;
    const inMint = swap.tokenInputs?.[0]?.mint || "";
    const outMint = swap.tokenOutputs?.[0]?.mint || "";
    parts.push(`Swap: ${shortAddr(inMint, 4)} → ${shortAddr(outMint, 4)}`);
  }

  if (Array.isArray(tx.tokenTransfers) && tx.tokenTransfers.length) {
    const first = tx.tokenTransfers[0];
    parts.push(`Token: ${shortAddr(first.mint, 4)} amt ${num(first.tokenAmount)}`);
  }

  parts.push(`Sig: ${shortAddr(sig, 8)}`);

  return parts.join("\n");
}

async function scanWalletTracks(manualChatId = null) {
  if (walletScanRunning && !manualChatId) return;
  if (!hasHelius()) return;

  walletScanRunning = true;

  try {
    const rows = await all(
      `SELECT * FROM wallet_tracks
       WHERE active = 1 ${manualChatId ? "AND chat_id = ?" : ""}
       ORDER BY created_at ASC`,
      manualChatId ? [String(manualChatId)] : []
    );

    for (const row of rows) {
      const tx = await fetchHeliusLatestTx(row.wallet);
      if (!tx || !tx.signature) continue;

      if (!row.last_signature) {
        await run(
          `UPDATE wallet_tracks SET last_signature = ?, last_seen_at = ? WHERE id = ?`,
          [tx.signature, nowTs(), row.id]
        );
        continue;
      }

      if (tx.signature !== row.last_signature) {
        const emoji = row.label_type === "whale" ? "🐋" : "👤";
        await bot.sendMessage(
          row.chat_id,
          `${emoji} ${row.label_type === "whale" ? "Whale" : "Dev"} wallet moved

Wallet: ${shortAddr(row.wallet, 8)}
${summarizeHeliusTx(tx)}`
        );

        await run(
          `UPDATE wallet_tracks SET last_signature = ?, last_seen_at = ? WHERE id = ?`,
          [tx.signature, nowTs(), row.id]
        );
      }
    }
  } catch (err) {
    console.log("scanWalletTracks error:", err.message);
  } finally {
    walletScanRunning = false;
  }
}

// ================= NEW LAUNCHES =================
async function buildNewLaunchSnapshot(limit = 8) {
  const profiles = await fetchLatestProfiles();
  const boosts = await fetchLatestBoosts();

  const mergedMap = new Map();

  for (const item of profiles) {
    if (!item.chainId || !item.tokenAddress) continue;
    const key = `${item.chainId}:${item.tokenAddress}`;
    mergedMap.set(key, {
      chainId: String(item.chainId),
      tokenAddress: String(item.tokenAddress),
      source: "profile"
    });
  }

  for (const item of boosts) {
    if (!item.chainId || !item.tokenAddress) continue;
    const key = `${item.chainId}:${item.tokenAddress}`;
    mergedMap.set(key, {
      chainId: String(item.chainId),
      tokenAddress: String(item.tokenAddress),
      source: "boost"
    });
  }

  const candidates = [...mergedMap.values()].slice(0, 20);
  const out = [];

  for (const c of candidates) {
    const pair = await resolveTokenToBestPair(c.chainId, c.tokenAddress);
    if (!pair) continue;
    if (pair.liquidityUsd < LAUNCH_MIN_LIQ) continue;
    if (pair.volumeH24 < LAUNCH_MIN_VOL) continue;

    const orders = await fetchTokenOrders(c.chainId, c.tokenAddress);
    const hasApprovedOrder = orders.some((x) => x.status === "approved");

    out.push({
      chainId: c.chainId,
      tokenAddress: c.tokenAddress,
      pairAddress: pair.pairAddress,
      symbol: pair.baseSymbol || "UNKNOWN",
      name: pair.baseName || "",
      priceUsd: pair.priceUsd,
      liquidityUsd: pair.liquidityUsd,
      volumeH24: pair.volumeH24,
      buysM5: pair.buysM5,
      sellsM5: pair.sellsM5,
      fdv: pair.fdv,
      marketCap: pair.marketCap,
      url: pair.url,
      signal: c.source,
      paid: hasApprovedOrder
    });
  }

  return out
    .sort((a, b) => {
      const scoreA =
        a.liquidityUsd * 2 +
        a.volumeH24 +
        (a.paid ? 15000 : 0) +
        (a.signal === "boost" ? 5000 : 0) +
        a.buysM5 * 200;
      const scoreB =
        b.liquidityUsd * 2 +
        b.volumeH24 +
        (b.paid ? 15000 : 0) +
        (b.signal === "boost" ? 5000 : 0) +
        b.buysM5 * 200;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}

async function showNewLaunches(chatId) {
  const launches = await buildNewLaunchSnapshot(8);

  if (!launches.length) {
    await sendTerminal(chatId, "🆕 No strong new-launch candidates found right now.", mainMenu());
    return;
  }

  const lines = launches.map((x, i) => {
    const tag = `${x.signal}${x.paid ? "+paid" : ""}`;
    return `${i + 1}. ${x.symbol} | ${x.chainId}
price ${shortUsd(x.priceUsd)} | liq ${shortUsd(x.liquidityUsd)}
vol ${shortUsd(x.volumeH24)} | m5 B${x.buysM5}/S${x.sellsM5}
signal: ${tag}`;
  });

  await sendTerminal(
    chatId,
    `🆕 New Launches Snapshot

${lines.join("\n\n")}`,
    mainMenu()
  );
}

async function scanLaunchAlerts() {
  if (launchScanRunning) return;
  launchScanRunning = true;

  try {
    const settingsRows = await all(
      `SELECT chat_id FROM user_settings WHERE global_alerts = 1`
    );
    if (!settingsRows.length) return;

    const launches = await buildNewLaunchSnapshot(5);
    if (!launches.length) return;

    for (const x of launches) {
      const key = `${x.chainId}:${x.tokenAddress}`;
      const seen = await get(`SELECT key FROM launch_seen WHERE key = ?`, [key]);
      if (seen) continue;

      await run(
        `INSERT INTO launch_seen (key, chain_id, token_address, pair_address, base_symbol, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [key, x.chainId, x.tokenAddress, x.pairAddress, x.symbol, nowTs()]
      );

      const msg =
        `🆕 New Launch Signal

${x.symbol} (${x.name || "unknown"})
Chain: ${x.chainId}
Price: ${shortUsd(x.priceUsd)}
Liquidity: ${shortUsd(x.liquidityUsd)}
24h Volume: ${shortUsd(x.volumeH24)}
M5: B ${x.buysM5} | S ${x.sellsM5}
Signal: ${x.signal}${x.paid ? " + paid" : ""}`;

      for (const row of settingsRows) {
        await bot.sendMessage(row.chat_id, msg);
      }
    }
  } catch (err) {
    console.log("scanLaunchAlerts error:", err.message);
  } finally {
    launchScanRunning = false;
  }
}

// ================= STATUS / SETTINGS =================
async function showStatus(chatId) {
  const total = await get(`SELECT COUNT(*) AS c FROM watches WHERE active = 1`);
  const mine = await get(`SELECT COUNT(*) AS c FROM watches WHERE chat_id = ? AND active = 1`, [String(chatId)]);
  const whales = await get(`SELECT COUNT(*) AS c FROM wallet_tracks WHERE chat_id = ? AND label_type = 'whale' AND active = 1`, [String(chatId)]);
  const devs = await get(`SELECT COUNT(*) AS c FROM wallet_tracks WHERE chat_id = ? AND label_type = 'dev' AND active = 1`, [String(chatId)]);
  const settings = await ensureUserSettings(chatId);

  await sendTerminal(
    chatId,
    `📡 STATUS

Your watches: ${mine?.c || 0}
Whales tracked: ${whales?.c || 0}
Dev wallets tracked: ${devs?.c || 0}
Total watches: ${total?.c || 0}
Watch scan: ${WATCH_SCAN_INTERVAL_MS / 1000}s
Wallet scan: ${WALLET_SCAN_INTERVAL_MS / 1000}s
Launch scan: ${LAUNCH_SCAN_INTERVAL_MS / 1000}s
Global alerts: ${settings.global_alerts ? "ON" : "OFF"}
Helius: ${hasHelius() ? "ON" : "MISSING"}
Image: ${fs.existsSync(INTRO_IMG) ? "OK" : "MISSING"}`,
    mainMenu()
  );
}

async function toggleGlobalAlerts(chatId) {
  const settings = await ensureUserSettings(chatId);
  const next = settings.global_alerts ? 0 : 1;

  await run(
    `UPDATE user_settings SET global_alerts = ?, updated_at = ? WHERE chat_id = ?`,
    [next, nowTs(), String(chatId)]
  );

  await sendTerminal(
    chatId,
    `🌍 Global Alerts: ${next ? "ON" : "OFF"}`,
    mainMenu()
  );
}

// ================= WATCH SCANNER =================
async function maybeAlert(row, fresh, manualMode = false) {
  const pMove = pctChange(row.last_price, fresh.priceUsd);
  const lMove = pctChange(row.last_liquidity, fresh.liquidityUsd);
  const buyDelta = num(fresh.buysM5) - num(row.last_buys_m5);
  const sellDelta = num(fresh.sellsM5) - num(row.last_sells_m5);

  const reasons = [];

  if (Math.abs(pMove) >= num(row.alert_pct, DEFAULT_ALERT_PCT)) {
    reasons.push(`💰 Price ${pMove >= 0 ? "up" : "down"} ${Math.abs(pMove).toFixed(2)}%`);
  }

  if (Math.abs(lMove) >= num(row.liq_alert_pct, DEFAULT_LIQ_ALERT_PCT)) {
    reasons.push(`🏦 Liquidity ${lMove >= 0 ? "up" : "down"} ${Math.abs(lMove).toFixed(2)}%`);
  }

  if (Math.abs(buyDelta) >= num(row.txn_delta, DEFAULT_TXN_DELTA)) {
    reasons.push(`🟢 Buys m5 ${buyDelta >= 0 ? "+" : ""}${buyDelta}`);
  }

  if (Math.abs(sellDelta) >= num(row.txn_delta, DEFAULT_TXN_DELTA)) {
    reasons.push(`🔴 Sells m5 ${sellDelta >= 0 ? "+" : ""}${sellDelta}`);
  }

  const currentTs = nowTs();
  const cooldownSec = num(row.cooldown_sec, DEFAULT_COOLDOWN_SEC);
  const cooldownOk = currentTs - num(row.last_alert_at, 0) >= cooldownSec;

  if (reasons.length && cooldownOk && !manualMode) {
    await bot.sendMessage(
      row.chat_id,
      `🚨 ${fresh.baseSymbol || row.base_symbol || row.query}
${reasons.join("\n")}

Price: ${shortUsd(fresh.priceUsd)}
Liquidity: ${shortUsd(fresh.liquidityUsd)}
24h Volume: ${shortUsd(fresh.volumeH24)}
M5: B ${fresh.buysM5} | S ${fresh.sellsM5}`
    );

    await run(`UPDATE watches SET last_alert_at = ? WHERE id = ?`, [currentTs, row.id]);
  }

  await run(
    `UPDATE watches
     SET last_price = ?, last_liquidity = ?, last_buys_m5 = ?, last_sells_m5 = ?, pair_url = ?
     WHERE id = ?`,
    [
      fresh.priceUsd,
      fresh.liquidityUsd,
      fresh.buysM5,
      fresh.sellsM5,
      fresh.url || row.pair_url,
      row.id
    ]
  );

  return {
    symbol: fresh.baseSymbol || row.base_symbol || row.query,
    price: fresh.priceUsd,
    liquidity: fresh.liquidityUsd,
    buysM5: fresh.buysM5,
    sellsM5: fresh.sellsM5,
    triggered: reasons
  };
}

async function scanWatches(manualMode = false, targetChatId = null) {
  if (watchScanRunning && !manualMode) return { scanned: 0, results: [] };
  watchScanRunning = true;

  try {
    const rows = await all(
      `SELECT * FROM watches WHERE active = 1 ${targetChatId ? "AND chat_id = ?" : ""} ORDER BY created_at ASC`,
      targetChatId ? [String(targetChatId)] : []
    );

    const results = [];

    for (const row of rows) {
      const fresh = await fetchPair(row.chain_id, row.pair_address);
      if (!fresh) continue;
      if (!fresh.priceUsd || fresh.priceUsd <= 0) continue;

      const result = await maybeAlert(row, fresh, manualMode);
      results.push(result);
    }

    return { scanned: rows.length, results };
  } catch (err) {
    console.log("scanWatches error:", err.message);
    return { scanned: 0, results: [] };
  } finally {
    watchScanRunning = false;
  }
}

async function forceScan(chatId) {
  await bot.sendMessage(chatId, "⚡ Running scan now...");

  const out = await scanWatches(true, chatId);

  if (!out.results.length) {
    await bot.sendMessage(chatId, "✅ Scan complete.\nNo active watch data found yet.");
    return;
  }

  const lines = out.results.slice(0, 10).map((r) => {
    const parts = [
      `${r.symbol} | ${shortUsd(r.price)}`,
      `liq ${shortUsd(r.liquidity)}`,
      `m5 B ${r.buysM5} / S ${r.sellsM5}`
    ];

    if (r.triggered.length) {
      parts.push(`alerts: ${r.triggered.join(" | ")}`);
    } else {
      parts.push("alerts: none");
    }

    return parts.join("\n");
  });

  await bot.sendMessage(
    chatId,
    `✅ Scan complete.

Watches scanned: ${out.scanned}

${lines.join("\n\n")}`
  );
}

// ================= BOT HANDLERS =================
async function registerHandlers() {
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await ensureUserSettings(chatId);
    await sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.", mainMenu());
  });

  bot.onText(/\/scan/, async (msg) => {
    await forceScan(msg.chat.id);
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data || "";

    try {
      if (data === "add_watch") {
        pendingAction.set(chatId, { type: "ADD_WATCH" });
        await bot.sendMessage(chatId, "Send ticker, token address, or pair search. Example: SOL");
      } else if (data === "watchlist") {
        await showWatchlist(chatId);
      } else if (data === "new_launches") {
        await showNewLaunches(chatId);
      } else if (data === "whale_track") {
        pendingAction.set(chatId, { type: "ADD_WHALE" });
        await bot.sendMessage(chatId, "Send a Solana whale wallet address to track.");
      } else if (data === "dev_wallets") {
        pendingAction.set(chatId, { type: "ADD_DEV" });
        await bot.sendMessage(chatId, "Send a Solana dev wallet address to track.");
      } else if (data === "global_alerts") {
        await toggleGlobalAlerts(chatId);
      } else if (data === "status") {
        await showStatus(chatId);
      } else if (data === "scan_now") {
        await forceScan(chatId);
      } else if (data === "refresh_menu") {
        await sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nRefreshed.", mainMenu());
      } else if (data === "main_menu") {
        await sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.", mainMenu());
      } else if (data.startsWith("remove_watch:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) {
          await removeWatch(chatId, id);
        }
      } else if (data.startsWith("remove_wallet:")) {
        const id = Number(data.split(":")[1]);
        if (Number.isFinite(id)) {
          await removeWalletTrack(chatId, id);
        }
      }

      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.log("callback error:", err.message);
      try {
        await bot.answerCallbackQuery(query.id, { text: "Something glitched." });
      } catch (_) {}
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;
    if (text.startsWith("/start") || text.startsWith("/scan")) return;

    const pending = pendingAction.get(chatId);
    if (!pending) return;

    try {
      if (pending.type === "ADD_WATCH") {
        pendingAction.delete(chatId);
        await addWatch(chatId, text.trim());
      } else if (pending.type === "ADD_WHALE") {
        pendingAction.delete(chatId);
        await addWalletTrack(chatId, text.trim(), "whale");
      } else if (pending.type === "ADD_DEV") {
        pendingAction.delete(chatId);
        await addWalletTrack(chatId, text.trim(), "dev");
      }
    } catch (err) {
      pendingAction.delete(chatId);
      console.log("message handler error:", err.message);
      await bot.sendMessage(chatId, "❌ Could not process that request.");
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
    if (watchScanInterval) clearInterval(watchScanInterval);
    if (walletScanInterval) clearInterval(walletScanInterval);
    if (launchScanInterval) clearInterval(launchScanInterval);

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

  await registerHandlers();
  await bot.startPolling();

  console.log("🧠 Gorktimus Prime Bot Running...");
  console.log("📁 Image exists on boot:", fs.existsSync(INTRO_IMG));
  console.log("🔑 Helius enabled:", hasHelius());

  watchScanInterval = setInterval(() => {
    scanWatches(false, null);
  }, WATCH_SCAN_INTERVAL_MS);

  walletScanInterval = setInterval(() => {
    scanWalletTracks(null);
  }, WALLET_SCAN_INTERVAL_MS);

  launchScanInterval = setInterval(() => {
    scanLaunchAlerts();
  }, LAUNCH_SCAN_INTERVAL_MS);
})();
