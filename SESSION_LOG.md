# Session log — XeniosTrade

Running worklog so a new session can pick up where the last one stopped.
**Read the "WHERE WE LEFT OFF" block first, then the top session entry.**
Companion files: `GO_LIVE_READINESS.md` (readiness decision record),
`server/backtest/README.md` (backtest harness).

Convention: newest session on top. Update "WHERE WE LEFT OFF" at the end of
every session. Times are UTC. Server logs are UTC+8 (Asia/Manila).

---

## WHERE WE LEFT OFF  — as of 2026-08-31 17:30 UTC

### −1 USD hard money-stop backtest (Bots 1–3) — done, still net-negative

Ran `replay-dataset.js --months 12 --stride 2 --bots model-1,model-2,model-3
--money-stop-usd 1` (65 symbols, `--no-train`). Result vs the 12-month baseline:

| Bot | Win% base→stop | Avg/trade base→stop | Total (stop run) |
|-----|----------------|---------------------|------------------|
| 1 | 32.7 → **9.8%** | −0.76 → **−0.68** (−10%) | −$21,335 / 31,329 trades |
| 2 | 32.3 → **6.4%** | −1.39 → **−1.12** (−20%) | −$22,648 / 20,308 trades |
| 3 | 32.9 → **3.0%** | −6.25 → **−4.59** (−27%) | −$149,057 / 32,500 trades |

The −1 USD stop = a 0.07–0.13% move for these notionals — inside 5-minute noise,
so it's tapped before winners develop. Cuts per-trade loss a bit, craters win
rate, still deeply negative on all three. **NOT merged into training** (no live
counterpart — Bot 4 only; would skew the shared policy bucket). Data kept at
`server/data/backtest-moneystop.json`.

### Pocket-mining + "give it room" backtest — no edge found

Mined all 117k baseline rows for a positive conditional pocket (bot × side ×
family × candle pattern × session/hour × SL-width band × pattern-score band ×
symbol tier), IS/OOS split Sep–Feb / Feb–Aug, metric R = pnl/(notional·SL%).
- The only strong signal (`hold ≥4h` = +0.19R all bots, both windows) is
  **look-ahead** — hold time is only known after the fact. The honest version
  ("survived first 30min without stopping") is still −0.09 to −0.10R.
- Everything knowable at entry stays negative in OOS. Session/family/hour pockets
  that looked positive IS flipped negative OOS (overfit — the split caught them).
- One real takeaway: **stops are too tight.** SL <0.6% → −0.35R; SL ≥1.3% → −0.10R.

Confirmatory backtest `giveitroom-2x-2026-08` (Bots 1–3, 12mo, 66 sym, 2× stop
distance, 2× TP distance, `--sl-mult 2 --tp-mult 2`): meanR **−0.18 → −0.08** on
all three (win 32.7→35.3%), IS −0.07 / OOS −0.11, ~10% now time out at 48h.
**Cuts the bleed ~half, does not cross zero.** No tradeable edge. Not flagged for
training. Harness now has `--sl-mult` / `--tp-mult` knobs (backtest-only, scale
stop/TP distance from entry; `configuredStopLossPercent` scaled to match).

### NEW: backtest run registry + AI Training UI

Every `replay-dataset.js` run now records itself:
- `server/data/backtest-runs.json` — registry index (config, signals used,
  per-bot summary incl. BUY/SELL, conclusion, live progress + ETA, `includeInTraining`)
- `server/data/backtest-runs/<id>.json` — that run's rows (when `--run-id` given
  without `--out`; a bare run still writes the legacy `backtest-history.json`)
- `server/backtest/runs/<id>.md` — human report
- New flags: `--run-id`, `--label`, `--conclusion`. See `server/backtest/run-registry.js`.

Server: `getPreferredLearningBotDataset` merges rows from registry runs flagged
`includeInTraining: true` (deduped by id; a run pointing at `backtest-history.json`
is not double-loaded). Baseline path (nothing extra flagged) is byte-identical to
before. New endpoints: `GET /api/learning-bot/backtests`,
`PATCH /api/learning-bot/backtests/:id` (`includeInTraining` / `conclusion` /
`label`; **no settings.json touch**), `GET .../backtests/:id/report`,
`GET /api/learning-bot/signal-insights` (per bot × family: count / win% /
avgReward / entryQuality + works|marginal|losing verdict).

