"use strict";

const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const path = require("path");

// ===================== ENV =====================
const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN (or BOT_TOKEN/TOKEN)");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database("./gorktimus.db");

// ===================== ASSETS =====================
const INTRO_IMG = path.join(__dirname, "assets", "gorktimus_intro_1280.png");

// ===================== STATE =====================
const pendingAdd = new Map(); // chatId -> true | "SET_USER_THRESHOLD" | "SET_USER_COOLDOWN" | "TOKEN_SET_THRESHOLD:<id>" | "TOKEN_SET_COOLDOWN:<id>"
const pendingCandidate = new Map(); // chatId -> { chainId, pairAddress, symbol, url, priceUsd, liqUsd, vol24h }

// ===================== DB =====================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      alerts_on INTEGER DEFAULT 1,
      alert_threshold REAL DEFAULT 3.0,
      alert_cooldown_sec INTEGER DEFAULT 120
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      chain_id TEXT NOT NULL,
      pair_address TEXT NOT NULL,
      symbol TEXT,
      url TEXT,

      last_price REAL,
      last_buys INTEGER,
      last_sells INTEGER,
      last_alert_ts INTEGER DEFAULT 0,

      token_alerts_on INTEGER DEFAULT 1,
      token_threshold REAL,
      token_cooldown_sec INTEGER,

      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(chat_id, chain_id, pair_address)
    )
  `);

  // safe migrations (no-op if already exists)
  db.run(`ALTER TABLE users ADD COLUMN alerts_on INTEGER DEFAULT 1`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN alert_threshold REAL DEFAULT 3.0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN alert_cooldown_sec INTEGER DEFAULT 120`, () => {});

  db.run(`ALTER TABLE watchlist ADD COLUMN token_alerts_on INTEGER DEFAULT 1`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN token_threshold REAL`, () => {});
  db.run(`ALTER TABLE watchlist ADD COLUMN token_cooldown_sec INTEGER`, () => {});
});

// ===================== UI HELPERS =====================
function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "👁 Add Watch", callback_data: "WATCH" }],
      [{ text: "📋 Watchlist", callback_data: "WATCHLIST" }],
      [{ text: "🚨 Global Alerts", callback_data: "ALERTS_MENU" }],
      [{ text: "ℹ️ Status", callback_data: "STATUS" }],
    ],
  };
}

function confirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Add Watch", callback_data: "CONFIRM_ADD" }],
      [{ text: "❌ Cancel", callback_data: "CANCEL_ADD" }],
      [{ text: "🏠 Home", callback_data: "HOME" }],
    ],
  };
}

function watchlistKeyboard(rows) {
  const buttons = rows.slice(0, 10).map((r) => [
    { text: `${r.symbol || "???"}`, callback_data: `TOKEN:${r.id}` },
  ]);
  buttons.push([{ text: "🏠 Home", callback_data: "HOME" }]);
  return { inline_keyboard: buttons };
}

function tokenKeyboard(id, tokenOn, th, cd) {
  return {
    inline_keyboard: [
      [{ text: tokenOn ? "🔔 Token Alerts: ON" : "🔕 Token Alerts: OFF", callback_data: `TOKEN_TOGGLE:${id}` }],
      [
        { text: `🎯 Token Threshold: ${th ?? "GLOBAL"}%`, callback_data: `TOKEN_SET_TH:${id}` },
        { text: `⏱ Token Cooldown: ${cd ?? "GLOBAL"}s`, callback_data: `TOKEN_SET_CD:${id}` },
      ],
      [
        { text: "🗑 Remove", callback_data: `TOKEN_REMOVE:${id}` },
        { text: "⬅ Back", callback_data: "WATCHLIST" },
      ],
      [{ text: "🏠 Home", callback_data: "HOME" }],
    ],
  };
}

function globalAlertsKeyboard(on, th, cd) {
  return {
    inline_keyboard: [
      [{ text: on ? "🚨 Global Alerts: ON" : "🚨 Global Alerts: OFF", callback_data: "ALERTS_TOGGLE" }],
      [
        { text: `🎯 Global Threshold: ${th}%`, callback_data: "ALERTS_SET_THRESHOLD" },
        { text: `⏱ Global Cooldown: ${cd}s`, callback_data: "ALERTS_SET_COOLDOWN" },
      ],
      [{ text: "🏠 Home", callback_data: "HOME" }],
    ],
  };
}

function ensureUser(chatId) {
  db.run("INSERT OR IGNORE INTO users(chat_id) VALUES (?)", [chatId]);
}

// “Gorktimus appears above every menu”
async function sendTerminal(chatId, caption, reply_markup) {
  const payload = {};
  if (reply_markup) payload.reply_markup = reply_markup;

  try {
    await bot.sendPhoto(chatId, INTRO_IMG, {
      caption,
      ...payload,
    });
  } catch (e) {
    // fallback if photo path fails
    await bot.sendMessage(chatId, caption, payload);
  }
}

function fmtMoney(n) {
  if (n === null || n === undefined) return "n/a";
  const num = Number(n);
  if (!Number.isFinite(num)) return "n/a";
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${Math.round(num).toLocaleString()}`;
  return `$${num}`;
}

