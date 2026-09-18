# Backtest replay — AI dataset harness

Generates AI training rows by replaying the **real** signal engine over historical
Binance klines, so the learning bot has statistics to work with without waiting
months for live paper trades.

## What it does

1. Pulls `--months` of 1h / 15m / 5m klines (+ funding-rate history) per symbol,
   one symbol at a time (bounded memory).
2. Steps bar-by-bar on the 5m timeframe. At each step it slices every timeframe
   to only bars **closed by that moment** (no look-ahead) and calls the actual
   `analyzeSymbolStrategy` from `mock-trading-server.js`.
3. Every time a bot would have entered, it simulates the trade forward to TP / SL
   (SL wins same-bar ties; Bot 4 also gets its −1 USDT money-stop; force-close
   after `--max-hold-hours`), applies fee + slippage, and writes a closed-trade
   record in the same shape the live system produces.
4. Rows go to `server/data/backtest-history.json` with `source: "AUTO_BACKTEST"`,
   `mode: "backtest"`. `getPreferredLearningBotDataset()` merges them into the
   training set when `learningBot.includeBacktestData` is true (default). They
   are **never** read into account balances, the journal, or the UI.
5. Prints a per-bot summary (rows / win% / total pnl / expectancy) then, unless
   `--no-train`, launches AI training on the merged dataset.

## Run

```
npm run backtest:dataset -- --months 6 --bots model-1,model-2,model-3,model-4
```

## Statistical volume, AI-score, and exit study

For a reproducible five-year, 20-symbol research run that records actual
Binance candle volume, taker-buy flow, and multiple candle-only exit policies:

```sh
npm run backtest:dataset -- --months 60 --symbols universe --bots model-1,model-2,model-3,model-4,model-5,model-6,model-7,model-8 --stride 2 --concurrency 3 --cap-per-symbol-bot 400 --run-id statistical-5yr-20sym-v1 --no-train
npm run backtest:statistical-review -- --run-id statistical-5yr-20sym-v1
```

The review fits its AI-style expected-R tree only on the chronological train
split, uses a fixed 0.10 R gate, compares actual-volume filters, and ranks
exit policies by validation data before displaying the holdout. It writes JSON
to `server/data/backtest-research/` and a readable report under
`server/backtest/runs/`. It does not update the deployed bot, turn on training,
or establish a profitable edge.

Exit variants are source brackets, 1R / 1.5R targets, breakeven after 1R, and
12h / 24h time stops. They use 5m OHLC only; stop wins same-bar ties, and no
historical order-book depth is invented.

### Flags

| flag | default | meaning |
|---|---|---|
| `--months N` | 6 | history depth |
| `--bots a,b,c` | all non-blank | signal models to replay |
| `--symbols preferred\|X,Y` | current `preferredSymbols` ∪ defaults | symbol list |
| `--step 5m` | 5m | evaluation + forward-sim cadence |
| `--stride N` | 1 | evaluate every Nth 5m bar (use 2–3 for big runs) |
| `--fee-bps N` | 5 | taker fee per side (bps) |
| `--slippage-bps N` | 2 | slippage per side (bps) |
| `--max-hold-hours N` | 48 | force-close unresolved trades |
| `--strict-context` | off | zero the order-book / funding context instead of proxying it |
| `--append` | off | add to existing `backtest-history.json` instead of replacing |
| `--no-train` | off | write the file but do not launch training |
| `--out <path>` | `server/data/backtest-history.json` | output file |

## Caveats (this is a bootstrap, not an edge proof)

- **Order-book imbalance** has no historical source. Bots 1 & 2 use it; here it
  is a proxy from kline taker buy/sell volume. Use `--strict-context` for a
  conservative run. Bots 3 & 4 do not use it and are higher fidelity.
- **Funding rate** is real (Binance `/fapi/v1/fundingRate` history).
- Same-bar TP+SL is resolved as SL (slightly pessimistic).
- Single market regime → skewed policy. Span ≥ 12 months across different
  regimes if you can.
- 1m exit precision is not modelled — TP/SL detection is at 5m resolution.
- Fees/slippage are flat bps, not tiered or symbol-specific.

The `--strict-context` run and a normal run make a useful A/B.

## How it stays out of the live server

`replay-dataset.js` sets `XENIOS_SERVER_AUTOSTART=off` before dynamically
importing `mock-trading-server.js`, so that module's HTTP listener and
background timers do not start. It only calls exported pure functions
(`analyzeSymbolStrategy`, `toCandleData`, `getSettings`,
`refreshLearningBotDatasetArtifact`, `launchLearningBotTraining`).
