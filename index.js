
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

    if (pending.type === "AI_ASSISTANT") {
      await handleAIAssistantQuery(chatId, input);
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
    const data = normalizeCallbackData(query.data || "");

    try {
      await answerCallbackSafe(query.id);

      if (!chatId) return;
      if (!isPrivateChat(query)) return;

      if (data === "chk") {
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

      if (data === "mm") {
        pendingAction.delete(chatId);
        await showMainMenu(chatId);
      } else if (data === "sc") {
        await promptScanToken(chatId);
      } else if (data === "lbv" || data === "rflb") {
        await showTrending(chatId);
      } else if (data === "lrv" || data === "rflr") {
        await showLaunchRadar(chatId);
      } else if (data === "afv" || data === "rfaf") {
        await showPrimePicks(chatId);
      } else if (data === "wlv" || data === "rfwl") {
        await showWatchlist(chatId);
      } else if (data === "mlv") {
        await showModeLab(chatId);
      } else if (data === "dcv" || data === "rfdc") {
        await showAlertCenter(chatId);
      } else if (data === "eev") {
        await showEdgeBrain(chatId);
      } else if (data === "aiv" || data === "rfai") {
        await showAIAssistantIntro(chatId);
      } else if (data === "wiv" || data === "rfwi") {
        await showWhaleMenu(chatId);
      } else if (data === "ihv") {
        await showHelpMenu(chatId);
      } else if (data === "help_status") {
        await showSystemStatus(chatId);
      } else if (data === "help_how") {
        await showHowToUse(chatId);
      } else if (data === "ihe") {
        await showHowGorktimusWorks(chatId);
      } else if (data === "ihd") {
        await showWhyDifferentFromDex(chatId);
      } else if (data === "iht") {
        await showTransactionsExplained(chatId);
      } else if (data === "ihs") {
        await showScoreExplained(chatId);
      } else if (data === "ihsrc") {
        await showDataSources(chatId);
      } else if (data === "ihc") {
        await showCommunity(chatId);
      } else if (data === "inv") {
        await showInviteFriends(chatId);
      } else if (data.startsWith("set_mode:") || data === "mla" || data === "mlb" || data === "mlc") {
        const mode = data === "mla" ? "aggressive" : data === "mlb" ? "balanced" : data === "mlc" ? "guardian" : safeMode(data.split(":")[1]);
        await setUserSetting(chatId, "mode", mode);
        await answerCallbackSafe(query.id, `Mode set to ${modeTitle(mode)}`);
        await showModeLab(chatId);
      } else if (data === "stv") {
        await showSettingsMenu(chatId);
      } else if (data.startsWith("ste:")) {
        const level = String(data.split(":")[1] || "deep");
        await setUserSetting(chatId, "explanation_level", level === "brief" ? "brief" : "deep");
        await showSettingsMenu(chatId);
      } else if (data.startsWith("lbo:") || data.startsWith("lro:") || data.startsWith("afo:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        if (pair) await openTokenPanel(chatId, pair, "🪙 Token Panel", data.startsWith("lbo:") ? "lbv" : data.startsWith("lro:") ? "lrv" : "afv");
      } else if (data.startsWith("sct:") || data.startsWith("rfs:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        if (pair) await openTokenPanel(chatId, pair, data.startsWith("rfs:") ? "🔁 Refreshed Token" : "🔎 Token Scan", "mm");
      } else if (data.startsWith("copy:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        const address = pair?.baseAddress || parts[2];
        await sendText(chatId, `📋 <b>Token Address</b>

<code>${escapeHtml(address)}</code>`, buildMainMenuOnlyButton());
      } else if (data.startsWith("wla:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        if (pair) {
          await addWatchlistItem(chatId, pair);
          await answerCallbackSafe(query.id, "Added to watchlist.");
          await openTokenPanel(chatId, pair, "👁 Added to Watchlist", "wlv");
        }
      } else if (data.startsWith("dft:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        if (pair) {
          const verdict = await buildRiskVerdict(pair, chatId);
          const lines = [
            `🛡 <b>Defense Read</b>`,
            ``,
            `Token: <b>${escapeHtml(safeSymbolText(pair.baseSymbol))}</b>`,
            `Chain: <b>${escapeHtml(humanChain(pair.chainId))}</b>`,
            `Verification: <b>${escapeHtml(verdict.confidence)}</b>`,
            `Honeypot: <b>${escapeHtml(verdict.honeypot)}</b>`,
            `Holders: <b>${escapeHtml(verdict.holders)}</b>`,
            `Liquidity: <b>${escapeHtml(verdict.liquidity)}</b>`,
            `Recommendation: <b>${escapeHtml(verdict.recommendation)}</b>`
          ].join("\n");
          await sendText(chatId, lines, buildUniversalTokenActionMenu(pair, "mm"));
        }
      } else if (data.startsWith("egt:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        if (pair) {
          const verdict = await buildRiskVerdict(pair, chatId);
          const lines = [
            `🧠 <b>Edge Breakdown</b>`,
            ``,
            `Token: <b>${escapeHtml(safeSymbolText(pair.baseSymbol))}</b>`,
            `Score: <b>${escapeHtml(String(verdict.score))}/100</b>`,
            `Confidence: <b>${escapeHtml(verdict.confidence)}</b>`,
            `Flow: <b>${escapeHtml(verdict.flowBehavior)}</b>`,
            `Adaptive Memory: <b>${escapeHtml(verdict.memoryNote || "Neutral")}</b>`,
            `Integrity: <b>${escapeHtml(verdict.integrity)}</b>`
          ].join("\n");
          await sendText(chatId, lines, buildUniversalTokenActionMenu(pair, "mm"));
        }
      } else if (data.startsWith("ait:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        if (pair) {
          setTokenContext(chatId, pair, "aiv");
          await showAIAssistantIntro(chatId, pair);
        }
      } else if (data.startsWith("toggle_setting:")) {
        const field = String(data.split(":")[1] || "");
        const settings = await getUserSettings(chatId);
        const current = num(settings[field]);
        await setUserSetting(chatId, field, current ? 0 : 1);
        await showAlertCenter(chatId);
      } else if (data.startsWith("trend_copy:")) {
        const parts = data.split(":");
        const chainId = expandCompactChainId(parts[1]);
        const tokenAddress = parts[2];
        const pair = await resolveExactPairOrToken(chainId, tokenAddress);
        const address = pair?.baseAddress || tokenAddress;
        await sendText(
          chatId,
          `📋 <b>${escapeHtml(pair?.baseSymbol || "Token")} Address</b>\n\n<code>${escapeHtml(address)}</code>`,
          buildMainMenuOnlyButton()
        );
      } else if (data.startsWith("trend_scan:")) {
        const parts = data.split(":");
        const chainId = expandCompactChainId(parts[1]);
        const tokenAddress = parts[2];
        const pair = await resolveExactPairOrToken(chainId, tokenAddress);
        if (pair) {
          const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
          await sendCard(chatId, await buildScanCard(pair, "📈 Trending Scan", chatId), buildScanActionButtons(pair), imageUrl);
        }
      } else if (data.startsWith("watch_add:")) {
        const parts = data.split(":");
        const chainId = expandCompactChainId(parts[1]);
        const tokenAddress = parts[2];
        const pair = await resolveExactPairOrToken(chainId, tokenAddress);
        if (pair) {
          await addWatchlistItem(chatId, pair);
          await answerCallbackSafe(query.id, "Added to watchlist.");
        }
      } else if (data.startsWith("watch_open:")) {
        const parts = data.split(":");
        await showWatchlistItem(chatId, expandCompactChainId(parts[1]), parts[2]);
      } else if (data.startsWith("watch_rescan:")) {
        const parts = data.split(":");
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[1]), parts[2]);
        if (pair) {
          const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
          await sendCard(chatId, await buildScanCard(pair, "🔁 Watchlist Re-Scan", chatId), buildWatchlistItemMenu(pair), imageUrl);
          const verdict = await buildRiskVerdict(pair, chatId);
          await savePairMemorySnapshot(pair, verdict.score);
        }
      } else if (data.startsWith("watch_remove:")) {
        const parts = data.split(":");
        await removeWatchlistItem(chatId, expandCompactChainId(parts[1]), parts[2]);
        await answerCallbackSafe(query.id, "Removed from watchlist.");
        await showWatchlist(chatId);
      } else if (data.startsWith("feedback:")) {
        const parts = data.split(":");
        const feedback = parts[1] === 'g' ? 'good' : 'bad';
        const pair = await resolveExactPairOrToken(expandCompactChainId(parts[2]), parts[3]);
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
        await trackScan(chatId);
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

  if (!watchlistScanInterval) {
    watchlistScanInterval = setInterval(() => {
      scanWatchlistAlerts().catch((err) => console.log("scanWatchlistAlerts loop error:", err.message));
    }, WATCHLIST_SCAN_INTERVAL_MS);
  }
})() } 
{;
        
        transparencyScore = proxy ? 11 : 15;
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

    sourceChecks = {
      available:
        1 +
        (honeypotData ? 1 : 0) +
        (topHoldersData ? 1 : 0) +
        (honeypotData?.contractCode || etherscanData ? 1 : 0),
      expected: 4
    };
  }

  let rawScore =
    liquidity.score +
    age.score +
    flow.score +
    volume.score +
    transparencyScore +
    honeypotScore +
    holderScore;

  rawScore -= behavior.penalty;

  if (mode === "aggressive") {
    rawScore += ageMin > 0 && ageMin < 120 ? 6 : 0;
    rawScore += num(pair.buysM5) > num(pair.sellsM5) ? 4 : 0;
    rawScore -= num(pair.liquidityUsd) < 15000 ? 2 : 0;
  } if (mode === "guardian") {
    rawScore -= num(pair.liquidityUsd) < 25000 ? 6 : 0;
    rawScore -= holderTop5Pct >= 70 ? 8 : 0;
    rawScore -= isHoneypot === true ? 12 : 0;
    rawScore -= ageMin > 0 && ageMin < 30 ? 4 : 0;
  }

  rawScore += clamp(num(memory.learned_bias), -12, 10);
  rawScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  const confidenceMeta = buildConfidenceMeta(sourceChecks, behavior.penalty);
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
    modeTitle: modeTitle(mode),
    confidence: confidenceMeta.confidence,
    integrity: confidenceMeta.integrity,
    sourceChecks: confidenceMeta.checksText,
    flowBehavior: behavior.flowLabel,
    spamSignal: behavior.spamLabel,
    coordinationSignal: behavior.coordinationLabel,
    behaviorDetail: behavior.detail
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
    `🧠 <b>Risk Verdict</b>`,
    `⚠️ <b>Honeypot Check:</b> ${escapeHtml(verdict.honeypot)}`,
    `🔍 <b>Contract Transparency:</b> ${escapeHtml(verdict.transparency)}`,
    `👥 <b>Holder Concentration:</b> ${escapeHtml(verdict.holders)}`,
    `💧 <b>Liquidity Health:</b> ${escapeHtml(verdict.liquidity)}`,
    ``,
    `🧬 <b>Flow + Confidence</b>`,
    `📊 <b>Safety Score:</b> ${escapeHtml(String(verdict.score))} / 100`,
    `🛡 <b>Confidence:</b> ${escapeHtml(verdict.confidence)}`,
    `🧾 <b>Data Integrity:</b> ${escapeHtml(verdict.integrity)}`,
    `🔗 <b>Cross-Source Checks:</b> ${escapeHtml(verdict.sourceChecks)}`,
    `🌊 <b>Flow Read:</b> ${escapeHtml(verdict.flowBehavior)}`,
    `🛰 <b>Tx Spam Signal:</b> ${escapeHtml(verdict.spamSignal)}`,
    `🎯 <b>Coordination Signal:</b> ${escapeHtml(verdict.coordinationSignal)}`,
    verdict.behaviorDetail ? `🧠 <b>Behavior Note:</b> ${escapeHtml(verdict.behaviorDetail)}` : "",
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
    `📡 <b>Launch Read</b>`,
    `${escapeHtml(buildLaunchVerdict(pair))}`,
    ``,
    `📊 <b>Safety Score:</b> ${escapeHtml(String(verdict.score))} / 100`,
    `🛡 <b>Confidence:</b> ${escapeHtml(verdict.confidence)}`,
    `🧾 <b>Data Integrity:</b> ${escapeHtml(verdict.integrity)}`,
    `🌊 <b>Flow Read:</b> ${escapeHtml(verdict.flowBehavior)}`,
    `🛰 <b>Tx Spam Signal:</b> ${escapeHtml(verdict.spamSignal)}`,
    `🎯 <b>Coordination Signal:</b> ${escapeHtml(verdict.coordinationSignal)}`,
    ``,
    `⚠️ <b>Honeypot Check:</b> ${escapeHtml(verdict.honeypot)}`,
    `🔍 <b>Contract Transparency:</b> ${escapeHtml(verdict.transparency)}`,
    `👥 <b>Holder Concentration:</b> ${escapeHtml(verdict.holders)}`,
    `💧 <b>Liquidity Health:</b> ${escapeHtml(verdict.liquidity)}`,
    ``,
    `📢 <b>Recommendation:</b> ${escapeHtml(verdict.recommendation)}`,
    ``,
    `💲 <b>Price:</b> ${escapeHtml(shortUsd(pair.priceUsd))}`,
    `💧 <b>Liquidity:</b> ${escapeHtml(shortUsd(pair.liquidityUsd))}`,
    `📈 <b>Volume 24h:</b> ${escapeHtml(shortUsd(pair.volumeH24))}`,
    clickableAddressLine(pair)
  ].filter(Boolean);

  return lines.join("\n");
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
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n💎 <b>Alpha Feed</b>\n\nNo candidates cleared the current liquidity and market filters right now.`,
      buildRefreshMainButtons("rfaf")
    );
    return;
  }

  for (let i = 0; i < picks.length; i++) {
    const pair = picks[i];
    const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);

    await sendCard(
      chatId,
      await buildScanCard(pair, `💎 Alpha Feed #${i + 1}`, chatId),
      i === picks.length - 1 ? buildRefreshMainButtons("rfaf") : {},
      imageUrl
    );

    if (i < picks.length - 1) await sleep(250);
  }
}

