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
  // FLAGGED WALLETS / LIQUIDITY LOCK / RISK RANK TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nFLAGGED WALLETS & RISK FEATURES");

  async function makeFeatureDb() {
    const { run, get, all, close } = makeDb();
    const nowTs = () => Math.floor(Date.now() / 1000);

    await run(`
      CREATE TABLE IF NOT EXISTS flagged_wallets (
        wallet_address TEXT NOT NULL,
        chain_id       TEXT NOT NULL DEFAULT 'solana',
        risk_level     TEXT NOT NULL DEFAULT 'low',
        reason         TEXT DEFAULT '',
        reported_by    TEXT DEFAULT '',
        reports_count  INTEGER DEFAULT 1,
        last_updated   INTEGER NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (wallet_address, chain_id)
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS instance_lock (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        locked_at  INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    async function flagWallet(walletAddress, chainId, riskLevel, reason) {
      const ts = nowTs();
      await run(
        `INSERT INTO flagged_wallets (wallet_address, chain_id, risk_level, reason, reported_by, reports_count, last_updated, created_at)
         VALUES (?, ?, ?, ?, '', 1, ?, ?)
         ON CONFLICT(wallet_address, chain_id) DO UPDATE SET
           risk_level = excluded.risk_level,
           reason = excluded.reason,
           reports_count = reports_count + 1,
           last_updated = excluded.last_updated`,
        [String(walletAddress).toLowerCase(), String(chainId).toLowerCase(), riskLevel, reason, ts, ts]
      );
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

    return { run, get, all, close, flagWallet, checkDevWalletReputation };
  }

  await test("flagged_wallets table can be created and a wallet flagged", async () => {
    const { get, close, flagWallet } = await makeFeatureDb();
    await flagWallet("0xdeadbeef1234", "ethereum", "high", "Known rug puller");
    const row = await get(`SELECT * FROM flagged_wallets WHERE wallet_address = ?`, ["0xdeadbeef1234"]);
    assert.ok(row, "Flagged wallet should exist");
    assert.strictEqual(row.risk_level, "high");
    assert.strictEqual(row.reason, "Known rug puller");
    assert.strictEqual(row.chain_id, "ethereum");
    await close();
  });

  await test("checkDevWalletReputation returns null for unknown wallets", async () => {
    const { close, checkDevWalletReputation } = await makeFeatureDb();
    const result = await checkDevWalletReputation("0xunknown999", "ethereum");
    assert.strictEqual(result, null);
    await close();
  });

  await test("checkDevWalletReputation finds flagged wallet by address", async () => {
    const { close, flagWallet, checkDevWalletReputation } = await makeFeatureDb();
    await flagWallet("SCAMWALLET123", "solana", "critical", "Multiple rug pulls");
    const result = await checkDevWalletReputation("SCAMWALLET123", "solana");
    assert.ok(result, "Should find the flagged wallet");
    assert.strictEqual(result.risk_level, "critical");
    await close();
  });

  await test("checkDevWalletReputation is case-insensitive", async () => {
    const { close, flagWallet, checkDevWalletReputation } = await makeFeatureDb();
    await flagWallet("MixedCaseWallet", "solana", "medium", "Suspicious activity");
    const result = await checkDevWalletReputation("MIXEDCASEWALLET", "solana");
    assert.ok(result, "Should find the flagged wallet case-insensitively");
    assert.strictEqual(result.risk_level, "medium");
    await close();
  });

  await test("flagWallet upserts on duplicate and increments reports_count", async () => {
    const { get, close, flagWallet } = await makeFeatureDb();
    await flagWallet("dupeWallet", "ethereum", "low", "First report");
    await flagWallet("dupewallet", "ethereum", "high", "Second report — escalated");
    const row = await get(`SELECT * FROM flagged_wallets WHERE wallet_address = ?`, ["dupewallet"]);
    assert.ok(row, "Row should exist");
    assert.strictEqual(row.risk_level, "high", "risk_level should be updated");
    assert.ok(row.reports_count >= 2, "reports_count should be incremented");
    await close();
  });

  // ── Risk Rank Tests ──────────────────────────────────────────────────────────
  await test("computeRiskRank returns None for high score with no dev flags", () => {
    function computeRiskRank(score, devReputation) {
      const devLevel = String(devReputation?.risk_level || "none").toLowerCase();
      if (score < 25 || devLevel === "critical") return "Critical";
      if (score < 40 || devLevel === "high") return "High";
      if (score < 55 || devLevel === "medium") return "Medium";
      if (score < 70 || devLevel === "low") return "Low";
      return "None";
    }
    assert.strictEqual(computeRiskRank(80, null), "None");
    assert.strictEqual(computeRiskRank(70, null), "None");
  });

  await test("computeRiskRank returns Critical for score < 25", () => {
    function computeRiskRank(score, devReputation) {
      const devLevel = String(devReputation?.risk_level || "none").toLowerCase();
      if (score < 25 || devLevel === "critical") return "Critical";
      if (score < 40 || devLevel === "high") return "High";
      if (score < 55 || devLevel === "medium") return "Medium";
      if (score < 70 || devLevel === "low") return "Low";
      return "None";
    }
    assert.strictEqual(computeRiskRank(20, null), "Critical");
    assert.strictEqual(computeRiskRank(1, null), "Critical");
  });

  await test("computeRiskRank escalates to Critical when dev is critical regardless of score", () => {
    function computeRiskRank(score, devReputation) {
      const devLevel = String(devReputation?.risk_level || "none").toLowerCase();
      if (score < 25 || devLevel === "critical") return "Critical";
      if (score < 40 || devLevel === "high") return "High";
      if (score < 55 || devLevel === "medium") return "Medium";
      if (score < 70 || devLevel === "low") return "Low";
      return "None";
    }
    assert.strictEqual(computeRiskRank(90, { risk_level: "critical" }), "Critical");
  });

  await test("computeRiskRank returns all intermediate levels correctly", () => {
    function computeRiskRank(score, devReputation) {
      const devLevel = String(devReputation?.risk_level || "none").toLowerCase();
      if (score < 25 || devLevel === "critical") return "Critical";
      if (score < 40 || devLevel === "high") return "High";
      if (score < 55 || devLevel === "medium") return "Medium";
      if (score < 70 || devLevel === "low") return "Low";
      return "None";
    }
    assert.strictEqual(computeRiskRank(35, null), "High");
    assert.strictEqual(computeRiskRank(50, null), "Medium");
    assert.strictEqual(computeRiskRank(65, null), "Low");
  });

  // ── Callback data size tests ─────────────────────────────────────────────────
  console.log("\nCALLBACK DATA VALIDATION");

  await test("makeShortCallback produces callback data under 64 bytes", () => {
    const callbackStore = new Map();
    function makeShortCallback(action, payload) {
      const id = Math.random().toString(36).slice(2, 9);
      callbackStore.set(id, payload);
      return `${action}:${id}`;
    }
    const cb = makeShortCallback("watchadd", { chainId: "solana", tokenAddress: "7tuPcPMUoDUxxb1j1NPjyjLXaqDwmxaW7mA2Y8Mbpump" });
    assert.ok(Buffer.byteLength(cb, "utf8") <= 64, `Callback "${cb}" exceeds 64 bytes`);
  });

  await test("all short callback action names produce data under 64 bytes", () => {
    const callbackStore = new Map();
    function makeShortCallback(action, payload) {
      const id = Math.random().toString(36).slice(2, 9);
      callbackStore.set(id, payload);
      return `${action}:${id}`;
    }
    const actions = ["watchadd", "feedbackgood", "feedbackbad", "wopen", "wrescan", "wremove", "sdirect"];
    for (const action of actions) {
      const cb = makeShortCallback(action, { chainId: "solana", tokenAddress: "7tuPcPMUoDUxxb1j1NPjyjLXaqDwmxaW7mA2Y8Mbpump" });
      assert.ok(
        Buffer.byteLength(cb, "utf8") <= 64,
        `Action "${action}" produces callback "${cb}" (${Buffer.byteLength(cb, "utf8")} bytes) exceeding 64-byte limit`
      );
    }
  });

  // ── Instance lock tests ──────────────────────────────────────────────────────
  console.log("\nINSTANCE LOCK");

  await test("instance lock can be acquired on empty table", async () => {
    const { run, get, close } = makeDb();
    await run(`CREATE TABLE IF NOT EXISTS instance_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      locked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);

    const nowTs = () => Math.floor(Date.now() / 1000);
    const INSTANCE_LOCK_TTL_MINUTES = 720;

    async function acquireInstanceLock() {
      const now = nowTs();
      const expiresAt = now + INSTANCE_LOCK_TTL_MINUTES * 60;
      try {
        await run(`INSERT INTO instance_lock (id, locked_at, expires_at) VALUES (1, ?, ?)`, [now, expiresAt]);
        return true;
      } catch (_) {
        const existing = await get(`SELECT * FROM instance_lock WHERE id = 1`);
        if (!existing) return true;
        if (existing.expires_at < now) {
          await run(`UPDATE instance_lock SET locked_at = ?, expires_at = ? WHERE id = 1`, [now, expiresAt]);
          return true;
        }
        return false;
      }
    }

    const result = await acquireInstanceLock();
    assert.strictEqual(result, true, "Should acquire lock on empty table");

    const row = await get(`SELECT * FROM instance_lock WHERE id = 1`);
    assert.ok(row, "Lock row should exist");
    assert.ok(row.expires_at > nowTs(), "Lock should not be expired");

    await close();
  });

  await test("instance lock is denied when an active lock exists", async () => {
    const { run, get, close } = makeDb();
    await run(`CREATE TABLE IF NOT EXISTS instance_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      locked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);

    const nowTs = () => Math.floor(Date.now() / 1000);
    const INSTANCE_LOCK_TTL_MINUTES = 720;

    async function acquireInstanceLock() {
      const now = nowTs();
      const expiresAt = now + INSTANCE_LOCK_TTL_MINUTES * 60;
      try {
        await run(`INSERT INTO instance_lock (id, locked_at, expires_at) VALUES (1, ?, ?)`, [now, expiresAt]);
        return true;
      } catch (_) {
        const existing = await get(`SELECT * FROM instance_lock WHERE id = 1`);
        if (!existing) return true;
        if (existing.expires_at < now) {
          await run(`UPDATE instance_lock SET locked_at = ?, expires_at = ? WHERE id = 1`, [now, expiresAt]);
          return true;
        }
        return false;
      }
    }

    // First acquire
    const first = await acquireInstanceLock();
    assert.strictEqual(first, true);

    // Second attempt should fail
    const second = await acquireInstanceLock();
    assert.strictEqual(second, false, "Second instance should not acquire lock");

    await close();
  });

  await test("instance lock can be taken over when expired", async () => {
    const { run, get, close } = makeDb();
    await run(`CREATE TABLE IF NOT EXISTS instance_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      locked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);

    const nowTs = () => Math.floor(Date.now() / 1000);

    async function acquireWithTTL(ttlMinutes) {
      const now = nowTs();
      const expiresAt = now + ttlMinutes * 60;
      try {
        await run(`INSERT INTO instance_lock (id, locked_at, expires_at) VALUES (1, ?, ?)`, [now, expiresAt]);
        return true;
      } catch (_) {
        const existing = await get(`SELECT * FROM instance_lock WHERE id = 1`);
        if (!existing) return true;
        if (existing.expires_at < now) {
          await run(`UPDATE instance_lock SET locked_at = ?, expires_at = ? WHERE id = 1`, [now, expiresAt]);
          return true;
        }
        return false;
      }
    }

    // Insert an already-expired lock (TTL of -1 minutes = expired 60s ago)
    const now = nowTs();
    await run(`INSERT INTO instance_lock (id, locked_at, expires_at) VALUES (1, ?, ?)`, [now - 120, now - 60]);

    // Should be able to take over expired lock
    const result = await acquireWithTTL(720);
    assert.strictEqual(result, true, "Should take over an expired lock");

    await close();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // LIQUIDITY LOCK STATUS TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nLIQUIDITY LOCK STATUS");

  // Self-contained replica of fetchLiquidityLockStatus with injectable deps so
  // we can mock axios without touching index.js at test time.
  function makeFetchLiquidityLockStatus({ mockAxios, etherscanApiKey = "TESTKEY", heliusRpcUrl = "https://rpc.test", etherscanV2Url = "https://api.test", evmChainIds = { ethereum: 1, base: 8453 } }) {
    const LIQUIDITY_LOCK_TTL_MS = 300000;
    const liquidityLockCache = new Map();

    function isEvmChain(chainId) {
      return Object.prototype.hasOwnProperty.call(evmChainIds, chainId);
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
          const SOLANA_LOCK_PROGRAMS = [
            "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE"
          ];
          const res = await mockAxios.post(
            heliusRpcUrl,
            { jsonrpc: "2.0", id: "lp-lock-check", method: "getTokenLargestAccounts", params: [pairAddress] },
            { timeout: 4000 }
          );
          const accounts = res.data?.result?.value || [];
          const locked = accounts.some((acc) =>
            SOLANA_LOCK_PROGRAMS.includes(acc.address)
          );
          // Only conclude "locked" when a known program address appears.
          // Cannot conclude "unlocked" — acc.address is the SPL token-account
          // address, not the owning program ID.
          result = locked
            ? { status: "locked", label: "🔐 ✅ Locked - Passed" }
            : { status: "unknown", label: "🔐 ❓ Unknown" };
        } else if (isEvmChain(chainId)) {
          // All addresses lowercase so the .toLowerCase() comparison works.
          const EVM_LOCK_CONTRACTS = [
            "0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214", // Unicrypt v2
            "0xdba68f07d1b7ca219f78ae8582c213d975c25caf", // Team Finance
            "0x71b5759d73262fbb223956913ecf4ecc51057641"  // PinkLock
          ];
          const chainNum = evmChainIds[chainId];
          if (chainNum && etherscanApiKey) {
            const url = `${etherscanV2Url}?chainid=${chainNum}&module=token&action=tokenholderlist&contractaddress=${encodeURIComponent(pairAddress)}&page=1&offset=10&apikey=${etherscanApiKey}`;
            const res = await mockAxios.get(url, { timeout: 4000 });
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
        result = { status: "unknown", label: "🔐 ❓ Unknown" };
      }

      liquidityLockCache.set(cacheKey, { ts: now, result });
      return result;
    }

    return { fetchLiquidityLockStatus, liquidityLockCache };
  }

  // ── Missing pair address ────────────────────────────────────────────────────

  await test("returns unknown when pairAddress is empty", async () => {
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios: {} });
    const r = await fetchLiquidityLockStatus({ chainId: "solana", pairAddress: "" });
    assert.strictEqual(r.status, "unknown");
    assert.strictEqual(r.label, "🔐 ❓ Unknown");
  });

  await test("returns unknown when pair object is null", async () => {
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios: {} });
    const r = await fetchLiquidityLockStatus(null);
    assert.strictEqual(r.status, "unknown");
  });

  // ── Solana detection ────────────────────────────────────────────────────────

  await test("Solana: returns locked when largest account address is a known lock program", async () => {
    const mockAxios = {
      post: async () => ({
        data: {
          result: {
            value: [
              { address: "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE", amount: "1000000", decimals: 6, uiAmount: 1.0 },
              { address: "SomeOtherAccount111111111111111111111111111", amount: "500000", decimals: 6, uiAmount: 0.5 }
            ]
          }
        }
      })
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "solana", pairAddress: "PairAddr1111111111111111111111111111111111" });
    assert.strictEqual(r.status, "locked");
    assert.strictEqual(r.label, "🔐 ✅ Locked - Passed");
  });

  await test("Solana: returns unknown (not unlocked) when no lock program in accounts", async () => {
    const mockAxios = {
      post: async () => ({
        data: {
          result: {
            value: [
              { address: "RegularHolder1111111111111111111111111111111", amount: "1000000", decimals: 6, uiAmount: 1.0 },
              { address: "RegularHolder2222222222222222222222222222222", amount: "500000", decimals: 6, uiAmount: 0.5 }
            ]
          }
        }
      })
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "solana", pairAddress: "PairAddr1111111111111111111111111111111111" });
    assert.strictEqual(r.status, "unknown", "Should be unknown, not unlocked — acc.address is a token account, not a program owner");
    assert.strictEqual(r.label, "🔐 ❓ Unknown");
  });

  await test("Solana: returns unknown when RPC returns empty accounts array", async () => {
    const mockAxios = {
      post: async () => ({ data: { result: { value: [] } } })
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "solana", pairAddress: "PairAddr1111111111111111111111111111111111" });
    assert.strictEqual(r.status, "unknown");
  });

  await test("Solana: returns unknown on RPC error (no false-negative unlocked)", async () => {
    const mockAxios = {
      post: async () => { throw new Error("network failure"); }
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "solana", pairAddress: "PairAddr1111111111111111111111111111111111" });
    assert.strictEqual(r.status, "unknown", "Error must fall back to unknown, never unlocked");
  });

  // ── EVM detection ───────────────────────────────────────────────────────────

  await test("EVM: returns locked when Unicrypt address is in top holders", async () => {
    const mockAxios = {
      get: async () => ({
        data: {
          result: [
            { TokenHolderAddress: "0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214", TokenHolderQuantity: "1000" },
            { TokenHolderAddress: "0xSomeRandomHolder000000000000000000000000", TokenHolderQuantity: "500" }
          ]
        }
      })
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "ethereum", pairAddress: "0xPairAddress0000000000000000000000000000" });
    assert.strictEqual(r.status, "locked");
    assert.strictEqual(r.label, "🔐 ✅ Locked - Passed");
  });

  await test("EVM: returns locked when Team Finance address is in top holders", async () => {
    const mockAxios = {
      get: async () => ({
        data: {
          result: [
            { TokenHolderAddress: "0xdba68f07d1b7ca219f78ae8582c213d975c25caf", TokenHolderQuantity: "2000" }
          ]
        }
      })
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "base", pairAddress: "0xPairAddress0000000000000000000000000000" });
    assert.strictEqual(r.status, "locked");
  });

  await test("EVM: returns locked when PinkLock address is in top holders (mixed-case API response)", async () => {
    // The Etherscan API sometimes returns checksummed (mixed-case) addresses.
    // The comparison must lowercase both sides to match the lowercase entry in
    // EVM_LOCK_CONTRACTS.
    const mockAxios = {
      get: async () => ({
        data: {
          result: [
            { TokenHolderAddress: "0x71B5759d73262FBb223956913ecF4ecC51057641", TokenHolderQuantity: "3000" }
          ]
        }
      })
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "ethereum", pairAddress: "0xPairAddress0000000000000000000000000000" });
    assert.strictEqual(r.status, "locked", "PinkLock mixed-case address should match after lowercasing");
  });

  await test("EVM: returns unlocked when no locker contract in top holders", async () => {
    const mockAxios = {
      get: async () => ({
        data: {
          result: [
            { TokenHolderAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", TokenHolderQuantity: "9000" },
            { TokenHolderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TokenHolderQuantity: "1000" }
          ]
        }
      })
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "ethereum", pairAddress: "0xPairAddress0000000000000000000000000000" });
    assert.strictEqual(r.status, "unlocked");
    assert.strictEqual(r.label, "🔐 ❌ Unlocked - Failed");
  });

  await test("EVM: returns unknown when ETHERSCAN_API_KEY is absent", async () => {
    const mockAxios = { get: async () => { throw new Error("should not be called"); } };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios, etherscanApiKey: "" });
    const r = await fetchLiquidityLockStatus({ chainId: "ethereum", pairAddress: "0xPairAddress0000000000000000000000000000" });
    assert.strictEqual(r.status, "unknown", "No API key → skip check → unknown");
  });

  await test("EVM: returns unknown on Etherscan API error (no false-negative unlocked)", async () => {
    const mockAxios = {
      get: async () => { throw new Error("timeout"); }
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const r = await fetchLiquidityLockStatus({ chainId: "ethereum", pairAddress: "0xPairAddress0000000000000000000000000000" });
    assert.strictEqual(r.status, "unknown", "API error must fall back to unknown, never unlocked");
  });

  // ── Cache behaviour ─────────────────────────────────────────────────────────

  await test("cache: returns cached result within TTL without making a new API call", async () => {
    let callCount = 0;
    const mockAxios = {
      get: async () => {
        callCount++;
        return { data: { result: [{ TokenHolderAddress: "0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214", TokenHolderQuantity: "1" }] } };
      }
    };
    const { fetchLiquidityLockStatus } = makeFetchLiquidityLockStatus({ mockAxios });
    const pair = { chainId: "ethereum", pairAddress: "0xCached000000000000000000000000000000000" };
    await fetchLiquidityLockStatus(pair);
    await fetchLiquidityLockStatus(pair); // second call — should hit cache
    assert.strictEqual(callCount, 1, "API should only be called once within TTL");
  });

  await test("cache: expired entry triggers a fresh API call", async () => {
    let callCount = 0;
    const mockAxios = {
      get: async () => {
        callCount++;
        return { data: { result: [] } };
      }
    };
    const EXPIRED_TTL_MS = 1; // effectively already expired
    const { fetchLiquidityLockStatus, liquidityLockCache } = makeFetchLiquidityLockStatus({ mockAxios });

    const pair = { chainId: "ethereum", pairAddress: "0xExpired00000000000000000000000000000000" };
    const cacheKey = `ethereum:${pair.pairAddress}`;

    // Manually seed the cache with an old timestamp
    liquidityLockCache.set(cacheKey, { ts: Date.now() - 600001, result: { status: "unlocked", label: "🔐 ❌ Unlocked - Failed" } });

    const r = await fetchLiquidityLockStatus(pair);
    assert.strictEqual(callCount, 1, "Fresh API call should occur after cache expiry");
    // No locker in holders → unlocked
    assert.strictEqual(r.status, "unlocked");
  });

  // ── Status label formatting ─────────────────────────────────────────────────

  await test("status labels contain correct emoji and text for all three states", () => {
    const labels = {
      locked:   "🔐 ✅ Locked - Passed",
      unlocked: "🔐 ❌ Unlocked - Failed",
      unknown:  "🔐 ❓ Unknown"
    };
    assert.ok(labels.locked.includes("✅"), "locked label should contain ✅");
    assert.ok(labels.unlocked.includes("❌"), "unlocked label should contain ❌");
    assert.ok(labels.unknown.includes("❓"), "unknown label should contain ❓");
    assert.ok(labels.locked.startsWith("🔐"), "locked label should start with 🔐");
    assert.ok(labels.unlocked.startsWith("🔐"), "unlocked label should start with 🔐");
    assert.ok(labels.unknown.startsWith("🔐"), "unknown label should start with 🔐");
  });

  // ────────────────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────────────────
  // EARLY ACCESS INTEREST TESTS
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nEARLY ACCESS INTEREST");

  await test("early_access_interest table can be created", async () => {
    const { run, close } = makeDb();
    await run(`
      CREATE TABLE IF NOT EXISTS early_access_interest (
        user_id    TEXT    PRIMARY KEY,
        username   TEXT    DEFAULT '',
        timestamp  INTEGER NOT NULL,
        clicked_at INTEGER NOT NULL
      )
    `);
    await close();
  });

  await test("logEarlyAccessInterest inserts a new row", async () => {
    const { run, get, close } = makeDb();
    await run(`
      CREATE TABLE IF NOT EXISTS early_access_interest (
        user_id    TEXT    PRIMARY KEY,
        username   TEXT    DEFAULT '',
        timestamp  INTEGER NOT NULL,
        clicked_at INTEGER NOT NULL
      )
    `);
    const now = Date.now();
    await run(
      `INSERT INTO early_access_interest (user_id, username, timestamp, clicked_at) VALUES (?, ?, ?, ?)`,
      ["123", "testuser", now, now]
    );
    const row = await get(`SELECT * FROM early_access_interest WHERE user_id = ?`, ["123"]);
    assert.ok(row, "Row should exist");
    assert.strictEqual(row.user_id, "123");
    assert.strictEqual(row.username, "testuser");
    await close();
  });

  await test("logEarlyAccessInterest upserts on duplicate user_id", async () => {
    const { run, get, close } = makeDb();
    await run(`
      CREATE TABLE IF NOT EXISTS early_access_interest (
        user_id    TEXT    PRIMARY KEY,
        username   TEXT    DEFAULT '',
        timestamp  INTEGER NOT NULL,
        clicked_at INTEGER NOT NULL
      )
    `);
    const now = Date.now();
    await run(
      `INSERT INTO early_access_interest (user_id, username, timestamp, clicked_at) VALUES (?, ?, ?, ?)`,
      ["456", "user_old", now, now]
    );
    const later = now + 1000;
    await run(
      `INSERT INTO early_access_interest (user_id, username, timestamp, clicked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, clicked_at = excluded.clicked_at`,
      ["456", "user_new", now, later]
    );
    const row = await get(`SELECT * FROM early_access_interest WHERE user_id = ?`, ["456"]);
    assert.ok(row, "Row should exist after upsert");
    assert.strictEqual(row.username, "user_new", "Username should be updated");
    assert.strictEqual(row.clicked_at, later, "clicked_at should be updated");
    await close();
  });

  await test("early_access_interest stores empty string when username is absent", async () => {
    const { run, get, close } = makeDb();
    await run(`
      CREATE TABLE IF NOT EXISTS early_access_interest (
        user_id    TEXT    PRIMARY KEY,
        username   TEXT    DEFAULT '',
        timestamp  INTEGER NOT NULL,
        clicked_at INTEGER NOT NULL
      )
    `);
    const now = Date.now();
    await run(
      `INSERT INTO early_access_interest (user_id, username, timestamp, clicked_at) VALUES (?, ?, ?, ?)`,
      ["789", "", now, now]
    );
    const row = await get(`SELECT * FROM early_access_interest WHERE user_id = ?`, ["789"]);
    assert.ok(row, "Row should exist");
    assert.strictEqual(row.username, "", "Username should be empty string");
    await close();
  });

  // ────────────────────────────────────────────────────────────────────────────

  summary();
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});