UI: **AI Training tab** gains **Backtests** (`BacktestHistoryPanel.jsx`) and
**Signal Insights** (`SignalInsightsPanel.jsx`) sub-tabs; Training-page copy
refreshed to say training runs on live trades + flagged backtest runs. Backfilled
two registry entries: `main-12mo-2026-08` (flagged ON — it *is* the current live
policy source via the legacy file) and `moneystop-1usd-2026-08` (OFF).

Built + pm2-restarted `xeniostrade-api`. Auto-trader loop verified still logging.
**Not committed.**

⚠️ Memory: pm2 runs the server with `--max-old-space-size=896`. A `/dataset` call
already spikes to ~415 MB parsing the 121 MB `backtest-history.json`. Flagging a
*second* large run (e.g. the 91 MB money-stop file) for training in one call
risks OOM — raise the heap cap first or keep one large run flagged at a time.

### Bot 5 — built, backtested negative, then REVERTED

Tried a 5th signal model `model-5` "HTF Trend Pullback" (regime-filtered trend
continuation: 1H+15M trend + ADX + shallow EMA20 pullback + 5M reclaim, structural
stop, fixed 3R). 4 backtest configs, all net-negative, ≈ −0.15 to −0.22 R/trade,
25–36% win. Tightening entries *lowered* win rate. Same wall as Bots 1–4.

Owner chose **option C** → Bot 5 code fully **reverted** from `signalModels.js`
and `mock-trading-server.js` (running server never loaded it; disk now matches).
Design + full result table preserved here in case option A (extend harness for
trade management, then re-test) is ever picked up. `server/backtest/` harness
untouched and still works.

### Now: lean on the AI filter + Phase B for Bots 1–4

**Filter state (verified from the live artifact + settings):**
- `aiEntryFilter.paperOnly: false` (hard block) for all; thresholds Bot 1/2 = 62,
  Bot 3 = 60, Bot 4 = 50. `reviewWindowTrades: 0`. `includeBacktestData: true`.
  Settings revision 64.
- Server restarted ~08:26 UTC, refreshed policy from 118,229 closed trades,
  re-trained (pytorch, ~13 s). `AI : READY | Framework pytorch`.
- Trained policy per bot (count / winRate / avgReward) — **every real family is a
  proven loser** (`provenLoser` = ≥5 samples AND (winRate<40 OR avgReward≤−3)):
  - model-1: all 4 families 30.7–34.9% / −0.13 to −0.69, n=4.5k–11.6k
  - model-2: all 4 families 30.6–34.7% / −0.51 to −1.38, n=2.9k–6.4k
  - model-3: 3 families 31.1–33.4% / **−4.65 to −7.13**, n=5.3k–22.9k
  - model-4: "Trend bias scalp" (n=34,526) 31.1% / −0.51; other 3 families n=1–4 noise
- Loss-averse `scoreCandidateWithAiFilter` caps a proven-loser's finalScore at
  `threshold−12`, so with `paperOnly:false` **the filter now hard-blocks
  essentially every setup all 4 bots normally take.** A +6 pattern nudge can't
  lift a capped score over threshold. Confirmed by reading the code paths.

**So Phase B's practical reality:** with the policy live, Bots 1–3 go near-silent,
Bot 4 mostly silent. That's the filter working — but it also means there is **no
positive core left to paper-validate**. You can stop the bleed by not trading;
you can't grow a winning curve from a strategy whose every family loses.

**Phase B watch (starts for real after 16:00 UTC = 00:00 Manila, when daily
limits reset — as of 09:45 UTC all 4 bots are capped for the Manila day):**
1. Confirm no proven-loser trades leak through (check `aiDecision.accept` on new
   AUTO trades; every model-1/2/3 "Support-zone reversal" / "Unclassified" /
   "Bullish breakout" / "Bearish breakdown" entry should be blocked).
