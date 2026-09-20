# AI Trading (4-agent entry pipeline + Position Manager)

An on-demand pipeline that vets one trade idea and returns Trade / No Trade with an audit trail per stage. It is **not a bot**: no signal model, no auto-trade loop, and **the pipeline itself never places an order**. An *approved* run can then be opened on the AI's own testnet / real-money wallet (see "Wallets, trading modes and execution" below). UI: `/ai-trading` (Pipeline, Run History; there is no Risk Limits page — risk is decided by the Risk Manager model); provider/model per agent: `/ai-models/agents`. On the public site this lives at **ai.projxenios.trade**; the bots live at **bot.projxenios.trade** (same build and backend, hostname-selected — see `src/lib/appMode.js`, `deploy/nginx/enable-subdomains.sh`).

```
Market Data -> Market Analyst -> Market Flow Agent -> Critic -> Risk Manager (final entry approver) -> Trade / No Trade
                                                                                    \-> Position Manager (after entry, repeated AI review)
```

| Agent | Kind | What it does |
|---|---|---|
| Market Analyst | LLM | Reads the multi-timeframe indicator snapshot (same `indicatorBundle` the LLM bots use, plus 1H/15M structure). Returns LONG / SHORT / HOLD, confidence, regime, proposed stop/target %. |
| Market Flow Agent | LLM | Judges derivatives positioning and order flow the chart can't show: funding and mark/index basis, open interest vs price (with a code-computed regime label: new longs / short covering / new shorts / long liquidation), long/short account and top-trader ratios, futures taker flow, order book depth, and BTC's move for alts. Returns SUPPORTS / NEUTRAL / AGAINST, a crowding level, and flags that cite the numbers. |
| Critic | LLM | Adversarial: only looks for reasons to reject. PASS / CAUTION / REJECT. |
| Risk Manager | LLM + **code limits** | The model chooses stop, target, risk % and leverage (or vetoes). Code then re-runs its numbers through fixed ceilings (`AI_TRADING_RISK_LIMITS` defaults in `src/lib/aiTrading.js`, not user-editable): risk and leverage are capped, stops are widened to the ATR floor / tightened to the max, reward:risk and liquidation distance are checked, and a plan that still breaks a limit is rejected. The model can only be stricter than the ceilings, never looser. |
| Position Manager | LLM | Works AFTER entry, not as a pipeline stage: re-reads every open AI trade each 5 min and decides HOLD / MOVE_TO_BREAKEVEN / TIGHTEN_STOP / LET_PROFIT_RUN / EXTEND_TAKE_PROFIT / PARTIAL_TAKE_PROFIT / EXIT_NOW. See "Position Manager" below. |

## Safety rules (enforced in `server/ai-trading/pipeline.js`)

- **Fail closed.** A stage that errors, times out, returns malformed JSON, or has no provider key means HOLD. A missing Critic verdict is never a pass.
- **Approval requires every gate** (`evaluateGates`): directional Analyst, Market Flow not AGAINST, Critic not REJECT, and the Risk Manager approving (APPROVE or REDUCE) **with a confidence >= the configured minimum (60)**. There is no separate Decision Agent: the Risk Manager is the final AI for entry and the code gate checks its own confidence number.
- **Later LLMs are only called if the deterministic gates before them pass**, so an LLM can never talk its way past a veto (and no tokens are spent on trades that were already blocked).
- The Analyst only *proposes* stop/target percentages; the Risk Manager owns stop, size and leverage, and `reviewRiskProposal` -> `runRiskManager` (plain code) has the last word on every number. No usable Risk Manager answer (error, malformed, missing key) is a veto, never unchecked sizing. The ceilings are fixed in `src/lib/aiTrading.js`: `normalizeAiTradingConfig` resets `config.risk` to them on every read/save and ignores any `risk` a client or hand-edited file supplies (the Risk Limits page was removed 2026-09-20 so the model, not the user, decides risk). Change them in code if you want a different ceiling; real-money margin is separately capped by `realMaxMarginUsdt`.
- Paid LLM stages are skipped once a gate has already blocked the trade: everything after an Analyst HOLD, the Critic/Risk after a Flow AGAINST (or flow data unavailable), and the Risk Manager after a Critic REJECT.

## Wallets, trading modes and execution

