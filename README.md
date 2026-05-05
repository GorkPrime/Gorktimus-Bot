# Gorktimus Intelligence Terminal

AI-powered crypto intelligence terminal built on Telegram. Multi-signal token scanner, risk scoring engine, and on-chain defense system for Solana, Base, and Ethereum.

---

## What It Is

Gorktimus is a live intelligence terminal, not a market mirror. It answers a harder question than "what is moving?" — it answers:

> "What is moving, how structurally clean is it, and what danger is hiding underneath?"

When you scan a token you get a full structural read: price, liquidity, volume, flow, holder concentration, contract transparency, liquidity lock status, **freeze authority status**, honeypot simulation, dev wallet reputation, and a composite Safety Score — all synthesized into a clear verdict and actionable recommendation.

---

## Features

### Token Scanner
- Scan any Solana, Base, or Ethereum token by contract address or ticker
- Full Safety Score (1–99) computed across seven weighted signal categories
- Plain-language recommendation: HOLD / WATCH / AVOID

### Safety Score Engine
Seven weighted signal categories feed into every scan:

| Signal | What It Checks |
|--------|---------------|
| **Liquidity Depth** | Raw USD liquidity available for exit |
| **LP Lock Status** | Whether LP tokens are held by a known locker program |
| **Freeze Authority** | Whether the dev can freeze any holder's token account — blocks selling |
| **Token Age** | Structural uncertainty from very new launches |
| **Flow Quality** | Buy/sell ratio and organic vs. manufactured transaction patterns |
| **Volume Health** | 24H volume vs. liquidity — inflated ratios signal wash trading |
| **Contract Transparency** | Source code verification and honeypot simulation |
| **Holder Concentration** | Supply distribution across top wallets |

Score modifiers:
- LP locked → **+4 pts**
- LP unlocked → **-3 pts**
- Freeze authority active → **-8 pts** (critical rug signal)
- Freeze authority revoked → **+3 pts** (positive safety signal)
- Mode (Aggressive / Balanced / Guardian) → **±3 pts**
- Dev wallet flagged → **-3 to -12 pts**

### Freeze Authority Check (NEW)
- **Solana**: Reads the SPL Token mint account via Helius RPC and parses the `freeze_authority_option` field at byte offset 46. Active freeze authority = dev can freeze any holder's wallet, permanently blocking sells.
- **EVM**: Scans honeypot.is flags array for `BLACKLIST`/`FREEZE` markers and performs regex analysis of verified source code for freeze and blacklist function patterns.

### LP Lock Detection
- **Solana**: Queries `getTokenLargestAccounts` then `getMultipleAccounts` on top holders to inspect SPL token account `owner` and `delegate` fields against a list of known locker programs (Raydium LP Locker, Team Finance, Streamflow, Magna, Fluxbeam).
- **EVM**: Checks LP token top holders via Etherscan v2 API against known locker contracts (Unicrypt v2 & v3, Team Finance, PinkLock v1 & v2, Mudra).

### Alerts
- **Launch Radar** — New token launches meeting liquidity/volume thresholds
- **Movers Alert** — Tokens gaining 30%+ (1h) or 15%+ (5m) with buy pressure
- **Watchlist Alerts** — Price move ≥5%, liquidity drain ≥30%, or combined rug pull signal (drain + extreme sell pressure)

### Watchlist
- Add up to 30 tokens per user
- Continuous background monitoring every 90 seconds
- Rug pull composite signal: liquidity drain + extreme sell pressure fires simultaneously

### Launch Radar
- Surfaces new launches meeting live entry thresholds
- Direct scan buttons from alert messages

### Prime Picks
- Curated tokens ranked by safety score above minimum liquidity and volume thresholds

### Mode Lab
- **Aggressive** — +3 to score, higher risk tolerance
- **Balanced** — neutral baseline (default)
- **Guardian** — -3 to score, stricter filter

### Alert Center
- Toggle: Launch Alerts, Movers Alerts, Watchlist Alerts, Smart Alerts

### AI Assistant
- GPT-4 Turbo powered intelligence layer
- Knows the terminal's scan history and all signal categories
- Understands freeze authority, LP lock, honeypot, holder concentration, and rug pull patterns
- Adapts depth to question complexity

### Edge Brain
- Explains the full scoring methodology
- Context on what each signal means and why it matters

---

## Data Sources

| Source | Used For |
|--------|----------|
| **DexScreener** | Price, liquidity, volume, flow, pair discovery — Solana, Base, Ethereum |
| **Helius RPC** | Solana holder reads, LP account ownership, mint freeze authority parsing |
| **Honeypot.is** | EVM buy/sell simulation, tax detection, freeze/blacklist flag scanning |
| **Etherscan v2 API** | Contract source verification, top holder lists, LP locker detection, freeze pattern analysis |
| **Pair Memory DB** | Learned bias from prior scan outcomes on same token |
| **Flagged Wallet DB** | Dev wallet reputation checks against known bad actors |

---

## Supported Chains
- **Solana**
- **Base**
- **Ethereum**

---

## Background Monitors

| Monitor | Interval | Trigger |
|---------|----------|---------|
| Launch Radar | 60s | New token meets liq + vol thresholds |
| Watchlist | 90s | Price ±5%, liq drain ≥30%, rug signal |
| Movers Alert | 120s | ≥30% 1h or ≥15% 5m gain with buy pressure |

---

## Scoring Confidence

Confidence reflects how many expected data sources returned usable results:

- **High** — All sources returned data
- **Medium** — Most sources returned data
- **Low** — Limited data; token may be too new or not fully indexed

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot authentication |
| `HELIUS_API_KEY` | ✅ | Solana RPC (holder reads, freeze authority) |
| `ETHERSCAN_API_KEY` | ✅ | EVM contract data, LP lock, freeze patterns |
| `OPENAI_API_KEY` | ✅ | AI Assistant (GPT-4 Turbo) |
| `OWNER_USER_ID` | Optional | Owner Telegram user ID |
| `DEV_MODE` | Optional | Restrict alerts to owner only |
| `REQUIRED_CHANNEL` | Optional | Force subscription gate |
| `COMMUNITY_X_URL` | Optional | Custom X/Twitter link |
| `COMMUNITY_TELEGRAM_URL` | Optional | Custom Telegram community link |

---

## Running Tests

```bash
npm test
```

Uses Node's built-in `assert` module and in-memory SQLite. No external services required. 93 tests covering: safety scoring, freeze authority detection (Solana SPL mint parsing + EVM source analysis), LP lock status (Solana + EVM), score modifiers, watchlist, instance lock, movers alert, and more.

---

## Architecture

```
index.js              — Main bot, all features, scoring engine, background monitors
health-monitor.js     — System scan, error logging, health metrics
test.js               — Full test suite (node test.js)
gorktimus.db          — SQLite database (auto-created on boot)
assets/               — Static images
```

---

## Philosophy

Data before impulse. Intelligence before execution.

Gorktimus surfaces what raw DEX feeds hide: thin liquidity dressed as volume, buy walls manufactured to trap retail, freeze authorities left active by dev wallets, LP removed the moment enough buyers are in. The terminal is built to catch these patterns before they catch you.