function pctChange(prev, curr) {
  if (!prev || !curr || prev === 0) return 0;
  return ((curr - prev) / prev) * 100;
}

function arrow(prev, curr) {
  if (curr > prev) return "⬆️";
  if (curr < prev) return "⬇️";
  return "➡️";
}

// ===================== DEX HELPERS =====================
function looksLikeSolAddress(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function parseDexLink(text) {
  const m = text.match(/dexscreener\.com\/([a-z0-9_-]+)\/([a-zA-Z0-9]+)/i);
  if (!m) return null;
  return { chainId: m[1].toLowerCase(), pairAddress: m[2] };
}

async function dexscreenerSearch(q) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return Array.isArray(data?.pairs) ? data.pairs : [];
}

async function fetchPair(chainId, pairAddress) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return data?.pair || data?.pairs?.[0] || null;
}

function pickBestPair(pairs) {
  if (!pairs.length) return null;
  const sol = pairs.filter((p) => (p?.chainId || "").toLowerCase() === "solana");
  const list = sol.length ? sol : pairs;

  const scored = list
    .map((p) => ({
      chainId: (p.chainId || "").toLowerCase(),
      pairAddress: p.pairAddress,
      symbol: p?.baseToken?.symbol || "???",
      url: p.url,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liqUsd: p?.liquidity?.usd ? Number(p.liquidity.usd) : 0,
      vol24h: p?.volume?.h24 ? Number(p.volume.h24) : 0,
    }))
    .filter((x) => x.chainId && x.pairAddress);

  scored.sort((a, b) => (b.liqUsd - a.liqUsd) || (b.vol24h - a.vol24h));
  return scored[0] || null;
}

// ===================== WATCH FLOW =====================
async function handleWatchQuery(chatId, input) {
  try {
    let q = input.trim();

    // Dex link -> use pairAddress
    const dex = parseDexLink(q);
    if (dex) q = dex.pairAddress;

    // support $TICKER and @TICKER
    q = q.replace(/^\$/, "").replace(/^@/, "");

    const pairs = await dexscreenerSearch(q);
    const best = pickBestPair(pairs);

    if (!best) {
      pendingCandidate.delete(chatId);
      await sendTerminal(chatId, "❌ Couldn’t find that.\nTry: ticker (BONK) • address • DexScreener link", mainMenu());
      return;
    }

    pendingCandidate.set(chatId, best);

    const msg =
      `🛡️ GORKTIMUS IDENTIFIED\n\n` +
      `🪙 ${best.symbol}\n` +
      `Price: ${best.priceUsd !== null ? `$${best.priceUsd}` : "n/a"}\n` +
      `Liquidity: ${fmtMoney(best.liqUsd)}\n` +
      `Vol 24h: ${fmtMoney(best.vol24h)}\n\n` +
      `${best.url || `${best.chainId}/${best.pairAddress}`}\n\n` +
      `Tap ✅ Add Watch.`;

    await sendTerminal(chatId, msg, confirmKeyboard());
  } catch (e) {
    pendingCandidate.delete(chatId);
    await sendTerminal(chatId, "⚠️ Dex lookup failed. Try again in a sec.", mainMenu());
  }
}

// ===================== START =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendPhoto(chatId, INTRO_IMG, {
    caption: "🧠 Gorktimus Prime Terminal"
  });

});
  ensureUser(chatId);
  await sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.", mainMenu());
});