async function getNetworkPulse() {
  const now = nowTs();
  const startOfDay = now - 86400;
  const liveWindow = now - 900;

  const todayUsers = await get(`SELECT COUNT(DISTINCT user_id) as c FROM user_activity WHERE ts >= ?`, [startOfDay]);
  const liveUsers = await get(`SELECT COUNT(DISTINCT user_id) as c FROM user_activity WHERE ts >= ?`, [liveWindow]);
  const scansToday = await get(`SELECT COUNT(*) as c FROM scan_logs WHERE ts >= ?`, [startOfDay]);

  return `⚡ ${todayUsers?.c || 0} today • ${liveUsers?.c || 0} live • ${scansToday?.c || 0} scans`;
}

async function trackUserActivity(userId) {
  await run(`INSERT INTO user_activity (user_id, ts) VALUES (?, ?)`, [String(userId), nowTs()]);
}

async function trackScan(userId) {
  await run(`INSERT INTO scan_logs (user_id, ts) VALUES (?, ?)`, [String(userId), nowTs()]);
}

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
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n❓ <b>Intel Hub</b>\nEverything below pulls live data when requested.`,
    buildHelpMenu()
  );
}

async function showWhaleMenu(chatId) {
  await sendMenu(
    chatId,
    `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🐋 <b>Whale Intel</b>\nTrack named wallets and monitor movement on demand or by wallet alerts.`,
    buildWhaleMenu()
  );
}

async function resolveExactPairOrToken(chainId, tokenAddress) {
  try {
    const pair = await resolveTokenToBestPair(chainId, tokenAddress);
    if (pair) return pair;
  } catch (err) {
    console.log("resolveExactPairOrToken best-pair warning:", err.message);
  }

  try {
    const pairs = await fetchPairsByToken(chainId, tokenAddress);
    if (pairs.length) return pairs.sort((a, b) => rankPairQuality(b) - rankPairQuality(a))[0];
  } catch (err) {
    console.log("resolveExactPairOrToken token-route error:", err.message);
  }

  return null;
}

async function runTokenScan(chatId, query) {
  const pair = await resolveBestPair(query);
  if (!pair) {
    await sendText(
      chatId,
      `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 <b>Token Scan</b>\n\nNo solid token match was found for <b>${escapeHtml(query)}</b>.`,
      buildScanButtons()
    );
    return;
  }

  const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
  const verdict = await buildRiskVerdict(pair, chatId);
  await savePairMemorySnapshot(pair, verdict.score);
  setTokenContext(chatId, pair, "sc");
  await sendCard(chatId, await buildScanCard(pair, "🔎 Token Scan", chatId), buildUniversalTokenActionMenu(pair, "mm"), imageUrl);
}

function buildTrendingCompactLine(pair, rank = 0) {
  const prefix = rank > 0 ? `#${rank} ` : "";
  return [
    `📈 <b>${prefix}${escapeHtml(safeSymbolText(pair.baseSymbol))}</b> — ${escapeHtml(humanChain(pair.chainId))}`,
    `Price: ${escapeHtml(shortUsd(pair.priceUsd))} | Liq: ${escapeHtml(shortUsd(pair.liquidityUsd))} | Vol: ${escapeHtml(shortUsd(pair.volumeH24))}`,
    `Age: ${escapeHtml(ageFromMs(pair.pairCreatedAt))} | Buys: ${escapeHtml(String(pair.buysM5))} | Sells: ${escapeHtml(String(pair.sellsM5))}`
  ].join("\n");
}