2. Watch the rare bootstrap trades on untried families — are those also losers?
3. A/B `includeBacktestData` on vs off (real-only policy showed the same families
   as losers last session, so expect agreement — do it for the record).

**Decision still open for the owner (within C):**
- **C1** Let it run 2–4 weeks as-is; mostly confirms the negative, low effort.
- **C2** Turn **Bot 3 off now** — −4.65 to −7.13 avg reward, no scenario where it's
  worth running; filter blocks it anyway; disabling removes a wallet from the
  scan. Needs the settings.json edit procedure (revision → 65).
- **C3** Accept the meta-finding: 4 momentum/breakout/reversal bots on 5–15m
  crypto have no edge, filtered or not. Productive path is a different approach
  (higher timeframe / different style / different market), not more validation.

---

## WHERE WE LEFT OFF  — as of 2026-08-31 08:15 UTC

**DONE this session:** first full backtest run + AI training completed and verified.

- Backtest wrote **117,026 rows** → `server/data/backtest-history.json` (121 MB).
  Per-bot 12-month expectancy (all negative — this IS the training signal):
  Bot 1 32.7% win / −0.76 per trade · Bot 2 32.3% / −1.39 · Bot 3 32.9% / **−6.25**
  (worst) · Bot 4 31.0% / −0.77.
- AI training ran on **118,208 rows** (1,182 real + 117,026 backtest), pytorch
  DQN, 12.8 s. `rows 118208 · exit 0 · framework pytorch · actionAlignment 43.7`.
- Per-family sample counts went from n=1–5 → **thousands** (e.g. model-1
  Support-zone reversal n=11,616 @ 30.7%; model-3 Unclassified n=22,929 @ 33% /
  −6.29 avg). Every core family for Bots 1–3 is now a statistically-solid
  "proven loser" → the loss-averse filter will hard-block them.

**Repair made (important gotcha — see GOTCHAS):** the backtest harness calls
`launchLearningBotTraining()` in its own process and exits before the python
trainer finishes, so the trainer's `child.on('close')` writeback never ran —
`learning-bot-train-status.json` was frozen at `running: true, metrics: null`
even though `learning-bot-train-artifact.json` held the good trained policy.
Reconciled the status file from the artifact (`running:false`, `lastExitCode:0`,
`metrics` populated, `artifactGeneratedAt`/`lastSuccessfulCompletedAt` set). No
restart needed — `getLearningBotTrainStatus()` re-reads from disk each call.
Server terminal monitor now shows `AI : READY | Framework pytorch`.

**Live system healthy:** auto-trader scanning 60 symbols every 5 min (~2–3 s/scan),
server ~206 MB, 0 pm2 restarts in 11 h. No trades since ~08:00 UTC because **all
4 bots hit their daily limits** (Bot 1: 3-loss cap; Bots 2/3/4: daily-trade cap)
— the tightened risk caps doing exactly their job. Counters reset 00:00 local
(16:00 UTC).

**Next session — do this:**
1. Roadmap **Phase B** (`GO_LIVE_READINESS.md`): watch per-bot *filtered* paper
   equity on the Journal tab over ~2–4 weeks. Goal: does any bot reach a positive
   curve once the AI filter is skipping its proven-loser families?
2. A/B `learningBot.includeBacktestData` on vs off — confirm the backtest rows
   actually improve live outcomes, not just add pessimism.
3. Any bot that can't get to a positive *filtered* curve → disable it or rewrite
   its strategy. Bot 3 is the prime candidate (−6.25/trade, most aggressive).
4. `actionAlignment 43.7` is low but expected (dataset ~68% losers; the DQN is
   correctly diverging from the mostly-losing recorded entries). Treat it as a
   Phase-B A/B question, not a trainer bug — only dig into `rl_trainer.py` if the
   filter measurably *hurts* paper results.
5. Re-run the backtest later with `--append` and a different date range once the
   config changes again, to refresh the dataset.

**Not started:** Phase 2 (Testnet), Phase 3 (live), spec upgrade. Real money = **NO** (see `GO_LIVE_READINESS.md`).

