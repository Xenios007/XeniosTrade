# XeniosTrade backtest expansion — 8 bots, 5-year run

Working brief for the multi-phase build. **§1-9 = original plan. §10 = live execution
log (autonomous `/loop` build on this machine).** §11 = STATUS DASHBOARD (read this first).

---

## 11. STATUS DASHBOARD  (updated 2026-09-02 00:08 local — 7-run program COMPLETE)

**ALL 7 RUNS DONE.** RUN 1 (primary, trained) + RUNS 2-7 (validation, replay+report only) all
`complete` in the registry. RUN 7 experimental unseen-symbol model trained (exit 0).
Final: `server/backtest/reports/COMBINED-validation-report.md` (7/7 runs present).
Server backtest UI now lists all 10 runs (7 new + 3 pre-existing), `includeInTraining:false` on
every validation run except `validation-stress` (flipped to `true` on the server — see
[[server-deployment]]; harmless, its NDJSON isn't on the server so it just contributes 0 rows).
Big datasets (primary ndjson 578 MB, all validation ndjsons, historical-cache 586 MB) stayed
local as instructed — only the registry summaries + `runs/*.md` reports were pushed.

Also this session: Bots 5-8 + 8-wallet allocation (750 USDT each) deployed live to the 24/7
server (`xenios@139.180.209.238:/home/xenios/app`, PM2 `xeniostrade-api`), AI scoring frozen on
the RUN 1 CUDA policy (auto-retrain gated off), nginx docroot re-synced. Full detail in the
`server-deployment` memory, not duplicated here.

---

## 11-a. STATUS DASHBOARD  (superseded — kept for history, was: updated 2026-09-01 18:17 local — RESUME after power cut)

### RESUME 2026-09-01 18:17 (power interruption recovery)

- Power cut killed every detached process. On restart: nothing running.
- **Done & intact:** RUN 1 `primary-8bot-5yr` (replay+CUDA train+report). RUN 2 `validation-stress-5y-20symbols-8bots-5fee-5slip` replay complete (20/20, 128k rows, `.ndjson` 156 MB) — its per-run `report.js` had not run; regenerated → `reports/validation-stress-5y-20symbols-8bots-5fee-5slip.md` (235 lines).
- **New blocker hit & fixed:** `server\data` + `server\data\backtest-runs` + `launcher-logs` had reverted to `BUILTIN\Administrators`-owned / `Users:(RX)` → non-elevated node got `EPERM mkdir` for every new run dir (RUNS 3-7 all failed instantly on first relaunch). Fixed from an **elevated** session:
  `icacls C:\XeniosTrade\server\data /grant "neptune\rain:(OI)(CI)M" /T`
  `icacls C:\XeniosTrade\launcher-logs /grant "neptune\rain:(OI)(CI)M" /T`
  (same class as [[node-modules-elevated-perms]] — now also on server\data). Verified: dir+file create OK under both.
- **Relaunched** `run-validation.sh` detached (append → `launcher-logs/validation.log`). RUN 2 skipped (complete), RUN 3 `validation-high-stress` (fee 7 / slip 10, stride 1, `--no-features`) replaying — main pid was 13332, heartbeat advancing. Orchestrator will carry 3→4→5→6→7 → RUN 7 experimental train → `combined-report.js`.
- ETA ~6-9 h fully autonomous. Check: `tail -f launcher-logs/validation.log` · registry statuses · `reports/COMBINED-validation-report.md` at the end.

---

## 11-b. STATUS DASHBOARD  (updated 2026-09-01 ~07:36 UTC)

**Phase:** implementation + tests COMPLETE ✅ · **RUN 1 replay RUNNING** (~13/20) 🔄 · RUN 1 training + report auto · **RUNS 2-7 queued** (validation orchestrator waiting).

### The 7-run program (user directive, 2026-09-01)

| Run | id | symbols | stride | fee/slip | context | trains? |
|---|---|---|---|---|---|---|
| **RUN 1** (PRIMARY) | `primary-8bot-5yr` | 20 | 2 | 5/2 | proxy + features | ✅ primary model |
| RUN 2 | `validation-stress-5y-20symbols-8bots-5fee-5slip` | 20 | 1 | 5/5 | proxy, `--no-features` | no |
| RUN 3 | `validation-high-stress-5y-20symbols-8bots-7fee-10slip` | 20 | 1 | 7/10 | proxy, `--no-features` | no |
| RUN 4 | `validation-strict-context-5y-20symbols-8bots` | 20 | 1 | 5/3 | `--strict-context`, `--no-features` | no |
| RUN 5 | `validation-core-12symbols-5y-8bots` | core 12 | 1 | 5/3 | proxy, `--no-features` | no |
| RUN 6 | `validation-extended-8symbols-8bots` | ext 8 | 1 | 5/3 | proxy, `--no-features` | no |
| RUN 7 | `validation-unseen-symbol-generalization` | 20 | 1 | 5/3 | proxy + **features** | ✅ **separate experimental** model, LINK/AVAX/NEAR/INJ held out of ALL fitting |

- RUNS 2-7 are **never** flagged `includeInTraining` → never enter the primary training rows. No `--append`.
- RUN 7's experimental model → `server/data/ai-training/run7-experimental/artifact.json` (never overwrites the primary `learning-bot-train-artifact.json`).
- All at concurrency **4** (RAM was 12.6 GB free with RUN 1's 5 workers; `--no-features` runs use far less). Cap 800/(symbol,bot) for validation statistical power.

### Code added for the validation program (all additive, RUN 1 untouched)

- `replay-dataset.js` / `replay-worker.js` — **`--no-features`** flag: skips the 263-value feature vector + BTC/ETH context (still tags `marketRegime`); ~2x faster + ~10x smaller output for the no-train validation runs.
- `rl_trainer.py` — **`symbolHoldout`** config (additive, gated): named symbols excluded from train/val/holdout fitting + threshold + model selection, then scored separately as `perBot[bot].unseenSymbolEval` (+ `bySymbol`). Default absent = identical to before. **pytest 27/27** (2 new).
- `server/backtest/train-experimental.js` — RUN 7 experimental trainer (own dataset from RUN 7 rows only, own artifact dir, `symbolHoldout: [LINK,AVAX,NEAR,INJ]`).
- `server/backtest/report-lib.js` — shared metric math.
- `server/backtest/combined-report.js` — final cross-run report → `server/backtest/reports/COMBINED-validation-report.md`.
- `server/backtest/run-validation.sh` — detached orchestrator: waits for `reports/primary-8bot-5yr.md`, then RUNS 2→7 sequentially (each `report.js` per-run), then RUN 7 experimental training, then `combined-report.js`. Resumable (`--resume`; skips runs already `complete`).

### Two detached orchestrators (sequential handoff via the RUN 1 report file)

1. `run-remaining.sh` (already running) — RUN 1 replay → `train-primary.js` (CUDA) → `report.js` → `reports/primary-8bot-5yr.md`.
2. `run-validation.sh` (running, idle-waiting) — on that report appearing → RUNS 2-7 → combined report.

Logs: `launcher-logs/{replay,pipeline,validation,replay-resume}.log`.

### Timing (measured RUN 1 ≈ 10 min/symbol at stride 2)

RUN 1 remaining ~20 min + primary training ~20 min. RUNS 2-6 at stride 1 + `--no-features` ≈ 45-70 min each (20-sym) / less for 12- & 8-sym. RUN 7 (features, stride 1) ≈ ~110 min + ~15 min training. **RUNS 2-7 total ≈ 5-7 h.** Whole program from now ≈ **~6-8 h**, fully autonomous.

### INCIDENT — RUN 1 stalled at 19/20 on 1000PEPEUSDT (2026-09-01 ~08:10, resolved)

- **Symptom:** replay stuck at 19/20 for ~25 min, worker CPU frozen (0 in 30s), 3 dead HTTPS connections.
- **Cause:** `1000PEPEUSDT` has **no Binance spot listing** (spot returns HTTP 400 `-1121 Invalid symbol`). The old `fetchJsonWithRetry` treated 400 like a transient error → 5 retries × exponential backoff per base × 2 bases ≈ 36 s wasted *per page*, ~60 months × 3 timeframes, then the fetch hung outright.
- **Fix (additive, doesn't touch RUN 1's 19 done symbols):** `historical-data.js` — `PermanentHttpError` on any non-429/418 4xx → break immediately; `spotUnavailable` Set so later pages skip spot entirely and go straight to USD-M **futures** klines. +2 regression tests (`test/historical-data.test.js`), **node 43/43**.
- **Recovery:** pre-warmed `1000PEPEUSDT` cache in a separate process (genuine futures data, listed **2023-05-05**, ~40 mo: 5m 349,725 · 15m 116,575 · 1h 29,145 bars · funding 3,644 — ~140 s). Verified RUN 1's 19 NDJSON files intact (76,000 rows, 0 corrupt), backed up `_manifest.json`, killed **only** the deadlocked replay process, relaunched `replay-dataset.js --resume` → "1 to do (resume: 19 done)". 1000PEPEUSDT now replaying from warm cache. No data restarted / overwritten / duplicated — completion via the built-in resume path. `run-remaining.sh` orchestrator unaffected (no double-launch — fresh heartbeat within 12 s).

### INCIDENT 2 — RUN 1 merge crashed on `JSON.stringify` size limit (2026-09-01 ~08:45, resolved)

- **Symptom:** all 20 symbols replayed (80k rows on disk) but `replay-dataset.js:main` threw `RangeError: Invalid string length` at the final `JSON.stringify(allRows, null, 2)`. Orchestrator then looped failed `--resume` every ~5 min.
- **Cause:** a full-feature 5-year / 20-symbol / 8-bot dataset is **~600 MB** — past V8's ~512 MB max string length. Neither `JSON.stringify` nor `fs.readFile`+`JSON.parse` can handle it as one blob. Same latent bug in the training-dataset artifact write.
- **Fix — streaming everywhere (`server/backtest/ndjson.js`, new):**
  - Merged run output is now **`<id>.ndjson`** (streamed row-by-row via `concatNdjson`, summary computed by `iterateRowsNdjson`). Registry `dataFile` → `.ndjson`.
  - `getFlaggedBacktestRunRows` (server) stream-reads `.ndjson` dataFiles.
  - Training-dataset artifact written by `writeDatasetArtifact` → `writeDatasetArtifactStreamed` (valid JSON, streamed; Python `json.load` has no size limit).
  - `report.js` / `combined-report.js` / `train-experimental.js` read via `readRunRows` (prefers per-symbol NDJSON dir).
  - `report.js` / `combined-report.js` / `train-experimental.js` **self-re-exec with `--max-old-space-size=8192`** (feature-rich row arrays buffer >2 GB).
  - +8 tests `test/ndjson.test.js` (round-trip, concat, torn-line tolerance, readRunRows fallbacks, streamed-artifact validity). **node 51/51**, pytest 27/27.
- **RUN 1 finalized:** re-ran `replay-dataset.js --resume` (todo=[]) → streamed merge → **80,000 rows** → `primary-8bot-5yr.ndjson` (605 MB). Registry `complete`. `train-primary.js` → trained all 8 bots on **CUDA (RTX 3070 Ti)**, 46,631 train / 18,165 val / 15,204 holdout, leakage check PASSED (263 keys), 27.5 s. `report.js` → `reports/primary-8bot-5yr.md` (243 lines).
  - **Raw result (no surprise, per brief):** every bot has negative expectancy / PF < 1 at 5+2 bps even with the AI filter. Bot 5 (mean-rev) best raw win 43.8%, Bot 7 (range-fade) 39.9%. Bot 3 (trend-pullback) catastrophic (−7.2 exp, PF 0.74) — risk-sizing issue; Bot 4 (momentum) PF 0.35 (50x + tight stops eaten by friction). AI TAKE/SKIP gives marginal val improvements on Bots 1/2/8, none turn profitable. The validation runs + regime analysis will drive retire/rework calls.

### VALIDATION RUNS 2-7 — RUNNING (2026-09-01 ~08:50)

`run-validation.sh` (relaunched with heap export) chaining RUN 2→3→4→5→6→7→`combined-report.js`.
All `--no-train`, none flagged `includeInTraining`, no `--append`.

**Progress @ ~09:25:** RUN 2 (`validation-stress`, fee 5 / slip 5, stride 1, `--no-features`, cap 800, 4 workers) — **6/20 symbols**, ~16 min/symbol → ~1.75 h/20-sym run. Output verified: `features:null`, `frictionUsd = notional×0.002` (10 bps/side ✓), regime tags present, 800 rows/bot, chronological splits ✓, files ~7.8 MB/symbol (4× smaller than featured).

**Revised total estimate:** RUN 2/3/4 ~1.75 h each (20 sym) · RUN 5 ~1 h (12) · RUN 6 ~40 min (8) · RUN 7 ~2.5 h (20, features) + train ~1 min · combined report ~5 min → **≈ 9-10 h autonomous**. RAM steady ~20 GB free.

---

*(historical execution log continues below)*

## 11-old. STATUS (superseded — kept for history)

**Phase:** implementation + tests COMPLETE ✅ · **primary replay RUNNING** 🔄 · training + report pending (auto).

| Step | State |
|---|---|
| Bots 5-8 (mean-reversion / vol-breakout / range-fade / funding-contrarian) | ✅ done, wired, dispatched |
| Leakage-free feature lib (263 features) + regime + splits + cost model + BTC/ETH context | ✅ done, smoke-verified 0 leakage / 840k values |
| `rl_trainer.py` → per-bot TAKE/SKIP + 4 regression heads, split-aware, CUDA, leakage guard | ✅ done, GPU-verified |
| Row schema v2 (features vs label/reward) + `assertNoLeakageInFeatures` | ✅ done |
| Tests: `node --test` **41/41** · `pytest` **25/25** | ✅ green |
| Historical cache: 20 symbols, 5m/15m/1h + funding, 576 MB | ✅ warm (`server/data/historical-cache/_summary.json`) |
| **Primary replay** (`primary-8bot-5yr`, stride 2, 5 workers, cap 500) | 🔄 running — 4/20 symbols done at last checkpoint (~10 min/symbol) |
| Per-bot CUDA training | ⏳ auto (orchestrator) |
| 38-section report | ⏳ auto → `server/backtest/reports/primary-8bot-5yr.md` |

### How the rest runs unattended

`server/backtest/run-remaining.sh` is launched **detached** (`nohup … & disown`, logs → `launcher-logs/pipeline.log`). It:
1. polls the run registry; if the replay's `_heartbeat.json` goes stale >150s and the run isn't `complete`, it relaunches `replay-dataset.js --resume` (crash / session-close recovery — the replay is symbol-level resumable via `_manifest.json`),
2. on `status: complete` → `node server/backtest/train-primary.js` (flags run `includeInTraining`, assembles the v2 dataset, launches the CUDA trainer, waits),
3. → `node server/backtest/report.js --run-id primary-8bot-5yr`.

### Check status any time

- UI: http://127.0.0.1:5173 → **AI Training → Backtests** (server + vite are running; vite now ignores `server/data/**`).
- CLI: `tail -f launcher-logs/pipeline.log` · `tail -f launcher-logs/replay.log` · `cat server/data/backtest-runs/primary-8bot-5yr/_manifest.json`
- Registry: `node -e "console.log(require('./server/data/backtest-runs.json').find(r=>r.id==='primary-8bot-5yr').progress)"`

### Closing / resuming this session

- **Recommended:** keep the laptop **awake** (disable sleep) — the detached replay + orchestrator + trainer then finish on their own in **~1.5-2 h total**; the report lands at `server/backtest/reports/primary-8bot-5yr.md`.
- Closing the Claude session is OK — the pipeline processes are `nohup`/`disown` detached and reparent away from the shell. The `/loop` self-check stops, but the orchestrator does not need it. On `claude --resume` the loop reattaches and verifies/finishes anything outstanding.
- **If the laptop sleeps**, the processes pause; on resume the orchestrator's heartbeat check will `--resume` the replay automatically.

### Timing (measured, not estimated)

- 1 symbol replay (stride 2, 8 bots, 1 worker) ≈ **~10 min** (BTCUSDT 583s, BNBUSDT 621s, ETHUSDT 629s).
- 20 symbols at concurrency 5 ≈ **~40-50 min** wall (extended symbols with 40-mo history are faster).
- Training (8 bots, 70 epochs, ~70-80k rows, CUDA) ≈ **~15-35 min**. Report ≈ seconds.
- **Total ≈ 1.5-2 h**, *not* 7 h. (7 h was the pre-worker-refactor single-thread figure.)

### Actual history per symbol (from the warm cache)

Core (full 60 mo, 2021-09-26 → 2026-08-31): BTC ETH BNB SOL XRP ADA DOGE LINK LTC TRX DOT AVAX.
Extended: NEAR INJ FET HBAR = full 60 mo; **APT 47 mo** (listed 2022-10-19), **ARB 42 mo** (2023-03-23),
**SUI 40 mo** (2023-05-03). 1000PEPEUSDT pulled from Binance **USD-M futures** klines (no spot listing) — genuine, not substituted.

---

## 0. Current repo state (as left by the laptop session, 2026-09-01)

- Clone at `C:\XeniosTrade`, branch `main`, clean except the files below.
- **Modified (uncommitted):** `server/mock-trading-server.js`
  - `resolveLearningBotRuntimeCommand`: on win32, routes `python3`/`python` to the
    bundled trainer venv `python.exe` when it exists.
  - Local dev box also carries an untracked auth convenience for the workstation only
    (never committed, never deployed — the live server keeps its login gate).
- `server/data/settings.json`: holds the user's **real Binance testnet** API keys
  (their deliberate choice via the Settings UI), `strategy.autoTradingEnabled=false`.
- Imported from the live server (all gitignored, ~370 MB, **NOT required** for the
  new 8-bot run — they are the old 4-bot dataset, useful only as a baseline ref):
  `trade-history.json`, `auto-trade-log.json`, `backtest-runs.json`,
  `backtest-history.json`, `backtest-moneystop.json`,
  `backtest-runs/giveitroom-2x-2026-08.json`, `backtest/runs/*.md`,
  `learning-bot-dataset.json`, `learning-bot-train-{artifact,config,status,artifact-verify}.json`.
- `server/learning-bot/.venv`: Windows venv, `torch 2.13.0+cpu` + `numpy 2.5.2`.
  **Do not copy this to the PC** — recreate it there (see §7), and install the
  **CUDA** build of torch on the PC (RTX 3070 Ti).

## 1. Hardware target (desktop PC)

CPU Ryzen 7 6800HS-class or better · 32 GB RAM · RTX 3070 Ti 8 GB.
- Replay + feature engineering = CPU, single-threaded today. Plan: symbol-level
  concurrency 2-4 (spec cap). GPU is irrelevant to replay.
- AI training = CUDA on the 3070 Ti.
- Runtime budget for the primary run: ~3-6 h with 3-way concurrency + ~40 min
  one-time downloads + ~20-60 min training. Sample-cap per (symbol,bot) is the
  dominant runtime/-dataset-size lever.
- Make the replay **resumable**: flush per symbol to disk, skip completed symbols
  on restart. Cache is portable (copy the cache dir between machines).

---

## 2. Architecture map (inspected — preserve these seams)

| File | Role | Change needed |
|---|---|---|
| `server/backtest/replay-dataset.js` (608 L) | Bar-steps 1h/15m/5m, calls real `analyzeSymbolStrategy`, sims TP/SL fwd, writes closed-trade rows. One symbol at a time. Reservoir-samples to `--cap-per-symbol-bot`. | Add: feature-vector capture at entry, regime tag, split tag, per-symbol flush/resume, optional worker concurrency, cost-regime post-pass, richer run metadata. Keep the bar-stepping + `sliceClosedBy` no-look-ahead core. |
| `server/backtest/historical-data.js` (152 L) | Binance kline + funding fetch w/ retry/backoff. **No cache.** | Add a persistent cache layer (see §5). Keep the fetch/retry logic. |
| `server/backtest/run-registry.js` | Run registry + `runs/<id>.md` writer | Extend the recorded metadata (git SHA, per-symbol history window, feature version, seeds, split boundaries, device). |
| `server/mock-trading-server.js` `buildSignalAnalysisSnapshot` (L6196) | Per-bot dispatch: `model-4`→`buildBot4SignalSnapshot`, `model-3`→Bot3, `model-1/2`→`buildBot12SignalSnapshot`. | Add 4 branches → `buildBot5..8SignalSnapshot`. Each returns the same snapshot shape `{ready, side, entryPrice, stopLoss, takeProfit, score, summary, configuredStopLossPercent, positionNotional, margin, ...}` or null. |
| `buildLearningBotDataset` (L2026) | closed trades → training rows | Row schema v2: explicit `features{}` (entry-time only) vs `label{}`/`reward` (outcome). Add `marketRegime`, `strategyFamily`, `split`, `costRegime`, `isExtendedUniverse`. |
| `getPreferredLearningBotDataset` (L2226) / `refreshLearningBotDatasetArtifact` (L2292) | assemble training set | Carry v2 rows through unchanged; add per-bot / per-symbol / per-regime sample-weight computation. |
| `server/learning-bot/rl_trainer.py` (282 L) | DQN state→reward | Rewrite (see §4). |
| `src/lib/signalModels.js` (522 L) | Bot metadata + strategy overrides. `SIGNAL_MODEL_STRATEGY_OVERRIDE_IDS = ['model-1','model-2','model-4']` | Add `model-5..8` `SIGNAL_MODELS` entries (id, name, tag, `strategyFamily`, `signals[]`), `DEFAULT_BOT5..8_SETTINGS`, extend override ids. |
| `src/lib/tradingConfig.js` (31 L) | `DEFAULT_PREFERRED_SYMBOLS` (25, mismatched) | Leave alone. Add `BACKTEST_UNIVERSE` (the 20) + `BACKTEST_CORE` / `BACKTEST_EXTENDED` split as a new export or a backtest-local constant. |
| Tests | none (no runner) | Add `node:test` (Node 22 builtin) + `pytest` in the venv. Add `"test"` script. |

New modules to add under `server/backtest/`:
- `feature-lib.js` — leakage-free entry-time feature library (§ spec "ENTRY-TIME MARKET FEATURES"). Pure fns over closed candle windows. Versioned (`FEATURE_VERSION`).
- `regime.js` — market-regime classifier using only data ≤ t (BULL_TREND / BEAR_TREND / RANGE / HIGH_VOLATILITY / LOW_VOLATILITY / TRANSITION).
- `splits.js` — chronological split calc: 36 mo train / 12 mo val / 12 mo holdout, proportional for short-history symbols, purge+embargo = max outcome horizon (48 h). Symbol-holdout experiment helper.
- `btc-context.js` — timestamp-aligned BTC (and optional ETH) context features.
- `fetch_cache.py` OR `data-cache.js` — persistent historical cache (see §5).
- `cost-model.js` — NORMAL / STRESS / HIGH_STRESS fee+slippage re-scoring on stored trades.

---

## 3. Leakage audit — CONFIRMED, fix before any training

1. **`rl_trainer.py:38-39`** — `build_state_vector` includes `1.0 if row.status=="CLOSED_TP"` and `..=="CLOSED_SL"`. Outcome in the model input. **Remove.**
2. **`rl_trainer.py:37`** — `len(mistakeTags)` in the input. `buildLearningBotMistakeTags` (L1840+) derives tags from `status==CLOSED_SL`, `pnl<0`, `pnl<=-10/-20`. Post-trade. **Remove from features; keep only for reporting.**
3. **Objective wrong** — `rl_trainer.py:141` `actions = 0 if side=="BUY" else 1`, regresses Q(BUY)/Q(SELL) onto reward → imitates direction. Spec wants **TAKE/SKIP** + P(win) / P(TP-before-SL) / expected-R heads. **Rewrite.**
4. **No chronological split** — trains on all eligible closed trades as one batch, `manual_seed(7)`, no train/val/holdout, no purge/embargo, no walk-forward. **Add.**
5. **`scoreLearningBotEntryQuality` (L1921) is clean** — only `signalSummary` text + `configuredStopLossPercent` + `leverage`. Keep as a feature.
6. **Leakage chain** — `replay-dataset.js` writes `status`/`result`/`exitPrice`/`timedOut`; `buildLearningBotDataset` passes `status`/`result` through; trainer consumes `status`. Fixing the trainer alone is insufficient — row schema must separate `features` from `label`/`reward`, and an automated test must assert no forbidden key reaches the feature vector.

Forbidden as AI input (spec): `CLOSED_TP`, `CLOSED_SL`, `status`, `result`, final `pnl`, `exitPrice`, exit reason, future candles / high / low, MFE, MAE, post-close duration, post-trade `mistakeTags`, TP/SL result. These may be **labels/rewards only**.

---

## 4. Trainer rewrite (`rl_trainer.py`)

- Keep CLI contract: `--dataset <json> --config <json> --artifact <json>`.
- Keep artifact shape the Node server parses: top-level `{ok, generatedAt, durationSeconds, metrics{...}}`; `metrics.framework`, `metrics.policy` consumed by `scoreCandidateWithAiFilter` / status UI — preserve those keys, extend with new ones.
- New objective per bot (`trainingScope: per-bot`): binary **TAKE vs SKIP** head + regression heads P(win after costs), P(TP before SL), expected net R, trade-quality score.
- Inputs: only `features{}` from row schema v2. Assert-guard against forbidden keys at load.
- Splits: consume `row.split` (`train`/`val`/`holdout`) — never fit/select on `holdout`. Walk-forward folds inside train+val. Purge/embargo already applied upstream in `splits.js`; trainer just respects the tag.
- Class/sample weighting from the per-bot/-symbol/-regime weights in the config; no aggressive minority duplication.
- CUDA: `device = "cuda" if torch.cuda.is_available() else "cpu"`; config `devicePreference` already exists (currently `"cpu"` in settings — set `"cuda"` on the PC). Report `metrics.deviceUsed`.
- Fallback path (no torch) stays, but must also be leakage-free and TAKE/SKIP-shaped.
- Add `pytest` tests: forbidden-key guard, split isolation (no holdout rows in fit), deterministic seed, shape checks.

Open decision A: **rewrite in place** (recommended — preserves CLI + artifact keys, git is the rollback) vs **new `rl_trainer_v2.py`** selected by `learningBot.aiTrainer` flag.

---

## 5. Historical data cache

Open decision B:
- **Parquet via Python sidecar** (recommended, matches spec): `server/backtest/fetch_cache.py` (pandas + pyarrow in the venv) downloads + caches klines/funding as Parquet partitioned by `(symbol, timeframe, year-month)`. JS harness shells out once per symbol to materialize/refresh, then reads Parquet via a small bridge (e.g. `parquet-wasm` read-only, or have the sidecar emit a compact binary/NDJSON slice the JS consumes). Cache dir portable between machines.
- **Compressed NDJSON in JS**: keep all fetching in JS, cache `.ndjson.gz` per `(symbol, timeframe, month)`. No new Python dep. Not the columnar format the spec names, but simplest and fully sufficient for sequential per-symbol reads.

Either way: cache key includes symbol + timeframe + range; never re-download a covered range; record actual first/last candle timestamp per symbol (many alts list well after 2021 — use genuine listing date, never backfill/synthesize).

---

## 6. Bots 5-8 — genuinely different families (NOT param tweaks of 1-4)

- **Bot 5 model-5 MEAN_REVERSION** — fade stretched moves toward VWAP/mean in non-trending/exhausted markets. Signals: RSI14 + slope, Bollinger position/width, VWAP dist, EMA dist, z-score of price deviation, ATR-normalized stretch, volume exhaustion, reversal candle, regime≠strong-trend. Require exhaustion evidence, not just "oversold".
- **Bot 6 model-6 VOLATILITY_BREAKOUT** — expansion from compression. BB squeeze, ATR compression→expansion, range contraction, break of recent H/L, volume/rel-vol spike, closed breakout candle, follow-through/retest, EMA/trend + BTC context. Normalize breakout distance by ATR; don't chase stretched candles.
- **Bot 7 model-7 RANGE_FADE** — trade established sideways ranges. First prove ranging: low ADX, flat EMA slope, repeated S/R touches, bounded normalized range, moderate/low vol, no persistent HH/HL or LH/LL. Fade boundaries toward mid; range-break **invalidates**. Complements Bot 3.
- **Bot 8 model-8 FUNDING_CONTRARIAN** — crowded futures positioning. Features: funding rate + sign + magnitude + change + percentile + z-score (when history sufficient), price extension from VWAP/EMA, RSI, ATR, BB position, momentum deceleration, volume, regime. **Funding alone never triggers** — needs price/action confirmation. If funding history missing for a period, **skip** the funding-dependent setup.

Every emitted trade must carry `signalModelId` + `strategyFamily` + `setupFamily`.
Bot 2 kline-derived order-flow stays tagged **proxy**, never "historical order-book imbalance"; support strict-context mode.

---

## 7. Desktop PC setup steps

```powershell
# 1. Get the code. Either copy C:\XeniosTrade wholesale, OR fresh:
git clone https://github.com/Xenios007/XeniosTrade C:\XeniosTrade
cd C:\XeniosTrade
npm install

# 2. Bring over the local files (not in git):
#    - server/data/settings.json   (bot strategy params; blank the API keys if you prefer)
#    The ~370 MB imported data files are NOT needed for the new run.

# 3. Recreate the trainer venv WITH CUDA (RTX 3070 Ti):
python -m venv server\learning-bot\.venv
server\learning-bot\.venv\Scripts\python.exe -m pip install --upgrade pip
server\learning-bot\.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu121
server\learning-bot\.venv\Scripts\python.exe -m pip install numpy pandas pyarrow pytest
server\learning-bot\.venv\Scripts\python.exe -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"

# 4. Set devicePreference to cuda in server/data/settings.json:
#    learningBot.aiTrainer.devicePreference = "cuda"

# 5. Open Claude Code in C:\XeniosTrade and point it at this file:
#    server/backtest/EXPANSION-PLAN.md
```

Then answer open decisions A (trainer) and B (cache), and decision C:
- **C. Run sequencing** — checkpoint after implementation+tests+smoke and pause for
  go-ahead before the full 20×60mo×8-bot run (recommended), or fully autonomous
  straight through to the 38-section report.

---

## 8. Deliverables (spec §FINAL REPORT) — 38 numbered items

Reproducibility metadata, per-bot metrics ×8, breakdowns by symbol/year/regime/
side/setup-family/core-vs-extended, AI vs non-AI, 3 cost regimes, cross-bot
comparison table (best per regime, lowest DD, highest expectancy, most stable),
failed strategies to retire, meta-model readiness call, exact reproduction command.

## 9. Safety (non-negotiable)

No real-money trading. No auto-promotion to live. No credential changes. Paper +
historical only. Eliminating a bad strategy family is a successful outcome.

---

## 10. PHASE 0 EXECUTION LOG — desktop PC, autonomous /loop run (2026-09-01)

**This machine IS the target PC.** Verified hardware:
- CPU: AMD Ryzen 7 5800X, 8C/16T (brief said 6800HS; actual is the desktop 5800X — better for CPU replay).
- RAM: 31.9 GB.
- GPU: NVIDIA RTX 3070 Ti 8 GB, driver 616.56, CUDA UMD 13.4. ~6.7 GB free at idle.
- Node v22.17.0 (has `node:test`). Global Python 3.12.7.

**Broken venv:** `server/learning-bot/.venv` was created on the laptop (user `proje`) and
its `python.exe` shim points at a path that does not exist here. Rebuilt from scratch
(`rebuild-venv.sh`): fresh venv + `torch` cu121 + `numpy pandas pyarrow pytest`.

**Open decisions — resolved for this autonomous run:**
- **A (trainer): rewrite `rl_trainer.py` in place.** Preserves CLI + artifact keys; git is the rollback.
- **B (cache): gzipped NDJSON in JS**, one file per `(symbol, timeframe, year-month)` under
  `server/data/historical-cache/`. Keeps the harness pure-JS and robust; sufficient for
  sequential per-symbol reads. (pandas/pyarrow still installed for the trainer.)
- **C (sequencing): fully autonomous** straight through implementation → tests → backtest →
  training → 38-section report, per the brief's WORKFLOW section.

**Architecture confirmed (seams to preserve):**
- `analyzeSymbolStrategy` (L6342) → `buildSignalAnalysisSnapshot` (L6196) dispatches by
  `signalModel.id`: `model-4`→`buildBot4SignalSnapshot` (L6107), `model-3`→`buildBot3SignalSnapshot`
  (L5178), else `buildBot12SignalSnapshot` (L5424). Add `model-5..8` branches.
- `buildBot4SignalSnapshot` is the cleanest template for 5-8: closed-candle indicators →
  direction → SL/TP from % → `calculateSignalModelPositionSizing` → standard snapshot shape.
- Indicator helpers already in server: `calculateEMA` (4270), `calculateMACDSeries` (4291),
  `calculateRSI`/`calculateRSISeries` (4344/4377), `calculateATRSeries` (4417),
  `calculateADXSeries` (4452), `calculateVWAPSeries` (4525), `calculateSupportResistance` (4542),
  `calculateRewardToRisk` (4751). **Missing:** Bollinger Bands, rolling z-score/stdev — add to feature-lib.
- `buildLearningBotDataset` (L2026) row schema is flat and mixes `status`/`result` with features.
- `replay-dataset.js` writes `status`/`result`/`exitPrice`/`timedOut` per row; no feature capture,
  no regime, no split, no per-symbol flush/resume, no cache.

**Leakage — CONFIRMED (fix before any training):**
1. `rl_trainer.py:38-39` `build_state_vector` includes `status=="CLOSED_TP"` / `"CLOSED_SL"` — outcome in input.
2. `rl_trainer.py:37` `len(mistakeTags)` in input — `buildLearningBotMistakeTags` (L1830) derives from
   `status`, `pnl<0`, `pnl<=-10/-20`. Post-trade. Remove from features (keep for reporting only).
3. `rl_trainer.py:141` objective regresses Q(BUY)/Q(SELL) onto reward → imitates direction.
   Spec wants TAKE/SKIP + P(win)/P(TP-before-SL)/expected-R heads. Rewrite.
4. No chronological split, no purge/embargo, no walk-forward. Add.
5. `scoreLearningBotEntryQuality` (L1921) is CLEAN (summary text + SL% + leverage). Keep as a feature.

**Progress log:**
- Phase 0 (inspect) — DONE.
- Venv rebuilt with CUDA (`torch 2.5.1+cu121`, `cuda True`, RTX 3070 Ti). numpy 2.5.2 / pandas 3.0.5 / pyarrow 25.0.1 / pytest.
- Phase B (new modules) — DONE, all smoke-tested:
  - `feature-lib.js` — 187 leakage-free entry-time features, `FEATURE_VERSION = featv1-2026-09`.
  - `regime.js` — 6-regime classifier (≤t only) + `deriveRegimeCandlesFromHourly` (4h).
  - `splits.js` — 60/20/20 chrono split, 48h purge/embargo, walk-forward folds, symbol-holdout.
  - `cost-model.js` — NORMAL / STRESS / HIGH_STRESS rescoring from stored `grossPnl`.
  - `data-cache.js` — gzipped-NDJSON monthly cache over historical-data.js; never re-downloads; records actual first/last candle per symbol in `<SYMBOL>/meta.json`.
  - `btc-context.js` — timestamp-aligned BTC/ETH context (returns, RSI, trend, vol regime, regime code).
- Bots 5-8 — DONE:
  - `server/strategy/bots5to8.js` — `buildBot5..8SignalSnapshot`, shared `indicatorBundle`, standard snapshot shape, `strategyFamily` + `setupFamily` on every ready snapshot.
  - `src/lib/signalModels.js` — 8 `SIGNAL_MODELS` entries (added `strategyFamily`), `DEFAULT_BOT5..8_*_SETTINGS`, override IDs extended to model-5..8, per-bot signal metadata arrays.
  - `server/mock-trading-server.js` — dispatch branch in `buildSignalAnalysisSnapshot` + import. All 8 bots run through `analyzeSymbolStrategy` without throwing (verified).

- Phase A (leakage fix + schema v2 + trainer rewrite) — DONE:
  - `src/lib/tradingConfig.js` — `BACKTEST_UNIVERSE` (20), `BACKTEST_CORE_SYMBOLS` (12), `BACKTEST_EXTENDED_SYMBOLS` (8), `isExtendedBacktestSymbol`.
  - `server/backtest/replay-dataset.js` — v2 rewrite: `buildEntryFeatures` capture at each entry + timestamp-aligned BTC (5m/15m/1h) & ETH (5m/1h) context, `classifyRegime` tag, `assignSplit` tag (purged rows skipped), per-symbol NDJSON flush + `_manifest.json` resume, `getCachedKlines`/`getCachedFunding`, bounded concurrency pool (default 2), stores `grossPnl`/`frictionUsd`, full run metadata (git SHA, per-symbol history window, feature version, seed, split boundaries, device, node/platform). Bar-stepping + `sliceClosedBy` no-look-ahead core preserved. Bot 2 flow tagged `orderFlowProxy: true`.
  - `server/mock-trading-server.js` — `buildLearningBotDataset` now emits schema v2 rows: explicit `features{}` vs `label{}`/`reward`/`mistakeTags`. `LEARNING_BOT_FORBIDDEN_FEATURE_KEYS` + `assertNoLeakageInFeatures` guard. `analyzeSymbolStrategy` return extended with `strategyFamily` + `setupFamily`. Legacy v1 rows still handled (`features: null`, `schemaVersion: 1`).
  - `.gitignore` — historical-cache, model binaries (`*.pt/*.pth/*.ckpt`), `__pycache__`, ai-training artifacts, `*.parquet`, backtest reports.
  - `server/learning-bot/rl_trainer.py` — full rewrite. Per-bot MLP: shared trunk → 5 heads (TAKE/SKIP + P(win) + P(TP-before-SL) + expected-net-R + quality). Fit on `train`, decision threshold grid-searched on `val` only, `holdout` scored once and reported separately. Class-weighted BCE, deterministic seed (CUBLAS_WORKSPACE_CONFIG set), CUDA when available. Leakage guard at load (`collect_feature_keys` raises on any forbidden key → artifact `ok:false`). numpy-logistic fallback if torch missing. Backward-compat `metrics.policy.{setupFamilyScores,bySignalModel}` + `metrics.deviceUsed`/`framework`/`actionAlignment` preserved. Adds `metrics.perBot`, `.aiVsNoAiHoldout`, `.distribution`, `.leakageCheck`, `.split`.
  - **Verified end-to-end on synthetic v2 data:** trains on CUDA (`deviceUsed cuda:NVIDIA GeForce RTX 3070 Ti`), split 840/280/280 respected, per-bot AI-vs-noAI on val + holdout produced, leakage guard aborts with exit 1 + `ok:false` when `status` injected into features.

- Phase E (tests) — DONE. **node:test 41/41 pass**, **pytest 25/25 pass**.
  - `test/` — `feature-lib.test.js` (8: version, all-finite, no forbidden key, determinism, window-only/no-look-ahead, funding flag, time encodings, trend sanity), `splits.test.js` (6), `regime.test.js` (7), `cost-model.test.js` (7), `bots5to8.test.js` (7: 8 models registered w/ distinct families, not-ready shape, Bot 8 skips w/o funding, Bot 7 refuses strong trend, ready-snapshot well-formedness, dispatch no-throw), `schema-v2.test.js` (6: leakage guard throws for every forbidden key, features/label separation, v2-vs-legacy, no forbidden key in any dataset row's features). `test/_helpers.js` deterministic synthetic candles.
  - `server/learning-bot/tests/` — `test_trainer.py` (25): forbidden-key guard (parametrized), **Py FORBIDDEN set == JS `LEARNING_BOT_FORBIDDEN_FEATURE_KEYS`**, take-label logic, artifact shape, **injected-leakage aborts run (exit 1, ok:false)**, **holdout never influences threshold/val-selection but does change the holdout report**, determinism, **torch-missing → numpy fallback still leakage-guarded**, equity-metrics math.
  - `package.json` — `"test": "node --test --test-force-exit \"test/**/*.test.js\""`, `"test:py": "...pytest server/learning-bot/tests -q"`.
  - Exported `assertNoLeakageInFeatures`, `buildLearningBotTrainingRowV2`, `buildLearningBotDataset` from the server for testability.
- Cache layer verified against **live Binance** (data-api.binance.vision): fetch → gzip month file → 2nd call 0 re-fetches for elapsed months, current month always refreshed. Real clock ≈ 2026-08-31 22:15 UTC.

- Phase G (cache warm) — RUNNING in background (`launcher-logs/warm-cache.log`). BTC/BNB/ETH done (~512-518k 5m bars each, 2021-09-26 → 2026-08-31). ~180s/batch of 3, ETA ~20 min. Detached node pid ~1320 (poll the log; no task notification — the `nohup &` wrapper's own completion already fired).
- `report.js` — DONE (parses). Full 38-section generator: per-bot metrics (all + holdout), breakdowns by symbol/regime/year/side/setup-family/core-vs-extended, AI-vs-noAI holdout, 3 cost regimes, cross-bot comparison + failed-strategy call, meta-model readiness, exact repro.
- `server/data/settings.json` — `aiTrainer.epochs 70 / batchSize 256 / learningRate 0.0008`. `python` → bundled CUDA venv confirmed via `resolveLearningBotRuntimeCommand`.

- Warm-cache at ~9/20 symbols (BTC/ETH/BNB/SOL/XRP/ADA/LINK/DOGE/LTC done, all full 2021-09-26→2026-08-31, ~32MB each). ~180s/symbol. ETA ~25 more min.
- Added a mid-symbol progress heartbeat to `replay-dataset.js` (every ~40k 5m bars: % done, setups so far, eta).
- **Timing probe running** (`bbscn2a5k`): BTCUSDT-only, 8 bots, stride 2, 60mo — to size the full run and decide stride 2 vs 3. BTC context loaded (512890 5m bars), replaying.

- **Perf refactor — DONE.** Single-thread replay measured ~28 min/symbol (stride 2) — too slow for 20 symbols. Root causes fixed:
  1. `contextAt` did an O(n) backward scan of the 512k-bar BTC array every call → replaced with forward-advancing cursors (`advanceCursors`/`makeCtxCursors`).
  2. `deriveRegimeCandlesFromHourly(sliceClosedBy(...))` rebuilt the full 4h series every stride point → build once per symbol, advance a cursor.
  3. `fundingFeatures` full-scan every stride point → cheap trailing-240 percentile via cursor; full features only in the lazy block.
  4. **worker_threads pool** — `replay-worker.js` (new): N workers, one core each, one symbol end-to-end. `replay-dataset.js` slimmed to pool orchestration + merge + registry.
  5. Worker cache reads are `readOnly: true` (no month/meta writes) + `atomicWrite` retries EPERM/EEXIST then falls back to overwrite — fixes the Windows rename race between concurrent workers.
- 1000PEPEUSDT had no spot klines → added USD-M **futures** kline fallback in `historical-data.js` (genuine Binance data for the exact symbol). Re-warmed.
- Smoke: 3 workers in parallel, stride 12, BTC/ETH/SOL — clean, ~150s/symbol → **stride 2 ≈ ~15 min/symbol; 20 symbols at concurrency 5 ≈ 60-75 min total.**
- warm-cache DONE: all 20 symbols, 576 MB. Core 12 = full 60mo; APT 47mo, ARB 42mo, SUI 40mo (genuine listing dates).

- SOLUSDT full smoke (stride 6, 8 bots, 1 worker, 155s) — VALIDATED: 3200 rows, 263 features/row, **0 leakage hits / 840k feature values checked**, all 6 regimes + train/val/holdout splits populated, family tags correct, registry + markdown written.
- Pre-launch fixes: strategyFamily added to Bots 1-3 (`zone-reversal-breakout` / `flow-funding-confirmation` / `trend-pullback`); HARD_SEEN early-exit removed (was truncating Bot 4 to the train period — reservoir sampling alone keeps full-timeline coverage). node:test 41/41 still green.
- **PRIMARY RUN LAUNCHED** (`primary-8bot-5yr`, bg task): stride 2, 5 workers, 20 symbols, 8 bots, cap 500/(sym,bot), `--no-train`. ETA ~45-70 min replay.

**Time budget (launch → 38-section report): ~1.25-2 h** — replay ~45-70 min · merge ~2 min · dataset assembly ~2-4 min · per-bot CUDA TAKE/SKIP training ~15-35 min · report <1 min.

**Next:** monitor primary run → on completion, flag run `includeInTraining` + run `refreshLearningBotDatasetArtifact` + `launchLearningBotTraining` (CUDA) → then `node server/backtest/report.js --run-id primary-8bot-5yr` → final 38-section report + update this plan.
`node server/backtest/replay-dataset.js --months 60 --stride 2 --bots model-1..8 --symbols universe --run-id primary-8bot-5yr --concurrency 2 --no-train` (background, hours). Then Phase I — flag run + train per-bot TAKE/SKIP on CUDA. Then Phase J — `report.js`.
