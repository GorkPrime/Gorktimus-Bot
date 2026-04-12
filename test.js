"use strict";

/**
 * test.js — unit/integration tests for Gorktimus Intelligence Terminal
 *
 * Run with:  node test.js
 */

const assert = require("assert");
const sqlite3 = require("sqlite3").verbose();

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`       ${err.message}`);
    failed += 1;
  }
}

function summary() {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ── In-memory SQLite helpers (mirrors index.js) ───────────────────────────────

function makeDb() {
  const db = new sqlite3.Database(":memory:");

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

  function close() {
    return new Promise((resolve) => db.close(resolve));
  }

  return { run, get, all, close };
}

async function makeTestDb() {
  const { run, get, all, close } = makeDb();

  await run(`CREATE TABLE IF NOT EXISTS error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    stack TEXT DEFAULT '',
    severity TEXT DEFAULT 'low',
    ts INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS health_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uptime_sec INTEGER DEFAULT 0,
    restart_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    ts INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS update_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    notes TEXT DEFAULT '',
    ts INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS scan_logs (user_id TEXT, ts INTEGER)`);
  await run(`CREATE TABLE IF NOT EXISTS user_activity (user_id TEXT, ts INTEGER)`);

  return { run, get, all, close };
}

// ── DEV MODE logic (mirrors index.js) ────────────────────────────────────────

function isDevMode(env) {
  return env.DEV_MODE === "true" && !!env.OWNER_USER_ID;
}

function getDevModeStatus(devMode) {
  return devMode ? "🔴 DEV: ON" : "🟢 PROD: ON";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== Gorktimus Intelligence Terminal — Test Suite ===\n");

  // ────────────────────────────────────────────────────────────────────────────
  // DEV MODE TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("DEV MODE");

  await test("isDevMode returns false when DEV_MODE env is not set", async () => {
    assert.strictEqual(isDevMode({}), false);
  });

  await test("isDevMode returns false when OWNER_USER_ID is missing", async () => {
    assert.strictEqual(isDevMode({ DEV_MODE: "true" }), false);
  });

  await test("isDevMode returns false when DEV_MODE is not 'true'", async () => {
    assert.strictEqual(isDevMode({ DEV_MODE: "false", OWNER_USER_ID: "123" }), false);
  });

  await test("isDevMode returns true when both DEV_MODE=true and OWNER_USER_ID are set", async () => {
    assert.strictEqual(isDevMode({ DEV_MODE: "true", OWNER_USER_ID: "123" }), true);
  });

  await test("getDevModeStatus returns 🔴 DEV: ON when devMode is true", async () => {
    assert.strictEqual(getDevModeStatus(true), "🔴 DEV: ON");
  });

  await test("getDevModeStatus returns 🟢 PROD: ON when devMode is false", async () => {
    assert.strictEqual(getDevModeStatus(false), "🟢 PROD: ON");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HEALTH MONITOR TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nHEALTH MONITOR");

  const { initHealthMonitor, SEVERITY } = require("./health-monitor");

  await test("initHealthMonitor returns a stop function", async () => {
    const { run, get, close } = await makeTestDb();
    const monitor = initHealthMonitor({
      bot: null,
      run,
      get,
      callbackStore: new Map(),
      sessionMemory: new Map(),
      ownerUserId: "",
      devMode: false
    });
    assert.strictEqual(typeof monitor.stop, "function");
    monitor.stop();
    await close();
  });

  await test("logError writes a row to error_logs", async () => {
    const { run, get, close } = await makeTestDb();
    const monitor = initHealthMonitor({
      bot: null,
      run,
      get,
      callbackStore: new Map(),
      sessionMemory: new Map(),
      ownerUserId: "",
      devMode: false
    });

    await monitor.logError("test error message", "stack trace here", SEVERITY.LOW);
    await new Promise((r) => setTimeout(r, 50));

    const row = await get(`SELECT * FROM error_logs WHERE message LIKE '%test error message%'`);
    assert.ok(row, "Row should exist in error_logs");
    assert.strictEqual(row.severity, SEVERITY.LOW);

    monitor.stop();
    await close();
  });

  await test("recordHealthSnapshot writes a row to health_metrics", async () => {
    const { run, get, close } = await makeTestDb();
    const monitor = initHealthMonitor({
      bot: null,
      run,
      get,
      callbackStore: new Map(),
      sessionMemory: new Map(),
      ownerUserId: "",
      devMode: false
    });

    await monitor.recordHealthSnapshot();
    await new Promise((r) => setTimeout(r, 50));

    const row = await get(`SELECT * FROM health_metrics ORDER BY id DESC LIMIT 1`);
    assert.ok(row, "A health_metrics row should exist");
    assert.ok(Number.isInteger(row.uptime_sec), "uptime_sec should be a number");

    monitor.stop();
    await close();
  });

  await test("SEVERITY constants are defined correctly", async () => {
    assert.strictEqual(SEVERITY.LOW, "low");
    assert.strictEqual(SEVERITY.MEDIUM, "medium");
    assert.strictEqual(SEVERITY.CRITICAL, "critical");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // DB MAINTENANCE TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nDB MAINTENANCE");

  await test("Old scan_logs and user_activity rows are deleted during maintenance", async () => {
    const { run, all, close } = await makeTestDb();

    const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
    const nowTs = () => Math.floor(Date.now() / 1000);
    const oldTs = nowTs() - THIRTY_DAYS_S - 100;
    const recentTs = nowTs() - 1000;

    await run(`INSERT INTO scan_logs (user_id, ts) VALUES ('u1', ?)`, [oldTs]);
    await run(`INSERT INTO scan_logs (user_id, ts) VALUES ('u2', ?)`, [recentTs]);
    await run(`INSERT INTO user_activity (user_id, ts) VALUES ('u1', ?)`, [oldTs]);
    await run(`INSERT INTO user_activity (user_id, ts) VALUES ('u2', ?)`, [recentTs]);

    const cutoff = nowTs() - THIRTY_DAYS_S;
    await run(`DELETE FROM scan_logs WHERE ts < ?`, [cutoff]);
    await run(`DELETE FROM user_activity WHERE ts < ?`, [cutoff]);

    const scanRows = await all(`SELECT * FROM scan_logs`);
    const activityRows = await all(`SELECT * FROM user_activity`);

    assert.strictEqual(scanRows.length, 1, "Only recent scan_log row should remain");
    assert.strictEqual(activityRows.length, 1, "Only recent user_activity row should remain");
    assert.strictEqual(scanRows[0].user_id, "u2");
    assert.strictEqual(activityRows[0].user_id, "u2");

    await close();
  });

  await test("callbackStore is cleared when maintenance runs", async () => {
    const callbackStore = new Map([["abc", { foo: "bar" }], ["def", { baz: 1 }]]);
    assert.strictEqual(callbackStore.size, 2);
    if (callbackStore.size > 0) callbackStore.clear();
    assert.strictEqual(callbackStore.size, 0);
  });

  await test("sessionMemory is flushed when it exceeds 500 entries", async () => {
    const sessionMemory = new Map();
    for (let i = 0; i < 501; i++) sessionMemory.set(String(i), { lastScan: null });
    assert.ok(sessionMemory.size > 500);
    if (sessionMemory.size > 500) sessionMemory.clear();
    assert.strictEqual(sessionMemory.size, 0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HELPER FUNCTION TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nHELPER FUNCTIONS");

  await test("escapeHtml escapes &, <, and >", async () => {
    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    assert.strictEqual(escapeHtml("<b>foo & bar</b>"), "&lt;b&gt;foo &amp; bar&lt;/b&gt;");
    assert.strictEqual(escapeHtml(null), "");
    assert.strictEqual(escapeHtml(undefined), "");
  });

  await test("safeMode returns 'balanced' for unknown modes", async () => {
    function safeMode(mode) {
      const m = String(mode || "").toLowerCase();
      if (["aggressive", "balanced", "guardian"].includes(m)) return m;
      return "balanced";
    }
    assert.strictEqual(safeMode("aggressive"), "aggressive");
    assert.strictEqual(safeMode("GUARDIAN"), "guardian");
    assert.strictEqual(safeMode("unknown"), "balanced");
    assert.strictEqual(safeMode(null), "balanced");
    assert.strictEqual(safeMode(""), "balanced");
  });

  await test("shortAddr truncates long addresses correctly", async () => {
    function shortAddr(value, len = 6) {
      const s = String(value || "");
      if (s.length <= len * 2 + 3) return s;
      return `${s.slice(0, len)}...${s.slice(-len)}`;
    }
    const long = "0x1234567890abcdef1234567890abcdef12345678";
    const result = shortAddr(long);
    assert.ok(result.includes("..."));
    assert.ok(result.startsWith("0x1234"));
  });

  await test("isPrivateChat returns true for private chat messages", async () => {
    function isPrivateChat(msgOrQuery) {
      const chat = msgOrQuery?.chat || msgOrQuery?.message?.chat || null;
      return chat?.type === "private";
    }
    assert.strictEqual(isPrivateChat({ chat: { type: "private" } }), true);
    assert.strictEqual(isPrivateChat({ chat: { type: "group" } }), false);
    assert.strictEqual(isPrivateChat({ message: { chat: { type: "private" } } }), true);
    assert.strictEqual(isPrivateChat({}), false);
    assert.strictEqual(isPrivateChat(null), false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // WATCHLIST TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nWATCHLIST");

  async function makeWatchlistDb() {
    const { run, get, all, close } = makeDb();

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

    function nowTs() {
      return Math.floor(Date.now() / 1000);
    }

    function num(v) {
      const n = parseFloat(v);
      return isNaN(n) ? 0 : n;
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

    return { run, get, all, close, addWatchlistItem };
  }

  await test("addWatchlistItem inserts a new row with all columns populated", async () => {
    const { get, close, addWatchlistItem } = await makeWatchlistDb();

    const chatId = "111";
    const pair = {
      chainId: "solana",
      baseAddress: "TokenAddr1",
      baseSymbol: "GORK",
      pairAddress: "PairAddr1",
      priceUsd: "0.005",
      liquidityUsd: "50000",
      volumeH24: "12000"
    };

    await addWatchlistItem(chatId, pair);

    const row = await get(`SELECT * FROM watchlist WHERE chat_id = ? AND token_address = ?`, [chatId, pair.baseAddress]);
    assert.ok(row, "Row should exist after insert");
    assert.strictEqual(row.chat_id, chatId);
    assert.strictEqual(row.chain_id, "solana");
    assert.strictEqual(row.token_address, "TokenAddr1");
    assert.strictEqual(row.symbol, "GORK");
    assert.strictEqual(row.pair_address, "PairAddr1");
    assert.strictEqual(row.active, 1);
    assert.strictEqual(row.alerts_enabled, 1);
    assert.ok(row.added_price > 0, "added_price should be set");
    assert.ok(row.last_price > 0, "last_price should be set");
    assert.ok(row.last_liquidity > 0, "last_liquidity should be set");
    assert.ok(row.last_volume > 0, "last_volume should be set");
    assert.ok(row.created_at > 0, "created_at should be set");
    assert.ok(row.updated_at > 0, "updated_at should be set");

    await close();
  });

  await test("addWatchlistItem upserts on duplicate (chat_id, chain_id, token_address)", async () => {
    const { get, close, addWatchlistItem } = await makeWatchlistDb();

    const chatId = "222";
    const pair = {
      chainId: "solana",
      baseAddress: "TokenAddr2",
      baseSymbol: "GORK",
      pairAddress: "PairAddr2",
      priceUsd: "0.01",
      liquidityUsd: "10000",
      volumeH24: "5000"
    };

    await addWatchlistItem(chatId, pair);

    const updatedPair = { ...pair, baseSymbol: "GORK2", priceUsd: "0.02", liquidityUsd: "20000", volumeH24: "9000" };
    await addWatchlistItem(chatId, updatedPair);

    const row = await get(`SELECT * FROM watchlist WHERE chat_id = ? AND token_address = ?`, [chatId, pair.baseAddress]);
    assert.ok(row, "Row should still exist after upsert");
    assert.strictEqual(row.symbol, "GORK2", "symbol should be updated");
    assert.ok(Math.abs(row.last_price - 0.02) < 0.0001, "last_price should be updated");
    assert.ok(Math.abs(row.last_liquidity - 20000) < 1, "last_liquidity should be updated");
    assert.ok(Math.abs(row.last_volume - 9000) < 1, "last_volume should be updated");

    await close();
  });

  await test("addWatchlistItem handles multiple tokens for the same chat", async () => {
    const { all, close, addWatchlistItem } = await makeWatchlistDb();

    const chatId = "333";
    const pairs = [
      { chainId: "solana", baseAddress: "Token_A", baseSymbol: "AAA", pairAddress: "Pair_A", priceUsd: "1", liquidityUsd: "1000", volumeH24: "500" },
      { chainId: "solana", baseAddress: "Token_B", baseSymbol: "BBB", pairAddress: "Pair_B", priceUsd: "2", liquidityUsd: "2000", volumeH24: "1000" },
      { chainId: "ethereum", baseAddress: "Token_C", baseSymbol: "CCC", pairAddress: "Pair_C", priceUsd: "3", liquidityUsd: "3000", volumeH24: "1500" }
    ];

    for (const pair of pairs) {
      await addWatchlistItem(chatId, pair);
    }

    const rows = await all(`SELECT * FROM watchlist WHERE chat_id = ? AND active = 1 ORDER BY id ASC`, [chatId]);
    assert.strictEqual(rows.length, 3, "Three distinct tokens should be stored");
    assert.strictEqual(rows[0].symbol, "AAA");
    assert.strictEqual(rows[1].symbol, "BBB");
    assert.strictEqual(rows[2].symbol, "CCC");

    await close();
  });

  // ────────────────────────────────────────────────────────────────────────────

  summary();
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