**Housekeeping owed:** ~26 uncommitted files on branch `ui-app-shell` (now incl.
`backtest-history.json` — 121 MB; consider gitignoring it rather than committing).
Nothing committed this session — commit when the owner wants.

---

## Session — 2026-08-30

Branch `ui-app-shell`. One long session. Order of work:

### 1. Dashboard UI restructure
- Split Dashboard into **Overview** (KPIs + Bot 1-4 status) and a new **Market**
  tab (chart + price stats + Pro Exit Strategy + AI Assistant). New
  `BotStatusGrid.jsx` (extracted from the chart), `ProExitStrategy.jsx`.
- Removed "Manual Trade With ChatGPT" and "Chart Visual Mode" panels.
- Market tab: token/USDT + Last Price / 24h Change / 24h Volume / Quote Volume
  on top (`StatsBar`), with a **market dropdown** + **signal-model dropdown** in
  its header (2 selectors) — the market list is a dropdown now, not a column.
  Deleted `SidebarMarketList.jsx`.
- AI Assistant redesigned to sit beside the chart (2-col, no 3rd column).
- Nav (`shell/navItems.js`): Market added under Dashboard; Journal got children.

### 2. Journal UI restructure
- Split into **Summary** (all wallets 1-4 combined), **Head to Head** (own page),
  **Wallet Journal** (own page, full width, **wallet 1-4 dropdown** to switch).
- `JournalSummaryPage.jsx` → `useJournalViews` hook + `JournalOverviewPage` /
  `JournalHeadToHeadPage` / `JournalWalletPage`. `App.jsx` `renderJournal` now
  nested routes + `JOURNAL_TABS`.

### 3. Chart engine fixes (`CandlestickChart.jsx`)
- **Pan/zoom no longer resets** on streaming ticks. Was recreating the whole
  chart every ~1s; now create-once + incremental effects (data / indicators /
  markers / bot overlays / trade lines). `fitContent()` only once per
  symbol/interval.
- Bot trade projection drawn: entry / SL / TP / support / resistance price lines
  (dashed+dim = projected, solid+bright = ready).
- Timeframe is a **dropdown** now, with more intervals (`1m…1M`).

### 4. STABILITY INCIDENT + fixes
Symptoms: high load, 100%+ CPU on the node server, Binance `fetch` connect
timeouts, huge unrotated pm2 logs (~0.5 GB). **Root cause:** the 5-minute
auto-trader scan of 50 symbols ran on one serial `await` chain — under any
upstream latency it starved the event loop and overran the interval (the
"connect timeouts" were event-loop starvation, not a real network problem;
`curl` to Binance was 150 ms). Not a crash loop — the 12 pm2 restarts were all
manual.
Fixes:
- `pm2 install pm2-logrotate` + config (10 MB, keep 5, gzip).
- `pm2 restart … --node-args="--max-old-space-size=896" --max-memory-restart 1200M` + `pm2 save`.
- **Scan concurrency throttle**: `SIGNAL_SCAN_CONCURRENCY = 5` + `mapWithConcurrency()`;
  per-symbol try/catch (one bad symbol no longer aborts the run).
- **Fetch**: `fetchKlines`/depth/premium timeout → 9 s (beats undici's 10 s
  connect timeout); `fetchJson` backoff → exponential + jitter, harder on
  429/418/connect-timeout.
- Universe `VOLATILE_MARKET_SYMBOL_LIMIT` 50 → **60**.
- Result: 60-symbol scan ~5-9 s (was overrunning 5 min).

### 5. Chart pattern engine
- `src/lib/chartPatterns.js`: ~14 candlestick + ~11 geometric patterns
  (ZigZag pivots). Drawn on the chart (markers + trendlines/necklines) + a
  "Chart Patterns Detected" panel + an AI Assistant readout.
- Server soft-score: `computePatternInsight` / `attachPatternInsight` fold a
  bounded, direction-aware `patternScore` into every signal snapshot;
  `applyPatternAiNudge` moves the AI entry score — **confirming pattern +6 max,
  opposing pattern −14 max** (asymmetric / loss-averse). Never a hard gate,
  never forces a trade.

