# Consolidated bot

Open `/consolidated-bot` in XeniosTrade. The bot has a separate simulated account and an optional Binance Futures testnet adapter. It is not assigned to any of the existing eight wallets. Real-money orders are unavailable.

## Actual testnet execution

The VPS registers `getTestnetCredentials` using only existing TESTNET credentials. The adapter pins all requests to `https://demo-fapi.binance.com`; it never falls back to paper fills. See [Binance general information](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info) and [trade API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

Enable/pause actual testnet entries on the consolidated page. This mode persists across restarts, while paper entries restart paused. Both are independently controlled. A manual scan can execute a qualifying fresh signal if testnet is enabled. The adapter allows one position, 1x isolated leverage, 100 USDT maximum notional, 1 USDT modeled stop risk, three trades per UTC entry day, and a 3 USDT realized-loss cutoff. These are entry limits, not guaranteed maximum losses. It refuses occupied symbols or outstanding exchange orders and serializes entries with existing exchange execution. One-way mode is required; account mode is never changed automatically.

Orders have durable unique client IDs. Unknown entry results remain blocked pending reconciliation. Confirmed fills receive reduce-only stop-market and take-profit-market algo orders. Protection failures pause entries and attempt a reduce-only emergency close; failures remain visible for operator review. No other bot's position is intentionally closed. External changes to owned exposure pause entries. A 48-hour timeout attempts closure. Exchange history records realized P&L minus USDT commissions, excluding funding and non-USDT commissions.

Runtime state is `server/data/consolidated/testnet-state.json`; never replace or delete it while an order is pending or a position is open. Deploy model/report artifacts together, but never upload local runtime state. Do not train on the production VPS or start a second server against its live data directory. Back up targeted code and frontend assets before deployment; preserve newer server code and settings/recovery files.

## Current result

The first policy is **research-only**. Its 298 selected final-year opportunities had a 34.23% win rate, 0.745 net-R profit factor, and -0.197 R average return. Higher costs worsened the result. No profitable edge has been established. The implementation exposes this result and leaves paper entries paused.

See `CONSOLIDATED_BOT_ANALYSIS.md` for the analysis and `server/data/consolidated/report.json` for the complete audit, trial results, feature contrasts, and secondary checks.

## Signal construction

1. Run the original eight source engines against closed candles. Use 301 five-minute candles, 161 fifteen-minute candles, and 161 hourly candles, matching the replay windows.
2. Preserve each source engine's setup requirements. Historical order-book behavior is matched with the same taker-volume proxy; Bot 8 requires genuine funding history.
3. Build an explicit entry-only vector: source identity, direction, stop distance, and momentum, volatility, trend, volume, candle, range, and VWAP features across three timeframes. No trade outcome, realized P&L, or future price enters this vector.
4. Apply the frozen decision tree and research threshold. Show the complete decision path, training sample count, and expected R for each candidate. This expectation is a training estimate, not a probability or a promised return.
5. Rank accepted candidates by their prediction, with deterministic tie-breaking. Allow only one open paper position across the consolidated account.

The initial paper scan universe is BTCUSDT, ETHUSDT, SOLUSDT, and BNBUSDT. The offline training sample covers 20 symbols. The paper scan is intentionally smaller and should not be confused with a full-universe replication of the historical test.

## Controls

- **Scan signals:** evaluate all eight engines on the four current markets. While paper mode is paused, this does not open a position.
- **Start paper research:** enable simulated entries. Scan every 15 seconds; enter only within 30 seconds of a newly closed five-minute bar. A simulated fill uses the new bar's open. This is an approximation, not an executable exchange fill guarantee.
- **Pause paper entries:** stop new entries. Continue checking an existing paper position until its stop, target, or 48-hour timeout.
- Restarting the server pauses new entries. The existing paper position and history remain on disk.

The account starts with 1,000 simulated USDT, uses at most 100 USDT notional, and sizes toward a 1 USDT stop risk including modeled round-trip costs. Gaps can exceed that risk estimate. Stops win same-bar stop/target ties. Modeled cost is 5 basis points fee plus 2 basis points slippage on each side. Funding settlements and intrabar execution are not simulated.

## Reproduce

```sh
npm run consolidated:train
npm test
npm run build
npm run dev:all
```

Training reads the local backtest sources; it does not download or regenerate them. It creates `server/data/consolidated/model.json`, `report.json`, and the analysis document. It fails if required primary data or chronological coverage is missing. Keep the generated model and report together when moving the project to another machine.

The source fingerprint identifies the primary entries, labels, and model input vectors. Training is deterministic for those inputs. The first period ends September 2024, validation ends September 2025, and the final period follows afterward, with 48-hour purges at both boundaries. Additional runs and legacy records are audited separately; they are not pooled into fitting. Sampled records are not a complete consolidated portfolio replay.

## Files

- `server/strategy/consolidated-model.js`: shared input schema and inference.
- `server/backtest/train-consolidated.js`: chronological fitting, validation, and report generation.
- `server/backtest/consolidated-audit.js`: strict streaming reads and statistics.
- `server/consolidated-bot.js`: isolated API and paper-position lifecycle.
- `src/components/ConsolidatedBotPage.jsx`: evidence, signals, rules, and paper account.
- `test/consolidated*.test.js`: feature leakage, temporal purging, arbitration, paper exits, and API integration.