function buildTrendingActionMenu(pair, isLast = false) {
  const c = compactChainId(pair.chainId);
  const rows = [
    [{ text: `🪙 ${clip(safeSymbolText(pair.baseSymbol), 18)}`, callback_data: `lbo:${c}:${pair.baseAddress}` }],
    [
      { text: "📋 Address", callback_data: `copy:${c}:${pair.baseAddress}` },
      { text: "🔎 Scan", callback_data: `sct:${c}:${pair.baseAddress}` }
    ],
    [
      { text: "👁 Watch", callback_data: `wla:${c}:${pair.baseAddress}` },
      { text: "🧠 AI", callback_data: `ait:${c}:${pair.baseAddress}` }
    ]
  ];
  if (isLast) rows.push([{ text: "🔁 Refresh Board", callback_data: "rflb" }, { text: "🏠 Main Menu", callback_data: "mm" }]);
  return { reply_markup: { inline_keyboard: rows } };
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
    await sendText(chatId, `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n📈 <b>TRENDING (GORKTIMUS LIVE BOARD)</b>\n\nNo trending candidates were found right now.`, buildRefreshMainButtons("rflb"));
    return;
  }

  await sendText(
    chatId,
    [`🧠 <b>Gorktimus Intelligence Terminal</b>`, ``, `📈 <b>TRENDING (GORKTIMUS LIVE BOARD)</b> | ${buildGeneratedStamp()}`, ``, `These are Gorktimus-ranked live candidates, not a raw Dex mirror.`, `Tap the token button to get the address, then scan, watch, or open Dex.`].join("\n"),
    buildMainMenuOnlyButton()
  );

  for (let i = 0; i < pairs.length; i++) {
    await sendText(chatId, buildTrendingCompactLine(pairs[i], i + 1), buildTrendingActionMenu(pairs[i], i === pairs.length - 1));
    if (i < pairs.length - 1) await sleep(150);
  }
}

async function buildLaunchCandidates(limit = 5) {
  const profiles = await fetchLatestProfiles();
  const boosts = await fetchLatestBoosts();
  const merged = new Map();

  for (const item of profiles) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;
    merged.set(`${item.chainId}:${item.tokenAddress}`, { chainId: String(item.chainId), tokenAddress: String(item.tokenAddress) });
  }

  for (const item of boosts) {
    if (!item?.chainId || !item?.tokenAddress) continue;
    if (!supportsChain(item.chainId)) continue;
    const key = `${item.chainId}:${item.tokenAddress}`;
    if (!merged.has(key)) merged.set(key, { chainId: String(item.chainId), tokenAddress: String(item.tokenAddress) });
  }

  const out = [];
  for (const item of [...merged.values()].slice(0, 50)) {
    const pair = await resolveTokenToBestPair(item.chainId, item.tokenAddress);
    if (!pair) continue;
    const ageMin = ageMinutesFromMs(pair.pairCreatedAt);
    if (pair.liquidityUsd < LAUNCH_MIN_LIQ_USD) continue;
    if (pair.volumeH24 < LAUNCH_MIN_VOL_USD) continue;
    if (ageMin > 1440) continue;
    if (pair.buysM5 + pair.sellsM5 < 2) continue;
    out.push(pair);
  }

  return out.sort((a, b) => pTrendScore(b) - pTrendScore(a)).slice(0, limit);
}