### 6. LOSS LIMITING (owner: "losses too big, use AI scoring to minimise")
Findings: AI entry filter was `paperOnly: true` for Bots 1-3 = **advisory only,
could not block any trade**. Only Bot 4 was hard-block.
Changes (code defaults `src/lib/signalModels.js` + live `settings.json` +
`settings-recovery.json`, revision bumped):
- AI filter → **hard-block for Bots 1-3** (`paperOnly: false`). Thresholds
  Bot 1/2 → 62, Bot 3 → 60, Bot 4 → 50.
- Risk caps: Bot 1 lev 10→8, SL 1→0.6%, maxLoss/day 50→18, losses/day 5→3,
  trades/day 12→6, open 2→1. Bot 2 lev 20→12, SL 0.9→0.55%, loss/day 60→18,
  losses/day 4→3, trades/day 8→5. Bot 3 preset 1%→0.75% risk, daily cap 5%→2%.
  Bot 4 losses/day 40→15, loss/day 40→15, trades/day 40→25.
- `scoreCandidateWithAiFilter` made **loss-averse**: losing setup families
  penalised ~3× harder than winners rewarded; sub-50% win-rate penalty doubled;
  a "proven loser" (≥5 samples, <40% win OR ≤−3 avg reward) forced below the
  accept threshold. Policies with <5 samples treated as noise (influence scaled
  ~70% down; bot stays in bootstrap so data keeps growing).

### 7. Bot 4 not trading + wallet block
- **Wallet gate**: "open local-paper auto trade freezes the wallet" block was
  hitting every wallet after its first fill. Scoped to exchange-sync wallets
  only; local-paper bots run continuously (capped by `maxOpenPositions`).
- **Bot 4 stuck**: the loss-averse change trusted a 1-sample "0% win" policy and
  zeroed Bot 4's score. Added `MIN_POLICY_SAMPLES = 5`: below it, learned stats
  barely move the score and can't gate → bootstrap keeps the bot trading.
  Verified: Bot 4 placed a trade after.

### 8. Go-live Q&A → `GO_LIVE_READINESS.md` created
Real money = **NO** (no track record, AI untrained, changes hours old, still a
paper system, stability shallow, execution path unreviewed). External AI dataset
= can't import (dataset is this system's own closed trades). Spec upgrade for
live = yes, for reliability (4 vCPU / 8 GB dedicated headless), not compute.

### 9. Backtest AI-dataset harness (BUILT)
`server/backtest/replay-dataset.js` + `historical-data.js` + `README.md`.
Replays the real `analyzeSymbolStrategy` over historical klines, simulates each
entry to TP/SL (SL wins ties; Bot 4 −1 USDT money-stop; timeout after
`--max-hold-hours`), applies fee+slippage, writes closed-trade rows to
`server/data/backtest-history.json` (`source: AUTO_BACKTEST`). Reservoir-samples
to `--cap-per-symbol-bot` (default 500). Auto-trains after unless `--no-train`.
Server changes: main-module guard via `XENIOS_SERVER_AUTOSTART` env,
`export`ed the functions it imports, `getLearningBotEligibleClosedTrades`
matches `startsWith('AUTO')`, `getPreferredLearningBotDataset` merges the
backtest file when `learningBot.includeBacktestData` (new setting, default true).

### 10. `reviewWindowTrades` 20 → 0  (critical)
`learningBot.reviewWindowTrades` was **20** → `buildLearningBotDataset` did
`.slice(0, 20)` → training only ever saw the 20 newest trades (backtest data
would have been discarded; per-family counts stuck at n=1-5). Set to **0** =
train on every eligible closed trade. Immediately took training from 20 → 1182
real rows; per-family counts jumped (Bot 1/2 "Support-zone reversal" now n=222-251
at ~23-33% win → proven losers → the filter now actually skips them).
Settings revision → 64, recovery synced.

---

## KEY GOTCHAS / LANDMINES  (read before touching these)

