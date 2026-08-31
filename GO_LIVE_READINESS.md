# Go‑Live Readiness — XeniosTrade

Running record of "can real money go on this system yet?" and the surrounding
questions. Update this file at every review; keep the newest assessment on top.

---

## Assessment — 2026‑08‑30

### Q: Am I (Claude) confident real money can go on this system now?

**No.** Not because the concept is unsound — because of the current state of
*this* system:

| Gap | Detail |
|---|---|
| **No track record** | No demonstrated positive expectancy. No equity curve, no verified win rate over a large sample. The owner's own words: "the losses is just too big that there is no more room for profit." Today's changes make it *lose less*; they do not prove it *wins*. |
| **AI is not trained** | The learned policy has ~20 total rows. Several setup families have 1 sample. That is noise, not a model — which is why a "ignore learned stats below 5 samples" rule had to be added so the bots aren't paralysed by flukes. |
| **All changes are hours old** | On 2026‑08‑30: risk caps / leverage / stops cut, AI scoring math changed, pattern detection added, AI entry filter flipped from advisory to hard‑block, a wallet safety gate scoped down. None validated over time. First trades under the new config were watched live the same day. |
| **Still a paper system by design** | The code has an explicit Phase 1 → 2 → 3 progression. Phase 3 = "controlled live Binance API only: one bot, tiny size, one open position max, strict daily loss cap, manual supervision." Not reached. Wallets are `MANUAL` local‑paper. |
| **Operational stability is recent and shallow** | Same day: CPU pegged, Binance connection timeouts, 17+ process restarts. 2‑vCPU / 3.8 GB box. Calm now ≠ reliable for weeks. |
| **Live execution path unreviewed** | Real order placement, whether stop‑losses sit on the exchange vs. are simulated, fees, slippage, partial fills, disconnect‑mid‑position behaviour — none audited. Trades seen so far are simulations. |

**Adding real money now would be betting on hope, not evidence.**

### Definition of ready (all four before any live key is used)

1. Run the current config on **paper for several weeks / a few hundred trades**
   and confirm a genuinely positive, stable equity curve.
2. Grow the AI dataset to a real size (hundreds+ rows) and show the filter
   **measurably improves** outcomes vs. no filter (A/B on paper).
3. Follow the system's own path: **Phase 2 on Binance Testnet**, then **Phase 3**
   with the smallest possible live size + strict daily loss cap, scaling only
   after it holds up for a sustained period.
4. A proper review of the **order‑execution and failure‑handling code** before
   any live API key is connected.

---

### Q: Can an AI dataset be obtained elsewhere and fed in?

**Not by importing an external dataset — that will not help.** How the dataset
actually works (verified in `server/learning-bot/rl_trainer.py` +
`buildLearningBotDataset` in `server/mock-trading-server.js`):

- The dataset is built **entirely from this system's own closed trades**
  (`trade-history.json`). One row per closed trade:
  `symbol, side, status (CLOSED_TP / CLOSED_SL), pnl, leverage,
  configuredStopLossPercent, signalSummary → setupFamily, entryQualityScore,
  mistakeTags`.
- The trainer's state vector is only 7 coarse features (side, entry‑quality,
  stop %, leverage, mistake‑tag count, was‑TP, was‑SL). Reward =
  `pnl − riskPenalty + qualityBonus`.
- What it learns is essentially **historical expectancy per (bot, setup family)**
  — a smoothed lookup table (the `setupFamilyScores`), not price prediction.