Added 2026-09-20. The ai.* workspace has its own **Trade History** (`/ai-history`, `/ai-history/real`), **Journal** calendar (`/ai-journal`), **Wallet** (`/ai-wallet`) and **Settings** (`/ai-settings`: mode, testnet auto-execute, real-money arm + margin cap, AI model API status, exchange-key status). The AI's trades live in `server/data/ai-trading/trades.json` in the same shape as bot trades (so the bots' history table, journal calendar and account maths are reused) but **never mix into the bots' trade history**.

- **Mode** (`config.execution.mode`): `testnet` or `real`. Two AI wallets: `wallet-ai-testnet`, `wallet-ai-real`.
- **Testnet:** an approved run opens automatically after the run when `autoExecuteTestnet` is on (default), or with the *Open on testnet* button. Uses the saved Binance testnet keys through the bots' proven `createExchangeTradeExecution` (market entry + exchange-side STOP_MARKET / TAKE_PROFIT_MARKET); with no testnet keys it becomes a local paper trade settled against the live price. Isolated margin always.
- **Real money — manual by default, optional auto-execute.** Requires: mode = real, the arm switch on (`realArmed`, only honoured in real mode; switching mode disarms it; arming needs the typed phrase `ARM REAL MONEY` in the UI), live Binance keys saved, the run's symbol typed back as confirmation (manual execute only; skipped when auto-execute is on), a plan no older than 10 min, live price within 0.5% of the plan, only 1 open real AI position, and no existing position in that symbol on the account (one-way mode nets, so it will not trade on top of a bot). Size is scaled **down** (never up) to `realMaxMarginUsdt` (default 5 USDT, hard bound 100) and 90% of the live available balance. Real trades are opened automatically only when the separate `autoExecuteReal` switch is on **and** real money is armed (it resets to off when you disarm or change mode; `assertCanExecute` enforces both). With it on, an approved run opens a live order with no click and no typed confirmation; every other check above still applies. Closing a position is never gated.
- These rules are pure and unit-tested in `server/ai-trading/execution.js` / `test/ai-trading-execution.test.js`; the exchange and disk I/O is in the "AI Trading wallets" block of `mock-trading-server.js`.
- **Monitor:** a 15 s loop (`monitorAiTrades`, no-op while nothing is open) settles open AI trades — exchange trades through the bots' `reconcileExchangeTradeState` (SL/TP fills, manual closes on Binance), paper trades against the live price.
- **Endpoints:** `GET /api/ai-trading/ledger[?sync=1]` (trades, wallets, journal, live prices, key presence), `POST /api/ai-trading/execute {runId, mode, confirm}`, `POST /api/ai-trading/trades/:id/close`. `PUT /api/ai-trading/config` keeps the saved `execution` block when the body omits it.
- **Wallet numbers:** exchange figures are a read-only account snapshot (shared with the bots on the same Binance account); the AI ledger counts only AI trades. The real wallet's ledger baseline is derived as exchange balance minus AI realised PnL.
- Verified 2026-09-20 on an isolated scratch server (empty data dir, no live keys): every gate above, paper open/settle/close, and one real Binance **testnet** entry + protective orders + monitor tick + manual close. **Never exercised: a live real-money order** (no live order has ever been placed by this feature).

## Flow data

`server/ai-trading/flow-data.js` pulls Binance's public USDT-M futures endpoints (`premiumIndex`, `openInterestHist`, `globalLongShortAccountRatio`, `topLongShortPositionRatio`, `takerlongshortRatio`) plus the futures order book and BTC's 5m candles — no API keys, ~100 ms in parallel. `summarizeFlow` is pure and tested; the price-vs-OI regime is computed in code so the model reasons from a checked label. The futures taker ratio is volume-weighted (averaging per-candle ratios pointed the opposite way from real flow), and the spot candle taker share is labelled as a different market.

Fail-closed: at least 2 of the 5 derivatives sources must respond, otherwise the Flow stage errors and the trade is HOLD. Individual missing metrics show as "unavailable" in the prompt and the model is told to ignore them. Every Flow result stores the metrics it saw next to its verdict, so a run is auditable.

## Backtest context (formerly the Quant Agent)