- **`server/mock-trading-server.js` boots a server on import.** Only safe to
  `import` it with `process.env.XENIOS_SERVER_AUTOSTART = 'off'` set *first*
  (use a dynamic `await import()`, not a hoisted static import). An
  entry-point check (`argv[1] === __filename`) does NOT work — pm2 fork mode
  loads the file through its own wrapper. Getting this wrong = pm2 crash-loop
  (server exits clean because nothing keeps the event loop alive → pm2 restarts
  → repeat; ~50 restarts happened once this way, fixed).

- **Editing `server/data/settings.json` live:** the server's self-heal only
  guards *credentials* and *autoTradingEnabled going false* and *revision going
  backwards* — it does NOT validate risk numbers, AI filter, or
  `reviewWindowTrades`. Safe procedure used this session: `pm2 stop`, edit
  `settings.json` **and** `settings-recovery.json` (bump `settingsRevision` in
  both, keep them equal), `pm2 start`, `pm2 save`. Verify the value stuck.

- **`reviewWindowTrades` must stay 0** or the whole dataset (incl. backtest) is
  silently truncated to the newest N. It's the "review trades" field on the AI
  Training / Bot Strategy settings page.

- **Backtest auto-train leaves `learning-bot-train-status.json` stale.**
  `replay-dataset.js` calls `launchLearningBotTraining()`, which returns
  `{ok:true}` immediately and registers a `child.on('close')` handler to write
  the final status. The harness process exits right after, killing that handler,
  so the trainer still finishes and writes `learning-bot-train-artifact.json` but
  the status file stays at `running:true, metrics:null` — and the live server
  reads *status*, not the artifact, for its policy (`scoreCandidateWithAiFilter`,
  `buildSignalAnalysisAiAdvisory` bail on `!trainStatus.metrics`). Fix after any
  harness auto-train: copy `metrics` + `generatedAt` from the artifact into the
  status file and set `running:false, lastExitCode:0`. (Better long-term: have
  the harness `--no-train` and instead trigger training through the running
  server's endpoint, or await the child in `launchLearningBotTraining`.)

- **pm2 app id drifts** (delete/re-add renumbers it); always target it by name
  `xeniostrade-api`. `max_memory_restart` 1200 MB + `--max-old-space-size=896`
  are set and `pm2 save`d.

- **Server TZ is Asia/Manila (UTC+8)** in its own log lines; system clock is UTC.

- **Frontend is served from `dist/`** by the pm2 process (`express.static`), not
  a dev server. After any `src/**` change: `npm run build`, then hard-refresh
  the browser. No pm2 restart needed for frontend-only changes.

- **`npm run backtest:dataset`** is CPU-heavy and long. Run it when slower live
  scans are acceptable. It's memory-bounded by `--cap-per-symbol-bot`.

---

## FILE MAP  (what this session changed)

New:
- `src/lib/chartPatterns.js`, `src/components/BotStatusGrid.jsx`,
  `src/components/ProExitStrategy.jsx`
- `server/backtest/{replay-dataset.js,historical-data.js,README.md}`
- `GO_LIVE_READINESS.md`, `SESSION_LOG.md`
- `server/data/backtest-history.json` (written by the backtest run)

Deleted: `src/components/SidebarMarketList.jsx`

Modified (highlights):
- `src/App.jsx` — Dashboard/Journal route restructure, pattern wiring, dropdowns
- `src/components/CandlestickChart.jsx` — incremental render, patterns, tf dropdown
- `src/components/{StatsBar,AIAssistantSidebar,JournalSummaryPage}.jsx`
- `src/components/shell/navItems.js`
- `src/lib/{signalModels.js,tradingConfig.js}` — risk caps, universe 60
- `server/mock-trading-server.js` — scan throttle, fetch backoff, pattern
  soft-score, loss-averse AI filter, main-module guard, exports, dataset merge
- `server/data/settings.json` + `settings-recovery.json` — risk, AI filter,
  reviewWindowTrades=0, revision 64
- `package.json` — `backtest:dataset` script
- pm2 config (logrotate, memory guard) — outside the repo, in `~/.pm2`

Uncommitted. Commit when the owner asks.