async function showLaunchRadar(chatId) {
  const launches = await buildLaunchCandidates(5);

  if (!launches.length) {
    await sendText(chatId, `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🚀 <b>Launch Radar</b>\n\nNo strong launch candidates were found right now.`, buildRefreshMainButtons("rflr"));
    return;
  }

  for (let i = 0; i < launches.length; i++) {
    const pair = launches[i];
    const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
    await sendCard(chatId, await buildLaunchCard(pair, i + 1, chatId), i === launches.length - 1 ? buildRefreshMainButtons("rflr") : {}, imageUrl);
    if (i < launches.length - 1) await sleep(250);
  }
}

async function showModeLab(chatId) {
  const settings = await getUserSettings(chatId);
  const lines = [
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
  await sendText(chatId, lines, buildModeMenu(settings.mode));
}

async function showAlertCenter(chatId) {
  const settings = await getUserSettings(chatId);
  const lines = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🛡 <b>Defense Center</b>`,
    ``,
    `Master alerts: <b>${num(settings.alerts_enabled) ? "ON" : "OFF"}</b>`,
    `Launch alerts: <b>${num(settings.launch_alerts) ? "ON" : "OFF"}</b>`,
    `Smart alerts: <b>${num(settings.smart_alerts) ? "ON" : "OFF"}</b>`,
    `Risk alerts: <b>${num(settings.risk_alerts) ? "ON" : "OFF"}</b>`,
    `Whale alerts: <b>${num(settings.whale_alerts) ? "ON" : "OFF"}</b>`
  ].join("\n");
  await sendText(chatId, lines, buildAlertCenterMenu(settings));
}

async function showWatchlist(chatId) {
  const rows = await getWatchlistItems(chatId);
  if (!rows.length) {
    await sendText(chatId, `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n👁 <b>Watchlist</b>\n\nNo tokens saved yet. Scan a token and tap <b>Add Watchlist</b>.`, buildMainMenuOnlyButton());
    return;
  }

  const lines = [`🧠 <b>Gorktimus Intelligence Terminal</b>`, ``, `👁 <b>Watchlist</b>`, ``, `Saved tokens: <b>${rows.length}</b>`, `Tap any token below to open it.`].join("\n");
  await sendText(chatId, lines, buildWatchlistMenu(rows));
}

async function showWatchlistItem(chatId, chainId, tokenAddress) {
  const pair = await resolveExactPairOrToken(chainId, tokenAddress);
  if (!pair) {
    await sendText(chatId, `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n👁 <b>Watchlist</b>\n\nThat token could not be refreshed right now.`, buildMainMenuOnlyButton());
    return;
  }

  const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
  const verdict = await buildRiskVerdict(pair, chatId);
  await savePairMemorySnapshot(pair, verdict.score);
  setTokenContext(chatId, pair, "wlv");
  await sendCard(chatId, await buildScanCard(pair, "👁 Watchlist Token", chatId), buildUniversalTokenActionMenu(pair, "wlv"), imageUrl);
}

async function showEdgeBrain(chatId) {
  const settings = await getUserSettings(chatId);
  const rows = await getWatchlistItems(chatId);
  const latestFeedback = await get(`SELECT COUNT(*) AS c FROM scan_feedback WHERE user_id = ? AND created_at >= ?`, [String(chatId), nowTs() - 86400 * 7]);

  const lines = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🧠 <b>Edge Engine</b>`,
    ``,
    `Mode: <b>${escapeHtml(modeTitle(settings.mode))}</b>`,
    `Adaptive memory: <b>ON</b>`,
    `7D user feedback events: <b>${latestFeedback?.c || 0}</b>`,
    `Saved watchlist tokens: <b>${rows.length}</b>`,
    ``,
    `This stack learns from repeated rescans, market drift, and your good / bad call feedback.`
  ].join("\n");

  await sendText(chatId, lines, buildMainMenuOnlyButton());
}

async function showInviteFriends(chatId) {
  const botLink = buildBotDeepLink();
  const lines = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `🚀 <b>Invite Friends</b>`,
    ``,
    botLink ? `Share this bot link:\n${escapeHtml(botLink)}` : `Bot username not detected yet.`
  ].join("\n");
  await sendText(chatId, lines, buildMainMenuOnlyButton());
}