The Quant Agent was removed as an agent and as a gate. Its backtest statistics (117k trades from the rule-based Bots 1-4, aggregated by `npm run ai-trading:quant-stats` because `backtest-history.json` is ~116 MB and can't be parsed in the pm2 process) are now one background line in the Risk Manager's prompt, and a note on the Risk card. They never block a trade. Limitation: "similar" means same symbol, direction and stop distance, not the same setup, and the history overall has negative expected value (~32% win / ~1.6 payoff). The module is still `server/ai-trading/quant-stats.js`.

## Files

- `src/lib/aiTrading.js` — agent definitions, default config, risk bounds, `normalizeAiTradingConfig` (shared client/server).
- `server/ai-trading/pipeline.js` — snapshot, prompts, parsers, Risk Manager, gates, orchestrator.
- `server/ai-trading/llm.js` — one JSON call for any provider in `aiProviders.js` (Codex via `codex-agent.js`; Anthropic SDK; everything else OpenAI-compatible, retrying once without JSON mode on HTTP 400). Keys come from the AI Models page credential mirror, with the same `.env` fallbacks as the bots.
- `server/ai-trading/flow-data.js` — Market Flow Agent evidence (fetch + summarise).
- `server/ai-trading/quant-stats.js`, `scripts/build-ai-trading-quant-stats.js` — backtest context data.
- `server/ai-trading/store.js` — `server/data/ai-trading/config.json` and `runs.json` (last 50 runs). Deliberately **not** in `settings.json` (revision counters / recovery mirror / self-heal).
- `server/mock-trading-server.js` — `GET/PUT /api/ai-trading/config`, `GET /api/ai-trading/runs`, `POST /api/ai-trading/run {symbol}` (one in-flight run per symbol).
- `src/components/AiTradingPage.jsx`, `AiTradingRunReport.jsx`, and the "Agent Assignments" tab in `AiModelsPage.jsx`.
- `test/ai-trading-pipeline.test.js` — 40 tests, including the provider caller against local fake servers (no real network).

## Provider notes

- Model ids get retired (Gemini 2.0/2.5 already closed to new keys) — a 404 now shows the provider's own message. Set the model per agent on AI Models -> Agent Assignments.
- Replies are capped at 4096 tokens because reasoning models spend hidden thinking tokens from the same budget; a truncated reply is reported as "cut off", not as bad JSON.
- Only closed candles reach the agents (the forming candle is dropped).

## Browse Models (AI Models -> Browse Models)

`server/ai-models/catalog.js` + `src/components/AiModelsBrowser.jsx`. Lists what each provider can run: **connected providers are asked for their live model list with the saved key** (server-side; keys are never returned), **OpenRouter is always listed live** from its public catalog (no key needed to browse; ~446 models with context, pricing, JSON-mode/reasoning/vision flags and ~22 free chat models), and everything else shows the static suggestions, labelled "suggested". Azure/Bedrock/Vertex have no list endpoint. Lists are cached 10 min per key+URL (Refresh forces it). Search, provider, free-only, JSON-mode, sort, and a "Free models for testing" shortcut.

- **Test** (`POST /api/ai-models/test`) sends one tiny request through the same `callAgentJson` the agents use, so "works" means key valid + model id current + a parsable JSON reply + quota left. Many free models don't advertise JSON mode — Test before assigning.
- **Use for agent** assigns provider+model to any of the five AI roles (same config as Agent Assignments).
- Free OpenRouter models still need an OpenRouter API key (a free account key works) and are rate-limited.
- Provider error text is passed through `redactSecrets` (providers echo partial keys in 401s); a key saved under the wrong provider gets a hint ("looks like an OpenRouter key").

## Cost

Up to four LLM calls per run (Analyst, Market Flow, Critic, Risk Manager); an Analyst HOLD costs one, a Flow AGAINST two, a Critic reject three, a Risk veto four. Note free-tier provider quotas (Gemini's ran out mid-testing) — a quota error is reported per stage and fails closed. Runs are manual unless **Auto-scan** is on (below).

## Auto-scan (added 2026-09-20)

AI Settings -> **Auto-scan** (`config.scan`: `enabled`, default **off**, and `symbols`, default BTC/ETH/SOL). When on, `runAiScanCycle` (`server/mock-trading-server.js`) fires every 5 min (`AI_SCAN_INTERVAL_MS`) and runs the same pipeline as the Analyze button (`performAiTradingRun`) for each selected symbol, one after another.

- **Rules** (`server/ai-trading/scan.js`, pure + tested): skip a symbol with an open AI position, one closed less than 15 min ago (`AI_SCAN_COOLDOWN_MS`), one already being analysed, or when the wallet is at its position cap (5 testnet / 1 real).
- **One cycle at a time:** a tick that arrives while the previous cycle is still running is dropped, not queued. Switching the scan off stops it between symbols.
- **Execution:** unchanged. A testnet approval auto-opens when `autoExecuteTestnet` is on; real money is opened by a scan only when armed and `autoExecuteReal` is on (`assertCanExecute` enforces it); otherwise a real-mode scan only produces runs you confirm by hand.
- **Run History:** a scan stores a run only if the Analyst went LONG/SHORT or the run was executed. Analyst HOLDs and Analyst errors are one call each and would push real decisions out of the 50-run history within an hour, so they show only in the per-symbol status on the Settings page (`server/data/ai-trading/scan-status.json`). Scan runs carry `run.trigger = 'scan'`.
- **Cost:** 3 symbols every 5 min = ~36 Analyst calls/hour at minimum. The Analyst model must answer inside the 45 s call timeout (`llm.js`): the free Nemotron 550B model on OpenRouter does not reliably (43.9 s, then a timeout), so a fast model for the Analyst is a prerequisite for scanning.
- Not exercised live yet: the loop itself (unit tests cover the decisions, not the timer or the server wiring).

## Codex as an agent provider (added 2026-09-20)

Any of the four model-backed agents can be assigned **Codex (this server's login)** on AI Models -> Agent Assignments. It runs through `@openai/codex-sdk` (`server/ai-trading/codex-agent.js`) with the machine's own `codex login` (`~/.codex/auth.json`, or `CODEX_API_KEY` / `OPENAI_API_KEY`): no key is saved in the app, and the provider is `agentOnly` so it never shows on Providers & Keys or Browse Models. The model id is optional (blank = Codex's default; a name is passed as the thread's `model`).

- **Isolation:** unlike the Codex console it is NOT pointed at the project (which holds `.env`): an empty scratch dir (`<tmpdir>/xeniostrade-codex-agent`), read-only sandbox, approval `never`, network and web search off, and the prompt says to answer with JSON only and use no tools. Read-only still lets Codex *read* files anywhere on the box, so this is defence in depth, not a jail; the agents' input is market numbers only.
- **Timeout:** 150 s per call (`CODEX_AGENT_TIMEOUT_MS`), not the 45 s of chat-completion providers, with a real abort. At most 2 Codex turns run at once.
- **Cost:** no per-token bill; usage counts against that Codex account (subscription limits apply). A trivial call took ~7 s; full agent prompts will be slower.
- **Status:** `GET /api/ai-trading/config` returns `codex: { available, loggedIn }` (existence check only, the credential is never read); the UI shows Connected / Not logged in / Codex SDK missing.
- Verified: unit tests with a fake SDK (safety options, timeout abort, not-logged-in) and one real call through the SDK on this machine. NOT yet seen: a real Analyst prompt through Codex end to end.

## Claude as an agent provider (added 2026-09-20)

Same shape as Codex: any of the four model-backed agents (e.g. the Position Manager) can be assigned **Claude (this server's login)** on AI Models -> Agent Assignments. It runs through `@anthropic-ai/claude-agent-sdk` (`server/ai-trading/claude-agent.js`) with the machine's own `claude login` (`~/.claude/.credentials.json`, or `CLAUDE_CODE_OAUTH_TOKEN`): no key is saved in the app, and the provider is `agentOnly`. It is separate from the `Anthropic` provider, which is the pay-per-token API and needs a saved key. The model id is optional (blank = Claude's default).

- **Isolation:** no tools at all (`tools: []`), no settings / CLAUDE.md / MCP / skills (`settingSources: []`, `strictMcpConfig`), an empty scratch dir (`<tmpdir>/xeniostrade-claude-agent`), no saved session, and `maxTurns: 2`. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are removed from the subprocess env so it is always the login, never a silent API charge.
- **Timeout / concurrency:** 150 s per call with a real abort (`CLAUDE_AGENT_TIMEOUT_MS`); at most 2 runs at once.
- **Cost:** no per-token bill; usage counts against that Claude account's subscription limits.
- **Status:** `GET /api/ai-trading/config` returns `claude: { available, loggedIn }` next to `codex` (existence check only, the credential is never read).
- **Dependencies:** the Agent SDK peer-requires `@anthropic-ai/sdk >= 0.93` and `zod ^4`, so `@anthropic-ai/sdk` went 0.70 -> 0.127 (used by `bot-claude.js` and the Anthropic provider in `llm.js`), plus `zod` and `@modelcontextprotocol/sdk` as explicit deps.
- Verified: unit tests with a fake SDK, and one real call through `callAgentJson` on this machine (~3 s). The Decision prompt no longer exists; Claude now runs Flow and the Position Manager.

## Test mode and the Critic's stop rule (added 2026-09-20)

**Test mode** (`config.scan.testMode`, AI Settings -> Auto-scan; testnet or real money) is a one-shot pipeline check for when the market is quiet and the Analyst keeps saying HOLD. While on: the **Analyst** stops defaulting to HOLD and takes the direction the data leans toward (modest confidence, HOLD only if truly balanced), the **Critic** uses REJECT only for a clearly bad trade (ordinary weaknesses are CAUTION), the **Risk Manager** vetoes only a clearly unacceptable trade (a weak edge / negative backtest background means a small size, not a veto) (the Risk Manager's answer is now also the final entry approval, since the Decision Agent was retired). Extended to the Risk Manager after the first live cycles showed it vetoing every modest setup. Flow, the code gates (`evaluateGates`, min decision confidence), the Risk Manager's fixed ceilings (clamps, ATR-floor stop, reward:risk), the position cap and, on real money, the margin cap, one-position limit, plan-age and drift checks are unchanged (a test pins that a permissive Risk Manager is still clamped). Allowed on real money too (added 2026-09-21, to test that a live order goes through): the 10x minimum-leverage floor stays testnet-only, the server switches test mode off when the trading mode is changed and after the first trade it opens (testnet or real, auto or manual); runs and scan-log rows made under it are marked "Test mode". First live use: the Analyst returned LONG for 4 of 4 symbols and the un-relaxed Critic rejected all four (late entry, declining volume, crowding, "stop too tight").

**Critic and the Analyst's stop/target (permanent):** the Critic is now told the Analyst's stop and target are provisional (the Risk Manager sets the final stop, size and leverage), so it must not REJECT just because the proposed stop looks tight. It still attacks the setup itself.

## Position Manager (added 2026-09-20; replaces the Decision Agent)

**Why:** every AI role used to sit BEFORE a trade, so once a position was open nothing with judgment watched it. The fifth AI role is now the **Position Manager** (Claude by default), and the old Decision Agent is retired: the Risk Manager (Codex) is the final AI for entry and returns **APPROVE / REDUCE / VETO plus a confidence** (the code gate needs >= `minConfidence`, 60). A saved `decision` assignment is inherited by `manager` on first read (`normalizeAiTradingConfig`). Older runs still render their Decision stage.

**Where:** not a pipeline stage. `runPositionManagerCycle` (server/mock-trading-server.js) checks once a minute; every open AI trade is reviewed every `AI_POSITION_MANAGER_INTERVAL_MS` (5 min, first review 5 min after entry). One call per open trade per review (<= 5 open on testnet, 1 real). `POST /api/ai-trading/trades/:id/review` and the "Review now" button run one on demand.

**What the model gets** (`server/ai-trading/position-manager.js`): the original thesis (Analyst, Flow, Critic, Risk outputs and entry confidence, stored on the trade as `entryContext` so it survives the 50-run history), trade state (entry, price, initial/current stop and target, unrealized PnL, R multiple, MFE/MAE from 5M candles since entry, elapsed time, distances to stop/target, % of the position still open), the current market snapshot and derivatives flow, **what changed since entry** (entry-time snapshot vs now, `run.entrySnapshot`), and its own previous reviews (decision, thesis confidence, reason, expected next scenario, invalidation, and whether each was executed).

**What it can decide:** HOLD, MOVE_TO_BREAKEVEN, TIGHTEN_STOP, LET_PROFIT_RUN (remove the target, protect with a stop), EXTEND_TAKE_PROFIT, PARTIAL_TAKE_PROFIT (the model chooses the %), EXIT_NOW. Each review returns the decision, a thesis confidence (separate from entry confidence), suggested stop/target/partial %, reason, what changed, expected next scenario and invalidation. Stored newest-first on the trade (`managerReviews`, last 60) and shown on Trade History -> Position Manager.

**No trading rules in code.** R multiple, distance to stop/target, drawdown and market changes are prompt inputs only; there is no "breakeven at +1R", no "exit at -0.5R", no "extend at 80% of target" (a test pins that the prompt contains none). The only code checks are safety invariants that keep the order valid and stop the model from adding risk (`planPositionAction`): a stop can only move toward profit and must sit on the protective side of the price; a target can only be extended further out or removed; a partial is 1-99% and size is never added; anything invalid is rejected as a whole, recorded ("NOT executed: ..."), and the trade keeps its current orders. A randomized test asserts no executable plan ever widens a stop or pulls a target in.

**Execution:** Binance trades: a new stop/target is created first, then the old order is cancelled (a rejected replacement leaves the position protected); a partial close is a reduce-only market order followed by re-sizing the protective orders to the remainder; EXIT_NOW is the same close as the manual button (`closedBy: 'position-manager'`). The monitor skips a trade while it is being changed. Partial closes bank their PnL on the record (`partialRealizedPnl`) and the final close adds it; fills of partial-close orders are excluded when resolving the final exit price. Paper trades edit the record. An open-ended trade has `takeProfit: null` (paper settlement guards it).

**Real money:** reviews always run, but the Position Manager only *acts* on testnet unless `execution.positionManagerActsOnReal` is switched on (AI Settings, off by default), because real entries are manual-only. On a real position with it off, decisions are logged as "advisory only".

**A failed or unparsable review changes nothing** (the exchange-side stop and target stay); it is retried on the normal cadence and shown as "Last review failed".

**Verified:** 200/200 tests (fake exchange not available, so the exchange calls themselves are not unit-tested); one real review on the live testnet XRPUSDT trade: HOLD at thesis 42% (-0.59R) with sensible reasoning, saved and displayed correctly. **NOT yet seen live:** any executed action (stop move, partial, target change, exit) on the exchange.

## Exchange minimum order and the automatic leverage bump (added 2026-09-21)

**Problem:** the margin cap (`realMaxMarginUsdt`, and 90% of the available balance) shrinks a real position, and the largest position that can open is `margin cap x leverage`. On a small wallet that can fall below the exchange's minimum order for the symbol (e.g. ETHUSDT needs ~20-21 USDT), and the order failed with `Calculated quantity is below minNotional`.

**Fix (`server/ai-trading/exchange-fit.js`, shared by the pipeline and the executor):** when the sized position is below the minimum, leverage is raised just enough to reach it (`ceil(minimum x 1.02 / margin cap)`), with three hard limits: the leverage **ceiling** in code (`riskLimitsFor(config).maxLeverage`, 5x; 10x in testnet test mode), **never a position larger than the one the Risk Manager sized**, and the stop must stay **inside 90% of the liquidation distance** at the raised leverage. If any limit blocks it, the trade is refused with the reason (never a silent under-size).

**The Risk Manager can read and act on it:** the Risk Manager's prompt now states the symbol's minimum order, the margin it may use, that leverage will be raised to reach the minimum (up to the ceiling), and what would happen at the Analyst's own numbers. It can size (`riskPercent`, stop, `leverage`) or VETO knowing that. The lookup (`getTradeConstraints`, wired in `mock-trading-server.js`) is optional and never fatal. After the model answers, `reviewRiskProposal` applies the same rule: a reachable trade stays approved with a note ("leverage raised to Nx"), an unreachable one is **vetoed at the Risk Manager stage with the reason** instead of failing at the exchange. The executor (`openAiTrade`) re-applies the rule with live balance and price, sends the raised leverage to the exchange, and records it on the trade (with an `aiScaleNotes` line).

Loss stays bounded: the raised position is never larger than the Risk Manager's own, and the stop is unchanged, so max loss is `position x stop %` (a few tenths of a USDT on a 40 USDT wallet).
