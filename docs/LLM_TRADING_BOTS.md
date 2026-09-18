# LLM trading bots (Wallets 11-15)

Five bots that compare how different frontier models trade the same market data. Unlike Bots 1-10, there is no hand-coded technical rule set behind any of them — every entry decision comes from a live call to that bot's model provider.

| Wallet | Bot | Signal model | Provider | Default model |
|---|---|---|---|---|
| 11 | Bot Claude | `model-11` | Anthropic | `claude-opus-5` |
| 12 | Bot GPT | `model-12` | OpenAI | `gpt-4.1-mini` |
| 13 | Bot Gemini | `model-13` | Google (OpenAI-compatible endpoint) | `gemini-2.0-flash` |
| 14 | Bot Grok | `model-14` | xAI (OpenAI-compatible endpoint) | `grok-2-latest` |
| 15 | Bot OpenRouter | `model-15` | OpenRouter (aggregator) | `meta-llama/llama-3.3-70b-instruct` |

All five run inside the normal wallet/bot roster (small 100 USDT allocation each, same Binance Futures Testnet execution path as Bots 1-10), not as a separate isolated account like the Consolidated Bot.

## Requirements

Each bot stays in a "watching" state and never calls its API or trades until its provider key is configured. Two ways to configure it, checked in this order:

1. **AI Models page** (`/ai-models` in the app, Config → AI Models) — paste a key, optional base URL, optional model id per provider through the UI. Stored server-side in `settings.json` (masked the same way as the Binance credentials — never sent back to the browser), and covers all 23 providers in `src/lib/aiProviders.js`, not just the five wired to a bot, so a key can be saved ready for a bot added later. This is the normal way to set these up.
2. **`.env`** (see `.env.example` — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, plus per-bot model/base-URL overrides) — a fallback for whichever field the AI Models page doesn't have a value for. Useful for a fresh deploy before anyone has opened the page.

`server/strategy/ai-provider-credentials-store.js` is the in-memory mirror every bot reads from; `mock-trading-server.js` refreshes it every time `getSettings()` runs.

## How they decide — identical across all five, on purpose

A head-to-head "which model trades better" comparison is only meaningful if every bot is judged on the same footing. All five share one engine (`server/strategy/llm-trading-engine.js`):

1. **Same fixed universe.** Each bot's `fixedUniverseSymbols` (`src/lib/signalModels.js`) scans only BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT — never the full volatility-ranked universe. This bounds live-API spend and keeps the comparison apples-to-apples.
2. **Same schedule.** Once per wallet scan cycle (every 5 minutes), and only for symbols whose 5M candle has closed since the last call, `refreshDecisions` builds a multi-timeframe feature snapshot (regime, RSI, ATR, Bollinger, VWAP, volume, funding — the same `indicatorBundle` Bots 5-9 use) and calls that bot's provider for a structured decision.
3. **Same prompt content.** `buildLlmTradeUserPrompt` / `buildLlmTradeSystemPrompt` produce byte-identical market data and instructions for every bot; only the system message's self-reference (its own label) differs.
4. **Same decision shape.** `action` (LONG/SHORT/WAIT), `confidence` (0-100), `stopLossPercent`, `takeProfitPercent`, `reasoning`. Stop/target are always **percentages off the current close**, never an absolute price, so a hallucinated price level can't become a wildly wrong stop or target.
5. **Same cache/gating.** The decision is cached per symbol, keyed to that candle's close time, so a manual "Scan now" click can't multiply API spend. A trade is only taken when the cached decision is fresh, is LONG or SHORT, and confidence is at or above 60 (`LLM_TRADE_MIN_CONFIDENCE`).
6. **Same risk footprint.** All five use `DEFAULT_LLM_BOT_SETTINGS` in `signalModels.js` — identical margin/leverage/daily caps — so a difference in results is about the model's calls, not different risk sizing.

The only thing that differs between bots is *how* the API is called:

- **Bot Claude** (`server/strategy/bot-claude.js`) uses the official `@anthropic-ai/sdk`, with strict JSON-schema structured output (`beta.messages.parse` + `output_format`).
- **Bot GPT / Bot Gemini / Bot Grok / Bot OpenRouter** (`bot-gpt.js` / `bot-gemini.js` / `bot-grok.js` / `bot-openrouter.js`) all call the same shared `requestOpenAiCompatibleTradeDecision` (`server/strategy/openai-compatible-client.js`) against their provider's OpenAI-compatible Chat Completions endpoint, using JSON-object mode plus a prompt that spells out the exact required shape (schema-constrained structured output isn't uniformly supported across these providers).

## Files

- `server/strategy/shared-signals.js`: indicator bundle + snapshot shaping (`sizeAndShape`/`notReady`), shared by Bots 5-9 and every LLM bot.
- `server/strategy/llm-trading-engine.js`: the shared engine every LLM bot is built on — prompt content, decision cache (in-memory + `server/data/<bot-id>/decisions.json`, gitignored), gating, and the synchronous snapshot builder.
- `server/strategy/openai-compatible-client.js`: the shared fetch-based client for any OpenAI-compatible provider (GPT, Gemini, Grok, OpenRouter).
- `server/strategy/bot-claude.js` / `bot-gpt.js` / `bot-gemini.js` / `bot-grok.js` / `bot-openrouter.js`: each is a thin wrapper — only "how to call this provider" — around the shared engine.
- `src/lib/signalModels.js` / `src/lib/wallets.js`: `model-11..15` / `wallet-model-11..15` registry entries — the rest of the UI (BotStatusGrid, SettingsPage, WalletsPage) is registry-driven and needed no bot-specific changes; `SignalInsightsPanel.jsx` and `LearningBotPage.jsx` have small hardcoded bot-label maps that were updated to include them.
- `src/lib/aiProviders.js`: the 23-provider catalog + credential normalize/merge logic behind the AI Models page, shared by client and server.
- `server/strategy/ai-provider-credentials-store.js`: the in-memory credential mirror every bot reads (`getAiProviderCredential(providerId)`).
- `src/components/AiModelsPage.jsx` (`/ai-models`): the page itself — a provider grid + connect modal (Providers & Keys) and a status summary for the five wired bots (Bot Assignments).
- `test/llm-trading-engine.test.js`: covers the shared engine and OpenAI-compatible client against a fake provider (no real network calls).
- `test/aiProviders.test.js`: covers the credential normalize/merge logic, including that a blank field never wipes a stored key and an update to one provider never touches another's.

## Adding another provider

The pattern is the same for any new OpenAI-compatible provider: a new `model-1N` in `signalModels.js` (reuse `buildLlmModelSignals` / `DEFAULT_LLM_BOT_SETTINGS` / `LLM_TRADE_FIXED_UNIVERSE_SYMBOLS`), a new `wallet-model-1N` in `wallets.js`, a new `server/strategy/bot-<name>.js` (copy `bot-gpt.js` — env vars + `requestOpenAiCompatibleTradeDecision` call), one line added to `BOT5TO8_BUILDERS` in `bots5to8.js`, and one entry added to `LLM_BOT_DECISION_REFRESHERS` in `mock-trading-server.js`. A genuinely different API shape (not OpenAI-compatible) instead follows `bot-claude.js`'s pattern: its own `requestDecision`, still built on the same `createLlmTradingBot` engine.