async function promptScanToken(chatId) {
  pendingAction.set(chatId, { type: "SCAN_TOKEN" });
  await sendText(chatId, `🧠 <b>Gorktimus Intelligence Terminal</b>\n\n🔎 Send a token ticker, token address, or pair search.`, buildMainMenuOnlyButton());
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
    `Send a ticker, token address, or pair search. Gorktimus will resolve the strongest pair it can find, score risk, and explain what the market structure looks like.`,
    ``,
    `📈 <b>TRENDING (GORKTIMUS LIVE BOARD)</b>`,
    `This is not meant to copy Dex line-for-line. Trending is rebuilt from live candidate discovery and then filtered by liquidity, flow, and structural quality. Use it like familiar trending, but with Gorktimus filtering layered on top. Tap the token name to get the address, then use the quick buttons to scan, watch, or open Dex.`,
    ``,
    `🚀 <b>Launch Radar</b>`,
    `Shows fresher launches that still meet minimum live market conditions. This is for early discovery, not guaranteed safety.`,
    ``,
    `💎 <b>Alpha Feed</b>`,
    `Shows stronger candidates that cleared tighter liquidity, volume, age, and risk filters.`,
    ``,
    `👁 <b>Watchlist</b>`,
    `Save tokens, re-scan them quickly, and let the bot monitor for meaningful drift.`,
    ``,
    `🤖 <b>AI Terminal</b>`,
    `Turn on assistant mode if you want to ask natural questions about scans, safety score, holder concentration, why a token differs from Dex, or what a live setup may be signaling.`,
    ``,
    `🧬 <b>Mode Lab</b>`,
    `Aggressive = earlier entries and more tolerance for risk.
Balanced = strongest default.
Guardian = stricter defense and cleaner filtering.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function showDataSources(chatId) {
  const text = [
    `🧠 <b>Gorktimus Intelligence Terminal</b>`,
    ``,
    `⚙️ <b>Data Sources</b>`,
    ``,
    `Primary market discovery uses:`,
    `• DexScreener`,
    `• Birdeye links`,
    `• GeckoTerminal links`,
    ``,
    `Additional risk and contract layers use:`,
    `• Honeypot.is`,
    `• Etherscan V2`,
    `• Helius RPC for Solana holder concentration`,
    ``,
    `How to think about this:`,
    `Dex is usually the discovery layer.`,
    `Gorktimus is the intelligence layer.`,
    ``,
    `That means price, liquidity, and flow may begin from the live pair feed, but the terminal then adds contract, holder, behavior, memory, and mode-aware interpretation on top. That is why the output is designed to be smarter than a raw trending feed, not identical to one.`,
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

async function showHowGorktimusWorks(chatId) {
  const text = [
    `🧠 <b>How Gorktimus Works</b>`,
    ``,
    `Gorktimus is built as a live crypto intelligence terminal, not a simple market mirror.`,
    ``,
    `The stack does three different jobs:`,
    `• discovers active pairs`,
    `• scores structural risk and opportunity`,
    `• explains the result in plain language`,
    ``,
    `That means it is trying to answer a harder question than “what is moving?”`,
    `It is trying to answer “what is moving, how clean is it, and what could be hiding underneath that movement?”`,
    ``,
    `So when you scan a token, you are not just getting price and liquidity. You are also getting holder concentration context, contract transparency clues, behavior signals, memory bias from prior outcomes, and mode-aware score shaping.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function showWhyDifferentFromDex(chatId) {
  const text = [
    `🧠 <b>Why Gorktimus Does Not Always Match Dex</b>`,
    ``,
    `Dex is a raw activity feed.`,
    `Gorktimus is a filtered intelligence layer.`,
    ``,
    `Dex can surface tokens because they are simply loud:`,
    `• volume spikes`,
    `• transaction bursts`,
    `• paid boosts`,
    `• very early launches`,
    ``,
    `Gorktimus can deliberately rank those lower if the structure looks weak:`,
    `• thin liquidity`,
    `• suspicious holder concentration`,
    `• dangerous tax / honeypot signals`,
    `• poor contract transparency`,
    `• one-sided or spammy transaction patterns`,
    ``,
    `So if a token is high on Dex but lower here, that usually means the terminal thinks the raw noise is stronger than the underlying structure.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function showTransactionsExplained(chatId) {
  const text = [
    `🧠 <b>Transactions / Flow Explained</b>`,
    ``,
    `When Gorktimus shows buys, sells, and transactions, it is reading recent live pair activity from the market feed and then interpreting it.`,
    ``,
    `Important: transaction count does <b>not</b> automatically mean real strength.`,
    ``,
    `High transactions can still be weak if:`,
    `• average size is tiny`,
    `• liquidity is thin`,
    `• the buy pressure is too one-sided`,
    `• the move looks manufactured`,
    ``,
    `That is why Gorktimus treats transactions as one part of the puzzle, not the whole puzzle. Flow is read together with liquidity, volume, holder concentration, taxes, contract transparency, and memory bias.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}

async function showScoreExplained(chatId) {
  const text = [
    `🧠 <b>Safety Score + Confidence</b>`,
    ``,
    `The safety score is a live structured judgment, not a guarantee and not financial advice.`,
    ``,
    `The score weighs things like:`,
    `• liquidity health`,
    `• age / launch maturity`,
    `• recent buy-vs-sell flow`,
    `• volume quality`,
    `• holder concentration`,
    `• honeypot / tax clues`,
    `• contract transparency`,
    `• adaptive memory`,
    `• current mode`,
    ``,
    `Confidence tells you how complete the supporting evidence is.`,
    `Higher confidence usually means more source checks lined up cleanly. Lower confidence usually means the terminal had to work with partial or noisy data.`
  ].join("\n");

  await sendText(chatId, text, buildMainMenuOnlyButton());
}


async function showAIAssistantIntro(chatId, pair = null) {
  pendingAction.set(chatId, { type: "AI_ASSISTANT" });

  const text = [
    `🧠 <b>Gorktimus AI Assistant</b>`,
    ``,
    `Assistant mode is now <b>ON</b>.`,
    ``,
    `Ask natural questions like:`,
    `• why did this token score low`,
    `• what does holder concentration mean`,
    `• why does trending not match Dex`,
    `• explain transactions and flow`,
    `• which mode should I use`,
    `• scan BONK`,
    `• scan 0x...`,
    ``,
    `Type <b>exit</b> or tap <b>Exit Assistant</b> when you want to leave assistant mode.`
  ].join("\n");

  await sendText(chatId, text, buildAIAssistantMenu());
}

function buildAssistantGenericReply() {
  return [
    `🧠 <b>Gorktimus AI Assistant</b>`,
    ``,
    `I can explain how the terminal works, why a score is high or low, what transactions or holder concentration mean, why results can differ from Dex, or I can scan a ticker / address for you right now.`,
    ``,
    `Try something like:`,
    `• why did this score low`,
    `• explain safety score`,
    `• why not match Dex`,
    `• what do transactions mean`,
    `• aggressive vs guardian`,
    `• BONK`,
    `• 0x...`
  ].join("\n");
}

async function sendAssistantPairReply(chatId, pair) {
  const verdict = await buildRiskVerdict(pair, chatId);
  const lines = [
    `🧠 <b>Gorktimus AI Assistant</b>`,
    ``,
    `<b>${escapeHtml(pair.baseSymbol || "Unknown")}</b> on <b>${escapeHtml(humanChain(pair.chainId))}</b>`,
    ``,
    `Here is the plain-English read:`,
    `• Safety score: <b>${escapeHtml(String(verdict.score))}/100</b>`,
    `• Confidence: <b>${escapeHtml(verdict.confidence)}</b>`,
    `• Liquidity health: <b>${escapeHtml(verdict.liquidity)}</b>`,
    `• Holder structure: <b>${escapeHtml(verdict.holders)}</b>`,
    `• Contract / transparency: <b>${escapeHtml(verdict.transparency)}</b>`,
    `• Flow read: <b>${escapeHtml(verdict.flowBehavior)}</b>`,
    `• Tx spam signal: <b>${escapeHtml(verdict.spamSignal)}</b>`,
    `• Coordination signal: <b>${escapeHtml(verdict.coordinationSignal)}</b>`,
    ``,
    `Recommendation: ${escapeHtml(verdict.recommendation)}`,
    ``,
    `If you want the full card, tap <b>Scan Token</b> or just send another ticker/address while assistant mode is active.`
  ].join("\n");

  await sendText(chatId, lines, buildAIAssistantMenu());
}

async function handleAIAssistantQuery(chatId, text) {
  const cleaned = String(text || "").trim();
  const lower = cleaned.toLowerCase();

  if (!cleaned) return;

  if (/^(exit|quit|close|done|menu|main menu)$/i.test(cleaned)) {
    pendingAction.delete(chatId);
    await showMainMenu(chatId);
    return;
  }

  if (/^scan\s+(.+)/i.test(cleaned)) {
    const q = cleaned.replace(/^scan\s+/i, "").trim();
    const pair = await resolveBestPair(q);
    if (!pair) {
      await sendText(chatId, `🧠 <b>Gorktimus AI Assistant</b>\n\nI could not resolve a strong live token match for <b>${escapeHtml(q)}</b>. Try a ticker, token address, or pair address.`, buildAIAssistantMenu());
      return;
    }
    const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
    await sendCard(chatId, await buildScanCard(pair, "🤖 AI Terminal Scan", chatId), buildScanActionButtons(pair), imageUrl);
    await sendAssistantPairReply(chatId, pair);
    return;
  }

  if (
    isAddressLike(cleaned) ||
    (/^[A-Za-z0-9_.$-]{2,24}$/.test(cleaned) &&
      !cleaned.startsWith("/") &&
      !/(what|why|how|when|where|should|does|is|are|can|explain|tell|compare|entry|liquidity|volume|risk|reward|slippage|scalp|swing|hold)/i.test(cleaned))
  ) {
    const pair = await resolveBestPair(cleaned);
    if (!pair) {
      await sendText(chatId, `🧠 <b>Gorktimus AI Assistant</b>\n\nI could not resolve a strong live token match for <b>${escapeHtml(cleaned)}</b>. Try a ticker, token address, or pair address.`, buildAIAssistantMenu());
      return;
    }

    const imageUrl = await fetchTokenProfileImage(pair.chainId, pair.baseAddress, pair);
    await sendCard(chatId, await buildScanCard(pair, "🤖 AI Terminal Scan", chatId), buildScanActionButtons(pair), imageUrl);
    await sendAssistantPairReply(chatId, pair);
    return;
  }

  if (/compare\s+(.+?)\s+(?:vs|and)\s+(.+)/i.test(cleaned)) {
    const m = cleaned.match(/compare\s+(.+?)\s+(?:vs|and)\s+(.+)/i);
    const leftQ = m?.[1]?.trim() || "";
    const rightQ = m?.[2]?.trim() || "";
    const [left, right] = await Promise.all([resolveBestPair(leftQ), resolveBestPair(rightQ)]);
    if (!left || !right) {
      await sendText(chatId, `🧠 <b>Gorktimus AI Assistant</b>\n\nI could not resolve both sides of that comparison. Try: <b>compare BONK vs WIF</b>`, buildAIAssistantMenu());
      return;
    }
    const [lv, rv] = await Promise.all([buildRiskVerdict(left, chatId), buildRiskVerdict(right, chatId)]);
    const winner = lv.score === rv.score ? "Tie / context dependent" : lv.score > rv.score ? safeSymbolText(left.baseSymbol) : safeSymbolText(right.baseSymbol);
    const lines = [
      `🧠 <b>Gorktimus AI Assistant</b>`,
      ``,
      `<b>Comparison</b>`,
      `• ${escapeHtml(safeSymbolText(left.baseSymbol))}: score <b>${lv.score}</b>, confidence <b>${escapeHtml(lv.confidence)}</b>, liquidity <b>${escapeHtml(lv.liquidity)}</b>`,
      `• ${escapeHtml(safeSymbolText(right.baseSymbol))}: score <b>${rv.score}</b>, confidence <b>${escapeHtml(rv.confidence)}</b>, liquidity <b>${escapeHtml(rv.liquidity)}</b>`,
      ``,
      `Current cleaner setup: <b>${escapeHtml(winner)}</b>`,
      `This is a structure read from the live data stack, not a guaranteed outcome.`
    ].join("\n");
    await sendText(chatId, lines, buildAIAssistantMenu());
    return;
  }

  const tradingReply = tradingConceptReply(lower);
  if (tradingReply) {
    await sendText(chatId, tradingReply, buildAIAssistantMenu());
    return;
  }

  if (/(how.*work|what is gorktimus|what does gorktimus do|how does this work|what is this system)/i.test(lower)) {
    await showHowGorktimusWorks(chatId);
    return;
  }

  if (/(dex|match dex|different from dex|why.*dex|raw feed|trending source)/i.test(lower)) {
    await showWhyDifferentFromDex(chatId);
    return;
  }

  if (/(transaction|tx|buys|sells|flow|volume|spam)/i.test(lower)) {
    await showTransactionsExplained(chatId);
    return;
  }

  if (/(score|confidence|integrity|safe|safety|holder concentration|honeypot|tax|transparency)/i.test(lower)) {
    await showScoreExplained(chatId);
    return;
  }

  if (/(mode|aggressive|balanced|guardian)/i.test(lower)) {
    await sendText(
      chatId,
      [
        `🧠 <b>Gorktimus AI Assistant</b>`,
        ``,
        `Mode guide:`,
        `• <b>Aggressive</b> = earlier entries, more tolerance for fresh or hotter setups`,
        `• <b>Balanced</b> = strongest default for most users`,
        `• <b>Guardian</b> = stricter defense, better if you want cleaner structure and less tolerance for weak liquidity or concentration risk`
      ].join("\n"),
      buildAIAssistantMenu()
    );
    return;
  }

  if (/(what should i buy|best trade|what should i trade|good trade|should i ape)/i.test(lower)) {
    await sendText(
      chatId,
      [
        `🧠 <b>Gorktimus AI Assistant</b>`,
        ``,
        `I do not pick blind trades out of thin air. Send me a ticker, address, or use <b>compare A vs B</b> and I will break down the live structure, risk, confidence, and what the setup appears to be doing.`
      ].join("\n"),
      buildAIAssistantMenu()
    );
    return;
  }

  await sendText(chatId, buildAssistantGenericReply(), buildAIAssistantMenu());
}

}

function buildWatchlistMenu(rows) {
  const buttons = rows.slice(0, MAX_WATCHLIST_ITEMS).map((row) => [{
    text: `👁 ${clip(row.symbol || shortAddr(row.token_address, 6), 28)}`,
    callback_data: buildWatchlistItemCallback(row.chain_id, row.token_address)
  }]);
  buttons.push([{ text: "🏠 Main Menu", callback_data: "mm" }]);
  return { reply_markup: { inline_keyboard: buttons } };
}

function buildWatchlistItemMenu(pair) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔁 Re-Scan", callback_data: `watch_rescan:${compactChainId(pair.chainId)}:${pair.baseAddress}` }],
        [{ text: "❌ Remove", callback_data: `watch_remove:${compactChainId(pair.chainId)}:${pair.baseAddress}` }],
        [
          { text: "👍 Good Call", callback_data: `feedback:g:${compactChainId(pair.chainId)}:${pair.baseAddress}` },
          { text: "👎 Bad Call", callback_data: `feedback:b:${compactChainId(pair.chainId)}:${pair.baseAddress}` }
        ],
        [{ text: "👁 Watchlist", callback_data: "wlv" }],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
}

