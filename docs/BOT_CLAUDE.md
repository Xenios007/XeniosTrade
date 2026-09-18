# Bot Claude (Wallet 11 / model-11)

The first of a planned family of LLM-driven bots — Bot Claude, then Bot GPT / Bot Gemini / Bot Grok — meant to compare how different frontier models trade the same market data. Unlike Bots 1–10, there is no hand-coded technical rule set: every entry decision comes from a live call to the Anthropic Claude API.

It runs inside the normal wallet/bot roster (Wallet 11, small 100 USDT allocation, same Binance Futures Testnet execution path as Bots 1–9), not as a separate isolated account like the Consolidated Bot.

## Requirements

Set `ANTHROPIC_API_KEY` in `.env` (see `.env.example`). Without it, Bot Claude stays in a "watching" state and never calls the API or trades. Optionally set `ANTHROPIC_BOT_CLAUDE_MODEL` to override the model (defaults to `claude-opus-5`).

## How it decides

1. Scan universe is fixed and small — BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT — so the live API is only ever called for a handful of symbols, not the full volatility-ranked universe.
2. Once per wallet scan cycle (every 5 minutes, matching the existing scheduled auto-trader), and only for symbols whose 5M candle has closed since the last call, `refreshBotClaudeDecisions` (`server/strategy/bot-claude.js`) builds a multi-timeframe feature snapshot (regime, RSI, ATR, Bollinger, VWAP, volume, funding — the same `indicatorBundle` Bots 5–8 use) and calls the Claude API for a structured decision: `action` (LONG/SHORT/WAIT), `confidence` (0–100), `stopLossPercent`, `takeProfitPercent`, and `reasoning`.
3. The decision is cached per symbol, keyed to that candle's close time, so a manual "Scan now" click can't multiply API spend.
4. `buildBotClaudeSignalSnapshot` — the function actually wired into the per-symbol dispatch (`BOT5TO8_BUILDERS['model-11']`) — stays synchronous and only reads that cache. A trade is only taken when the cached decision is fresh, is LONG or SHORT, and confidence is at or above 60.
5. Stop-loss/take-profit are always expressed as **percentages off the current close**, never an absolute price, so a hallucinated price level can't become a wildly wrong stop or target.

## Files

- `server/strategy/shared-signals.js`: indicator bundle + snapshot shaping (`sizeAndShape`/`notReady`), shared by Bots 5–9 and Bot Claude to avoid a circular import between `bots5to8.js` and `bot-claude.js`.
- `server/strategy/bot-claude.js`: the Claude API call, decision cache, and synchronous snapshot builder.
- `server/data/bot-claude/decisions.json`: on-disk cache (gitignored, runtime state only).
- `src/lib/signalModels.js` / `src/lib/wallets.js`: `model-11` / `wallet-model-11` registry entries — the rest of the UI (BotStatusGrid, SettingsPage, WalletsPage) is registry-driven and needed no bot-specific changes; `SignalInsightsPanel.jsx` and `LearningBotPage.jsx` have small hardcoded bot-label maps that were updated to include it.

## Adding Bot GPT / Bot Gemini / Bot Grok

Each sibling bot is the same pattern: a new `model-1N` in `signalModels.js` (+ `fixedUniverseSymbols`, default risk settings), a new `wallet-model-1N` in `wallets.js`, a new `server/strategy/bot-<name>.js` that calls that provider's API and returns the same LONG/SHORT/WAIT + confidence + percent-based risk shape, and one line added to `BOT5TO8_BUILDERS` in `bots5to8.js`. No changes needed to the wallet scan/execution loop itself beyond the one `if (walletSignalModelId === 'model-1N') await refresh...()` hook already added for Bot Claude in `mock-trading-server.js`.