// ===================== BUTTONS =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const action = q.data;

  bot.answerCallbackQuery(q.id).catch(() => null);
  ensureUser(chatId);

  if (action === "HOME") {
    return sendTerminal(chatId, "🛡️ GORKTIMUS PRIME TERMINAL\nSelect an option below.", mainMenu());
  }

  if (action === "WATCH") {
    pendingAdd.set(chatId, true);
    pendingCandidate.delete(chatId);
    return sendTerminal(
      chatId,
      "👁 ADD WATCH\nSend: ticker (BONK), coin address, or DexScreener link.\n\nThen tap ✅ Add Watch.",
      mainMenu()
    );
  }

  if (action === "CANCEL_ADD") {
    pendingAdd.delete(chatId);
    pendingCandidate.delete(chatId);
    return sendTerminal(chatId, "Cancelled ✅", mainMenu());
  }

  if (action === "CONFIRM_ADD") {
    const cand = pendingCandidate.get(chatId);
    if (!cand) return sendTerminal(chatId, "Nothing to add. Tap 👁 Add Watch first.", mainMenu());

    // Prime txns once
    let pair = null;
    try { pair = await fetchPair(cand.chainId, cand.pairAddress); } catch {}
    const buys = pair?.txns?.m5?.buys ?? null;
    const sells = pair?.txns?.m5?.sells ?? null;

    db.run(
      `INSERT OR IGNORE INTO watchlist(chat_id, chain_id, pair_address, symbol, url, last_price, last_buys, last_sells)
       VALUES(?,?,?,?,?,?,?,?)`,
      [chatId, cand.chainId, cand.pairAddress, cand.symbol, cand.url, cand.priceUsd, buys, sells],
      async (err) => {
        if (err) return sendTerminal(chatId, "DB error adding watch.", mainMenu());
        pendingAdd.delete(chatId);
        pendingCandidate.delete(chatId);
        await sendTerminal(chatId, `✅ WATCHING: ${cand.symbol}\n${cand.url || `${cand.chainId}/${cand.pairAddress}`}`, mainMenu());
      }
    );
    return;
  }

  if (action === "WATCHLIST") {
    db.all(
      `SELECT id, COALESCE(symbol,'???') AS symbol
       FROM watchlist
       WHERE chat_id = ?
       ORDER BY id DESC`,
      [chatId],
      async (err, rows) => {
        if (err) return sendTerminal(chatId, "DB error reading watchlist.", mainMenu());
        if (!rows || rows.length === 0) return sendTerminal(chatId, "Watchlist empty.", mainMenu());
        await sendTerminal(chatId, "📋 WATCHLIST\nTap a token to manage:", watchlistKeyboard(rows));
      }
    );
    return;
  }

  if (action.startsWith("TOKEN:")) {
    const id = Number(action.split(":")[1]);
    db.get(
      `SELECT id, symbol, url, token_alerts_on, token_threshold, token_cooldown_sec
       FROM watchlist
       WHERE id = ? AND chat_id = ?`,
      [id, chatId],
      async (err, row) => {
        if (!row) return sendTerminal(chatId, "Token not found.", mainMenu());

        const on = (row.token_alerts_on ?? 1) === 1;
        const th = row.token_threshold ?? null;
        const cd = row.token_cooldown_sec ?? null;

        const text =
          `🪙 ${row.symbol || "???"}\n` +
          `${row.url || ""}\n\n` +
          `Token alerts: ${on ? "ON" : "OFF"}\n` +
          `Threshold: ${th ?? "GLOBAL"}%\n` +
          `Cooldown: ${cd ?? "GLOBAL"}s`;

        await sendTerminal(chatId, text, tokenKeyboard(id, on, th, cd));
      }
    );
    return;
  }

  if (action.startsWith("TOKEN_TOGGLE:")) {
    const id = Number(action.split(":")[1]);
    db.get(`SELECT token_alerts_on FROM watchlist WHERE id = ? AND chat_id = ?`, [id, chatId], async (e, row) => {
      const cur = row?.token_alerts_on ?? 1;
      const next = cur ? 0 : 1;
      db.run(`UPDATE watchlist SET token_alerts_on = ? WHERE id = ? AND chat_id = ?`, [next, id, chatId], async () => {
        await sendTerminal(chatId, next ? "🔔 Token alerts ON" : "🔕 Token alerts OFF", mainMenu());
      });
    });
    return;
  }

  if (action.startsWith("TOKEN_REMOVE:")) {
    const id = Number(action.split(":")[1]);
    db.run(`DELETE FROM watchlist WHERE id = ? AND chat_id = ?`, [id, chatId], async () => {
      await sendTerminal(chatId, "🗑 Removed from watchlist.", mainMenu());
    });
    return;
  }

  if (action.startsWith("TOKEN_SET_TH:")) {
    const id = Number(action.split(":")[1]);
    pendingAdd.set(chatId, `TOKEN_SET_THRESHOLD:${id}`);
    return sendTerminal(chatId, "Reply with token threshold % (ex: 3). Send 0 to reset to GLOBAL.", mainMenu());
  }

  if (action.startsWith("TOKEN_SET_CD:")) {
    const id = Number(action.split(":")[1]);
    pendingAdd.set(chatId, `TOKEN_SET_COOLDOWN:${id}`);
    return sendTerminal(chatId, "Reply with token cooldown seconds (ex: 120). Send 0 to reset to GLOBAL.", mainMenu());
  }

  if (action === "ALERTS_MENU") {
    db.get(`SELECT alerts_on, alert_threshold, alert_cooldown_sec FROM users WHERE chat_id = ?`, [chatId], async (e, row) => {
      const on = (row?.alerts_on ?? 1) === 1;
      const th = row?.alert_threshold ?? 3.0;
      const cd = row?.alert_cooldown_sec ?? 120;
      await sendTerminal(chatId, "🚨 GLOBAL ALERT SETTINGS", globalAlertsKeyboard(on, th, cd));
    });
    return;
  }

  if (action === "ALERTS_TOGGLE") {
    db.get(`SELECT alerts_on FROM users WHERE chat_id = ?`, [chatId], async (e, row) => {
      const cur = row?.alerts_on ?? 1;
      const next = cur ? 0 : 1;
      db.run(`UPDATE users SET alerts_on = ? WHERE chat_id = ?`, [next, chatId], async () => {
        await sendTerminal(chatId, next ? "🚨 Global alerts ON" : "🚨 Global alerts OFF", mainMenu());
      });
    });
    return;
  }

  if (action === "ALERTS_SET_THRESHOLD") {
    pendingAdd.set(chatId, "SET_USER_THRESHOLD");
    return sendTerminal(chatId, "Reply with global threshold % (ex: 3 or 5).", mainMenu());
  }

  if (action === "ALERTS_SET_COOLDOWN") {
    pendingAdd.set(chatId, "SET_USER_COOLDOWN");
    return sendTerminal(chatId, "Reply with global cooldown seconds (ex: 120).", mainMenu());
  }

  if (action === "STATUS") {
    return sendTerminal(
      chatId,
      "🟢 STATUS\n✅ Online\n✅ Image menus\n✅ Easy identify\n✅ Watch alerts\n✅ Per-token controls",
      mainMenu()
    );
  }
});