function buildScanActionButtons(pair) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "👁 Add Watchlist", callback_data: `watch_add:${compactChainId(pair.chainId)}:${pair.baseAddress}` },
          { text: "🔎 Scan Another", callback_data: "sc" }
        ],
        [
          { text: "👍 Good Call", callback_data: `feedback:g:${compactChainId(pair.chainId)}:${pair.baseAddress}` },
          { text: "👎 Bad Call", callback_data: `feedback:b:${compactChainId(pair.chainId)}:${pair.baseAddress}` }
        ],
        [{ text: "🤖 Ask AI Assistant", callback_data: "aiv" }],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
}

function buildMainMenuOnlyButton() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "mm" }]]
    }
  };
}


function buildScanButtons() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔎 Scan Another", callback_data: "sc" }],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
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

  buttons.push([{ text: "🏠 Main Menu", callback_data: "mm" }]);

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
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
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

  if (safeText.length > 900) {
    await sendText(chatId, safeText, keyboard);
    return;
  }

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

  const cacheKey = String(mintAddress).trim();
  const cached = heliusLargestAccountsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HELIUS_CACHE_TTL_MS) {
    return cached.rows;
  }

  if (Date.now() < heliusCooldownUntil) {
    return cached?.rows || [];
  }

  try {
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_API_KEY)}`;
    const data = await retryOperation(
      "fetchHeliusTokenLargestAccounts",
      async () => {
        const out = await rpcPost(rpcUrl, {
          jsonrpc: "2.0",
          id: "gork-largest-accounts",
          method: "getTokenLargestAccounts",
          params: [mintAddress]
        });

        if (!Array.isArray(out?.result?.value)) {
          throw new Error("Largest accounts payload missing");
        }

        return out;
      },
      {
        attempts: 3,
        baseDelay: 1200,
        maxDelay: 8000,
        backoff: 2,
        shouldRetry: (err) => {
          const status = err?.response?.status;
          return [408, 425, 429, 500, 502, 503, 504].includes(status) ||
            err?.code === "ECONNABORTED" ||
            err?.code === "ETIMEDOUT" ||
            err?.code === "ECONNRESET";
        },
        onRetry: (err, attempt, delay) => {
          console.log(
            `fetchHeliusTokenLargestAccounts retry ${attempt} in ${delay}ms:`,
            err?.response?.status || err.message
          );
        }
      }
    );

    heliusCooldownUntil = 0;
    const rows = Array.isArray(data?.result?.value) ? data.result.value : [];
    const mapped = rows.map((x) => ({
      address: String(x.address || ""),
      amountRaw: String(x.amount || "0"),
      uiAmount: num(x.uiAmountString ?? x.uiAmount ?? 0),
      decimals: num(x.decimals, 0)
    }));
    heliusLargestAccountsCache.set(cacheKey, { ts: Date.now(), rows: mapped });
    return mapped;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) {
      heliusCooldownUntil = Date.now() + HELIUS_COOLDOWN_MS;
    }
    console.log("fetchHeliusTokenLargestAccounts error:", err?.response?.status || err.message);
    return cached?.rows || [];
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
}

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
    },
    async () => {
      const res = await axios.get(`${HONEYPOT_API_BASE}/IsHoneypot`, {
        timeout: DEX_TIMEOUT_MS,
        params: { address, chainID: mappedChainId }
      });
      return res.data || null;
    }
  ];

  let lastErr = null;

  for (let i = 0; i < strategies.length; i++) {
    try {
      return await retryOperation(
        `fetchEvmHoneypot:${i + 1}`,
        async () => {
          const result = await strategies[i]();
          if (!result) throw new Error("Empty honeypot payload");
          return result;
        },
        {
          attempts: 3,
          baseDelay: 850,
          maxDelay: 5000,
          backoff: 1.7,
          shouldRetry: (err) => {
            const status = err?.response?.status;
            return [408, 425, 429, 500, 502, 503, 504].includes(status) ||
              err?.code === "ECONNABORTED" ||
              err?.code === "ETIMEDOUT" ||
              err?.code === "ECONNRESET";
          },
          onRetry: (err, attempt, delay) => {
            console.log(
              `fetchEvmHoneypot strategy ${i + 1} retry ${attempt} in ${delay}ms:`,
              err?.response?.status || err.message
            );
          }
        }
      );
    } catch (err) {
      lastErr = err;
      console.log(
        `fetchEvmHoneypot strategy ${i + 1} failed:`,
        err?.response?.status || err.message
      );
    }
  }

  if (lastErr) {
    console.log("fetchEvmHoneypot final failure:", lastErr?.response?.status || lastErr.message);
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
        const url = `${HONEYPOT_API_BASE}/v1/TopHolders`;
        const res = await axios.get(url, {
          timeout: DEX_TIMEOUT_MS,
          params: {
            address,
            chainID: mappedChainId
          }
        });

        return res.data || null;
      },
      {
        attempts: 5,
        baseDelay: 900,
        maxDelay: 7000,
        backoff: 1.8,
        shouldRetry: (err) => {
          const status = err?.response?.status;
          return [408, 425, 429, 500, 502, 503, 504].includes(status) ||
            err?.code === "ECONNABORTED" ||
            err?.code === "ETIMEDOUT" ||
            err?.code === "ECONNRESET";
        },
        onRetry: (err, attempt, delay) => {
          console.log(
            `fetchEvmTopHolders retry ${attempt} in ${delay}ms:`,
            err?.response?.status || err.message
          );
        }
      }
    );
  } catch (err) {
    console.log("fetchEvmTopHolders error:", err?.response?.status || err.message);
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
}


function analyzeExecutionBehavior(pair) {
  const buys = num(pair?.buysM5);
  const sells = num(pair?.sellsM5);
  const txns = num(pair?.txnsM5);
  const liquidity = num(pair?.liquidityUsd);
  const volume = num(pair?.volumeH24);
  const avgUsdPerRecentTxn = txns > 0 ? volume / Math.max(txns, 1) : volume;

  let spamLabel = "No strong spam signature";
  let coordinationLabel = "No obvious coordinated buy pattern";
  let flowLabel = "Mixed recent flow";
  let penalty = 0;
  const notes = [];

  if (buys > sells * 1.8 && txns >= 8) {
    flowLabel = "Positive momentum pressure";
  } else if (sells > buys * 1.4 && txns >= 8) {
    flowLabel = "Distribution pressure";
  }

  if (txns >= 25 && liquidity < 25000 && avgUsdPerRecentTxn < 1500) {
    spamLabel = "Possible transaction spam";
    penalty += 4;
    notes.push("Recent transaction count looks loud relative to thin liquidity and average size.");
  }

  if (buys >= 18 && sells <= 1 && liquidity < 25000) {
    coordinationLabel = "Possible coordinated buy burst";
    penalty += 5;
    notes.push("Buy flow is extremely one-sided and can be manufactured in thin books.");
  } else if (buys >= 12 && sells === 0 && liquidity < 15000) {
    coordinationLabel = "Elevated coordinated-flow risk";
    penalty += 3;
    notes.push("Near one-way buys in thin liquidity deserve caution.");
  }

  if (!notes.length) {
    notes.push("No dominant flow-manipulation signature from the current lightweight behavior checks.");
  }

  return {
    spamLabel,
    coordinationLabel,
    flowLabel,
    penalty,
    detail: notes.join(" ")
  };
}

function buildConfidenceMeta(sourceChecks, behaviorPenalty = 0) {
  const available = num(sourceChecks?.available);
  const expected = Math.max(1, num(sourceChecks?.expected, 1));
  const ratio = available / expected;

  let confidence = "Medium";
  let integrity = "Partial";

  if (ratio >= 0.9 && behaviorPenalty <= 2) {
    confidence = "High";
    integrity = "Verified";
  } else if (ratio >= 0.6) {
    confidence = "Medium";
    integrity = behaviorPenalty >= 5 ? "Mixed" : "Partial";
  } else {
    confidence = "Low";
    integrity = "Weak";
  }

  return {
    confidence,
    integrity,
    checksText: `${available}/${expected} source checks`
  };
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
  const behavior = analyzeExecutionBehavior(pair);

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
  let sourceChecks = { available: 1, expected: 3 };

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
    honeypotDetail = "Solana honeypot simulation is limited in this stack, so safety is inferred more from structure than direct trap simulation.";

    sourceChecks = {
      available: 1 + (largestAccounts.length ? 1 : 0) + 1,
      expected: 3
    };
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
const currentTokenContext = new Map();
let bot = null;
let walletScanInterval = null;
let watchlistScanInterval = null;
let walletScanRunning = false;
let shuttingDown = false;
let BOT_USERNAME = "";
let heliusCooldownUntil = 0;
const HELIUS_COOLDOWN_MS = 60000;
const HELIUS_CACHE_TTL_MS = 180000;
const heliusLargestAccountsCache = new Map();

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

async function retryOperation(label, fn, options = {}) {
  const {
    attempts = 5,
    baseDelay = 700,
    maxDelay = 9000,
    backoff = 1.8,
    jitter = 200,
    shouldRetry = () => true,
    onRetry = null
  } = options;

  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = shouldRetry(err, attempt);
      if (!retryable || attempt === attempts) break;

      const delay = Math.min(
        maxDelay,
        Math.floor(baseDelay * Math.pow(backoff, attempt - 1))
      ) + Math.floor(Math.random() * jitter);

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

function compactChainId(chainId) {
  const c = String(chainId || "").toLowerCase();
  if (c === "solana") return "s";
  if (c === "base") return "b";
  if (c === "ethereum") return "e";
  return c.slice(0, 1) || "x";
}

function expandCompactChainId(value) {
  const c = String(value || "").toLowerCase();
  if (c === "s") return "solana";
  if (c === "b") return "base";
  if (c === "e") return "ethereum";
  return c;
}

function safeSymbolText(symbol, fallback = "Token") {
  const s = String(symbol || "").trim();
  return s ? s : fallback;
}

function tradingConceptReply(lower) {
  if (/(entry|enter|buy in|good entry|bad entry|chasing)/i.test(lower)) {
    return [
      `🧠 <b>Trading Read</b>`,
      ``,
      `A cleaner entry usually has three things working together:`,
      `• liquidity that can absorb exits`,
      `• flow that is not obviously manufactured`,
      `• a setup you are not blindly chasing after a vertical move`,
      ``,
      `If price already exploded while liquidity is still thin, that is usually a worse entry than a calmer structure with real support underneath it.`
    ].join("\n");
  }
  if (/(liquidity|market cap|mcap|fdv)/i.test(lower)) {
    return [
      `🧠 <b>Liquidity vs Market Cap</b>`,
      ``,
      `Market cap tells you how large the token is priced.`,
      `Liquidity tells you how much real depth exists to enter or exit.`,
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
  if (/(scalp|swing|hold|timeframe|time frame)/i.test(lower)) {
    return [
      `🧠 <b>Timeframe Read</b>`,
      ``,
      `Scalp logic cares more about current flow, spread, and immediate liquidity response.`,
      `Swing logic cares more about structure, holder concentration, and whether the move looks sustainable after the first burst.`,
      ``,
      `The same token can be tradable for a scalp and still be weak for a longer hold.`
    ].join("\n");
  }
  if (/(stop loss|risk reward|rr|position size|sizing|slippage)/i.test(lower)) {
    return [
      `🧠 <b>Risk Management</b>`,
      ``,
      `The cleaner the structure, the more room you have to think in terms of setups.`,
      `The weaker the liquidity and holder structure, the smaller the position should usually be.`,
      ``,
      `Early tokens are not where blind size belongs. They are where disciplined size matters most.`
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
  return "";
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

function setTokenContext(chatId, pair, source = "token") {
  if (!chatId || !pair) return;
  currentTokenContext.set(String(chatId), {
    chainId: String(pair.chainId || ""),
    tokenAddress: String(pair.baseAddress || ""),
    pairAddress: String(pair.pairAddress || ""),
    symbol: String(pair.baseSymbol || ""),
    source,
    ts: nowTs()
  });
}

function getTokenContext(chatId) {
  return currentTokenContext.get(String(chatId)) || null;
}

function normalizeCallbackData(data) {
  const aliases = {
    main_menu: "mm",
    scan_token: "sc",
    trending: "lbv",
    launch_radar: "lrv",
    prime_picks: "afv",
    watchlist: "wlv",
    mode_lab: "mlv",
    alert_center: "dcv",
    whale_menu: "wiv",
    edge_brain: "eev",
    ai_assistant: "aiv",
    help_menu: "ihv",
    invite_friends: "inv",
    check_subscription: "chk",
    help_engine: "ihe",
    help_dex_diff: "ihd",
    help_transactions: "iht",
    help_score: "ihs",
    help_sources: "ihsrc",
    help_community: "ihc"
  };
  return aliases[data] || data;
}

function buildBackButton(callback = "mm", label = "⬅️ Back") {
  return { text: label, callback_data: callback };
}

function buildRefreshMainButtons(refreshCallback) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔁 Refresh", callback_data: refreshCallback }],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
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
  return `watch_open:${compactChainId(chainId)}:${String(tokenAddress)}`;
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
    ? [{ text: "🚀 Invite Network", callback_data: "inv" }]
    : [];

  const keyboard = [
    [
      { text: "🔎 Scan Token", callback_data: "sc" },
      { text: "📈 Trending", callback_data: "lbv" }
    ],
    [
      { text: "📡 Launch Radar", callback_data: "lrv" },
      { text: "💎 Alpha Feed", callback_data: "afv" }
    ],
    [
      { text: "👁 Watchlist", callback_data: "wlv" },
      { text: "🧬 Mode Lab", callback_data: "mlv" }
    ],
    [
      { text: "🛡 Defense Center", callback_data: "dcv" },
      { text: "🐋 Whale Intel", callback_data: "wiv" }
    ],
    [
      { text: "🧠 Edge Engine", callback_data: "eev" },
      { text: "🤖 AI Terminal", callback_data: "aiv" }
    ],
    [[{ text: "❓ Intel Hub", callback_data: "ihv" }, { text: "⚙️ Settings", callback_data: "stv" }]]
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
        [{ text: "📖 How Gorktimus Works", callback_data: "ihe" }],
        [{ text: "📊 Why It Differs From Dex", callback_data: "ihd" }],
        [{ text: "🛡 Safety Score + Confidence", callback_data: "ihs" }],
        [{ text: "🔄 Transactions / Flow Explained", callback_data: "iht" }],
        [{ text: "⚙️ Data Sources", callback_data: "ihsrc" }],
        [{ text: "💬 Contact / Community", callback_data: "ihc" }],
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
}

function buildAIAssistantMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📖 How It Works", callback_data: "ihe" },
          { text: "📊 Why Not Dex", callback_data: "ihd" }
        ],
        [
          { text: "🔄 Transactions", callback_data: "iht" },
          { text: "🛡 Safety Score", callback_data: "ihs" }
        ],
        [
          { text: "🔎 Scan Token", callback_data: "sc" },
          { text: "🏠 Exit Assistant", callback_data: "mm" }
        ]
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
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
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
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
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
        [{ text: "🏠 Main Menu", callback_data: "mm" }]
      ]
    }
  };