An outside dataset (Kaggle OHLCV, someone else's trade log) has none of these
columns and none of this system's `signalSummary` strings, so it cannot be
mapped in. Public data is fine for *price history*; it is not what this trainer
consumes.

**The real way to grow the dataset fast: a historical replay harness.**
Pull months of klines from Binance (free), step bar‑by‑bar, run the existing
`analyzeSymbolStrategy` at each bar, and when a bot *would* have entered,
simulate forward to TP or SL and write a closed‑trade record in the same format.
This can produce hundreds–thousands of rows in ~an hour of compute instead of
months of live paper, then `launchLearningBotTraining` runs on it.

Caveats to keep honest: a backtest‑generated dataset teaches *historical* setup
expectancy only. Without modelling fees/slippage and with a fixed symbol list it
carries the usual backtest optimism. It is a bootstrap, not proof of edge.

Status: **BUILT + FIRST FULL RUN COMPLETE (2026-08-31)** —
`server/backtest/replay-dataset.js` (+ `historical-data.js`, `README.md`).
Writes `server/data/backtest-history.json` (`source: AUTO_BACKTEST`), which
`getPreferredLearningBotDataset()` merges into training when
`learningBot.includeBacktestData` is true (default). Auto-launches training
after (pass `--no-train` to skip). Caveats in the harness README (order-book
proxy for bots 1-2, single regime, 5m exit resolution, flat fees). Reservoir-
samples to `--cap-per-symbol-bot` (default 500) so a loose-rule bot can't blow
up memory on a wide/long run.

**First full run — COMPLETE (2026-08-31):**
`node --max-old-space-size=2048 server/backtest/replay-dataset.js --months 12
--stride 2 --cap-per-symbol-bot 500` — 70 symbols (2 skipped: 1000PEPEUSDT,
1000PEPE HTTP 400), all 4 bots. Wrote **117,026 rows** →
`server/data/backtest-history.json` (121 MB). 12-month expectancy per bot,
after fees+slippage — **every bot negative**, confirming the owner's read that
"the losses are too big":

| Bot | rows | win % | avg/trade (USDT) | total (USDT) |
|---|---|---|---|---|
| 1 | 30,619 | 32.7 | −0.76 | −23,177 |
| 2 | 17,859 | 32.3 | −1.39 | −24,809 |
| 3 | 34,048 | 32.9 | **−6.25** | **−212,680** |
| 4 | 34,500 | 31.0 | −0.77 | −26,520 |

AI training then ran on **118,208 rows** (1,182 real + 117,026 backtest):
pytorch DQN, 12.8 s, `exitCode 0`, `actionAlignment 43.7` (was ~45 real-only —
stays low because the dataset is ~68 % losers and the policy correctly diverges
from the mostly-losing recorded entries; treat as a Phase-B A/B question, not a
trainer bug). Per-family sample counts went from n=1–5 to **thousands** (e.g.
model-1 Support-zone reversal n=11,616 @ 30.7 % win; model-3 Unclassified
n=22,929 @ 33 % / −6.29 avg reward). Bots 1–3's core setup families are now
statistically-solid "proven losers" → the loss-averse filter hard-blocks them.

**Post-run fix:** the harness auto-train left `learning-bot-train-status.json`
stale (`running:true, metrics:null`) because the harness process exits before the
trainer's writeback handler runs; the trained policy in
`learning-bot-train-artifact.json` was intact. Reconciled the status file from
the artifact (no server restart needed). Documented in `SESSION_LOG.md` GOTCHAS.

**Interpretation:** the backtest is a *bootstrap*, not proof of edge (order-book
proxy for Bots 1–2, single 12-month regime, 5 m exit resolution, flat fees). But
the signal is unambiguous and consistent with live paper results: none of the 4
strategies has positive raw expectancy. Phase B is now about whether the AI
filter, skipping the proven-loser families, can lift any bot to a positive
*filtered* curve — and disabling/rewriting the ones it can't (Bot 3 first).

**Follow-up run — −1 USD hard money stop on Bots 1–3 (2026-08-31):** win rate
collapses to 3–10 %, per-trade loss drops only 10–27 %, still deeply negative
(Bot 1 −$21.3k, Bot 2 −$22.6k, Bot 3 −$149k). Not a fix. Kept at
`server/data/backtest-moneystop.json`, **not** merged into training.

**Backtest runs are now tracked** (`server/data/backtest-runs.json` +
`server/backtest/runs/*.md`, surfaced on AI Training → Backtests). Each run has an
`includeInTraining` toggle; only the 12-month baseline is flagged on. New signal
iterations should be backtested, recorded, and flagged in only once a family
clears the "works" bar in AI Training → Signal Insights.

**CRITICAL fix made so the run actually counts:** `learningBot.reviewWindowTrades`
was **20**, meaning `buildLearningBotDataset` did `.slice(0, 20)` — training only
ever saw the 20 most-recent closed trades, so (a) the backtest data would have
been discarded and (b) per-family sample counts could never grow past ~20 total
(exactly why they were stuck at n=1-5). Set to **0** = train on every eligible
closed trade (the `defaultLearningBotSettings` value). This is the "review
trades" field on the AI Training / Bot Strategy settings page — keep it at 0.
Settings revision bumped to 64; recovery snapshot synced.

**Verify after the run finishes:**
```
python3 -c "import json; t=json.load(open('server/data/learning-bot-train-status.json')); \
print('exitCode', t['lastExitCode'], '| error', repr(t['lastError']), \
'| rows', t['metrics']['rows'], '| framework', t['metrics']['framework'])"
# want: exitCode 0, error '', rows ~120k (was 20), framework pytorch
python3 -c "import json; p=json.load(open('server/data/learning-bot-train-status.json'))['metrics']['policy']['bySignalModel']; \
[print(k, {f:s['count'] for f,s in v['setupFamilyScores'].items()}) for k,v in p.items()]"
# want: per-family 'count' now in the hundreds, not 1-5
```
Then watch Mock Trading → Auto Trade Activity for `AI filter scored <low>/100 …
skipped` on the loss-making families.

Slower, already-running alternatives: 60-symbol universe (done), bootstrap mode
accepting untried setup families (done) — these grow the *live* dataset at
roughly tens of rows/day.

---

### Q: Should the system specs be upgraded before executing real‑money trades?

**Yes — but for reliability, not compute.** At steady state the current
2‑vCPU / 3.8 GB box handles the 60‑symbol scan in ~5 s. The real‑money risk is a
process OOM / swap / hung scan / pm2 restart **while a live position is open**,
causing a missed stop‑loss exit or management action. On paper that is a
rounding error; with real money it is a real loss.

Recommended for live:

- **4 vCPU / 8 GB minimum, dedicated and headless** (no desktop / xrdp / GUI).
  8 GB gives Node (~0.8 GB) + the PyTorch DQN trainer child process room without
  swap.
- Provider with good low‑latency Binance connectivity (the connect‑timeout
  errors were partly latency + rate‑limit under load).
- Run the AI trainer on a schedule when no scan is active, or on a separate box.
- Uptime + process monitoring with alerting, specifically on: process down,
  "scan overran the interval," and "position open with no stop confirmed on the
  exchange."
- Raise `pm2 max_memory_restart` proportionally and alert on every restart — a
  restart holding a live position is the dangerous case.

A spec upgrade removes a failure mode. It does **not** create edge. The Phase 2 /
Phase 3 validation above still has to happen.

---

## Change log — hardening done 2026‑08‑30 (context for future reviews)

- **Stability**: pm2 log rotation (was 0.5 GB, unrotated); `max_memory_restart`
  1.2 GB + `--max-old-space-size=896`.
- **Scan engine**: added `SIGNAL_SCAN_CONCURRENCY = 5` batched scan +
  per‑symbol try/catch (one bad symbol no longer aborts the run); market‑data
  fetch timeout 9 s + exponential/jittered backoff, harder on 429/418/connect.
  Universe 50 → 60. 60‑symbol scan now ~5 s (was overrunning the 5‑min interval).
- **Risk caps tightened** (live `settings.json` + code defaults):
  - Bot 1: lev 10→8, SL 1→0.6 %, maxLoss/trade 10→6, losses/day 5→3,
    loss/day 50→18, trades/day 12→6, open pos 2→1.
  - Bot 2: lev 20→12, SL 0.9→0.55 %, maxLoss/trade 21.6→8, losses/day 4→3,
    loss/day 60→18, trades/day 8→5.
  - Bot 3: risk 1 %→0.75 % of balance, losses/day 5→3, daily cap 5 %→2 %.
  - Bot 4: losses/day 40→15, loss/day 40→15, trades/day 40→25, open pos 3→2
    (1 USDT max loss/trade kept).
- **AI entry filter now hard‑blocks Bots 1–3** (was `paperOnly: true` = advisory
  only). Thresholds: Bot 1/2 → 62, Bot 3 → 60, Bot 4 → 50, global → 60.
- **AI scoring is loss‑averse**: losing setup families penalised ~3× harder than
  winners are rewarded; sub‑50 % win rate penalty doubled; a "proven loser"
  (≥5 samples, <40 % win or ≤−3 avg reward) is forced below the accept
  threshold. Learned stats with <5 samples are treated as noise (influence
  scaled ~70 % down, cannot gate a bot → bootstrap keeps collecting data).
- **Chart pattern engine** (`src/lib/chartPatterns.js`): ~14 candlestick + ~11
  geometric patterns, drawn on the chart, shown in a panel and the AI Assistant.
  Feeds the AI score as a bounded nudge — confirming pattern +6 max, **opposing
  pattern −14 max** (a confident opposing pattern can veto a borderline entry).
- **Wallet gate**: the "open local‑paper auto trade freezes the wallet" block
  scoped to exchange‑sync wallets only, so local‑paper bots run continuously
  (capped by their own `maxOpenPositions`).
- **Backtest AI‑dataset harness** built (`server/backtest/`). `mock-trading-server.js`
  now: (a) starts the HTTP server + timers only when `XENIOS_SERVER_AUTOSTART`
  is not `off` (so the harness can import its functions without booting a second
  server — an entry‑point check is unreliable under pm2 fork mode); (b) exports
  the functions the harness needs; (c) `getLearningBotEligibleClosedTrades`
  matches `source` by `startsWith('AUTO')` so `AUTO_BACKTEST` rows count;
  (d) `getPreferredLearningBotDataset` merges `backtest-history.json` when
  `learningBot.includeBacktestData` (new setting, default true).
- **`learningBot.reviewWindowTrades` 20 → 0** so training uses every eligible
  closed trade instead of only the newest 20 (was silently capping the whole
  dataset — including the backtest rows — at 20). Settings revision → 64.
- **First full backtest run launched** (12 months, 70 symbols, all bots,
  stride 2, cap 500, `--max-old-space-size=2048`, auto-train).