// ===================== MESSAGES =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  if (text.startsWith("/")) return;

  ensureUser(chatId);

  const mode = pendingAdd.get(chatId);

  // Global settings replies
  if (mode === "SET_USER_THRESHOLD") {
    pendingAdd.delete(chatId);
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0 || v > 100) return sendTerminal(chatId, "Bad value. Use a number like 3 or 5.", mainMenu());
    db.run(`UPDATE users SET alert_threshold = ? WHERE chat_id = ?`, [v, chatId], async () => {
      await sendTerminal(chatId, `🎯 Global threshold set to ${v}%`, mainMenu());
    });
    return;
  }

  if (mode === "SET_USER_COOLDOWN") {
    pendingAdd.delete(chatId);
    const v = Number(text);
    if (!Number.isFinite(v) || v < 15 || v > 3600) return sendTerminal(chatId, "Bad value. Use seconds 15–3600.", mainMenu());
    db.run(`UPDATE users SET alert_cooldown_sec = ? WHERE chat_id = ?`, [Math.round(v), chatId], async () => {
      await sendTerminal(chatId, `⏱ Global cooldown set to ${Math.round(v)}s`, mainMenu());
    });
    return;
  }

  // Token settings replies
  if (typeof mode === "string" && mode.startsWith("TOKEN_SET_THRESHOLD:")) {
    pendingAdd.delete(chatId);
    const id = Number(mode.split(":")[1]);
    const v = Number(text);
    if (!Number.isFinite(v) || v < 0 || v > 100) return sendTerminal(chatId, "Bad value. Use 0–100.", mainMenu());
    db.run(`UPDATE watchlist SET token_threshold = ? WHERE id = ? AND chat_id = ?`, [v === 0 ? null : v, id, chatId], async () => {
      await sendTerminal(chatId, v === 0 ? "🎯 Token threshold reset to GLOBAL" : `🎯 Token threshold set to ${v}%`, mainMenu());
    });
    return;
  }

  if (typeof mode === "string" && mode.startsWith("TOKEN_SET_COOLDOWN:")) {
    pendingAdd.delete(chatId);
    const id = Number(mode.split(":")[1]);
    const v = Number(text);
    if (!Number.isFinite(v) || v < 0 || v > 3600) return sendTerminal(chatId, "Bad value. Use 0–3600.", mainMenu());
    db.run(`UPDATE watchlist SET token_cooldown_sec = ? WHERE id = ? AND chat_id = ?`, [v === 0 ? null : Math.round(v), id, chatId], async () => {
      await sendTerminal(chatId, v === 0 ? "⏱ Token cooldown reset to GLOBAL" : `⏱ Token cooldown set to ${Math.round(v)}s`, mainMenu());
    });
    return;
  }

  // Add watch input handling
  const shouldHandle =
    pendingAdd.get(chatId) === true ||
    text.includes("dexscreener.com") ||
    looksLikeSolAddress(text) ||
    text.startsWith("$") ||
    text.startsWith("@");

  if (!shouldHandle) return;

  if (pendingAdd.get(chatId) === true) pendingAdd.delete(chatId);

  await handleWatchQuery(chatId, text);
});

// ===================== ALERT ENGINE =====================
async function runWatchAlertsTick() {
  const users = await new Promise((resolve) => {
    db.all(
      `SELECT chat_id, alerts_on, alert_threshold, alert_cooldown_sec
       FROM users
       WHERE alerts_on = 1`,
      [],
      (e, r) => resolve(r || [])
    );
  });

  if (!users.length) return;

  for (const u of users) {
    const chatId = u.chat_id;

    const tokens = await new Promise((resolve) => {
      db.all(
        `SELECT id, chain_id, pair_address, symbol, url, last_price, last_buys, last_sells, last_alert_ts,
                token_alerts_on, token_threshold, token_cooldown_sec
         FROM watchlist
         WHERE chat_id = ?`,
        [chatId],
        (e, r) => resolve(r || [])
      );
    });

    if (!tokens.length) continue;

    for (const w of tokens) {
      if ((w.token_alerts_on ?? 1) !== 1) continue;

      const threshold = Number(w.token_threshold ?? u.alert_threshold ?? 3.0);
      const cooldownMs = Number(w.token_cooldown_sec ?? u.alert_cooldown_sec ?? 120) * 1000;

      let pair = null;
      try { pair = await fetchPair(w.chain_id, w.pair_address); } catch { continue; }
      if (!pair) continue;

      const price = pair?.priceUsd ? Number(pair.priceUsd) : null;
      if (!price) continue;

      const prev = w.last_price ? Number(w.last_price) : null;
      const pct = prev ? pctChange(prev, price) : 0;

      const now = Date.now();
      const lastTs = Number(w.last_alert_ts || 0);
      const canPing = now - lastTs >= cooldownMs;

      const buys = pair?.txns?.m5?.buys ?? null;
      const sells = pair?.txns?.m5?.sells ?? null;

      const buyDelta =
        w.last_buys !== null && buys !== null ? Number(buys) - Number(w.last_buys) : null;
      const sellDelta =
        w.last_sells !== null && sells !== null ? Number(sells) - Number(w.last_sells) : null;

      if (prev && Math.abs(pct) >= threshold && canPing) {
        const sym = w.symbol || pair?.baseToken?.symbol || "???";
        const liqUsd = pair?.liquidity?.usd ?? null;
        const a = arrow(prev, price);

        const out = [
          `👁 WATCH ALERT ${a}  ${sym}`,
          `Move: ${pct.toFixed(2)}% | Price: $${price}`,
          (buyDelta !== null || sellDelta !== null)
            ? `Tx (5m) since last: buys ${buyDelta ?? "?"} / sells ${sellDelta ?? "?"}`
            : `Tx (5m): n/a`,
          liqUsd ? `Liquidity: ${fmtMoney(liqUsd)}` : "",
          pair?.url || w.url || `${w.chain_id}/${w.pair_address}`,
        ].filter(Boolean).join("\n");

        bot.sendMessage(chatId, out).catch(() => null);
        db.run(`UPDATE watchlist SET last_alert_ts = ? WHERE id = ?`, [now, w.id]);
      }

      // silent refresh
      db.run(
        `UPDATE watchlist
         SET last_price = ?, last_buys = COALESCE(?, last_buys), last_sells = COALESCE(?, last_sells),
             symbol = COALESCE(?, symbol), url = COALESCE(?, url)
         WHERE id = ?`,
        [
          price,
          buys,
          sells,
          pair?.baseToken?.symbol || w.symbol,
          pair?.url || w.url,
          w.id,
        ]
      );
    }
  }
}

// run every 60 seconds
setInterval(() => {
  runWatchAlertsTick().catch(() => null);
}, 60 * 1000);

// ===================== ERRORS =====================
bot.on("polling_error", (err) => {
  console.error("❌ polling_error:", err?.message || err);
});

console.log("🛡️ Gorktimus bot running (image menus + per-token controls)");
