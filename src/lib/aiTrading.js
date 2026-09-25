// Shared (client + server) definition of the AI Trading pipeline: the five
// agents, their default provider assignments, and the reference risk numbers shown to the Risk Manager for
// context (account equity, what a rule-based bot would mechanically do) — not enforced in code; see
// server/ai-trading/pipeline.js's file header for why. No Node builtins here, same as
// aiProviders.js / signalModels.js.
//
// AI Trading is NOT a bot: it has no signal model and the pipeline itself never
// places an order. It runs an on-demand pipeline over market data and returns
// Trade / No Trade with a full audit trail per stage. Approved trades can then
// be opened on its OWN wallets (testnet / real money) — see `execution` below
// and server/ai-trading/execution.js.

import { getAiProvider } from './aiProviders.js'

export const AI_TRADING_AGENTS = [
  {
    id: 'analyst',
    name: 'Market Analyst',
    kind: 'ai',
    role: 'Reads candles, indicators, volume, structure and regime.',
    output: 'LONG / SHORT / HOLD',
  },
  {
    id: 'flow',
    name: 'Market Flow Agent',
    kind: 'ai',
    role: 'Reads derivatives positioning and order flow the chart cannot show: funding, open interest, long/short ratios, taker flow, book depth, BTC.',
    output: 'SUPPORTS / NEUTRAL / AGAINST',
  },
  {
    id: 'critic',
    name: 'Critic Agent',
    kind: 'ai',
    role: 'Tries to find reasons the trade should be rejected.',
    output: 'PASS / CAUTION / REJECT',
  },
  {
    id: 'risk',
    name: 'Risk Manager',
    kind: 'ai',
    // Receives everything the three agents above produced and makes the final call. The model chooses stop,
    // target, risk and leverage (or vetoes) and its numbers are used exactly as given — nothing in code widens,
    // tightens, caps or rejects them. The only checks left are real exchange/account constraints (the minimum
    // order size, the wallet's actual margin), not opinions on the trade. See AI_TRADING_RISK_LIMITS below: those
    // numbers are reference context for the model, not a ceiling.
    guardrail: 'AI judgment only — no code ceiling',
    role: 'The AI model decides stop-loss, size, risk and leverage, or vetoes. Nothing is set by hand and nothing in code overrides its answer.',
    output: 'Sized trade plan or veto',
  },
  {
    id: 'manager',
    name: 'Position Manager',
    kind: 'ai',
    // Works AFTER entry, not as a pipeline stage: it re-reads an open trade every few minutes and decides how to manage it.
    phase: 'after-entry',
    role: 'Watches an open position like a trader who inherited it: holds, moves to breakeven, tightens the stop, lets a winner run or extends the target, takes a partial profit, or exits early.',
    output: 'HOLD / MOVE_TO_BREAKEVEN / TIGHTEN_STOP / LET_PROFIT_RUN / EXTEND_TAKE_PROFIT / PARTIAL_TAKE_PROFIT / EXIT_NOW',
  },
]

/** The agents that decide whether a trade should exist, in order. The Risk Manager is the final entry approver (there is no Decision Agent). */
export const AI_TRADING_ENTRY_STAGE_IDS = ['analyst', 'flow', 'critic', 'risk']

// The Position Manager re-reviews every open AI trade this often. It is an AI review cycle, not a trading rule: it only
// decides when the model is asked again, never what the model decides.
export const AI_POSITION_MANAGER_INTERVAL_MS = 5 * 60_000
export const AI_POSITION_MANAGER_DECISIONS = [
  'HOLD', 'MOVE_TO_BREAKEVEN', 'TIGHTEN_STOP', 'LET_PROFIT_RUN', 'EXTEND_TAKE_PROFIT', 'PARTIAL_TAKE_PROFIT', 'EXIT_NOW',
]

/** The agents that call an LLM and therefore need a provider assignment. */
export const AI_TRADING_LLM_AGENT_IDS = AI_TRADING_AGENTS.filter((agent) => agent.kind === 'ai').map((agent) => agent.id)

const AI_TRADING_BASE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']
// TEMPORARY (2026-09-20): extra liquid USDT-M perps so the auto-scan sees more setups while testing the first trade.
// Empty this array to go back to the base symbols; saved scan selections outside the list are dropped on the next read.
const AI_TRADING_TEMP_SYMBOLS = ['XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'SUIUSDT', 'NEARUSDT', 'LINKUSDT']

export const AI_TRADING_SYMBOLS = [...AI_TRADING_BASE_SYMBOLS, ...AI_TRADING_TEMP_SYMBOLS]

export const AI_TRADING_SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/

// Risk is decided by the Risk Manager model, not by the user: there is no risk
// setting to edit. These are reference numbers only (the accountEquity baseline, and what a rule-based bot
// would mechanically do, for contrast) shown to the model in its prompt — nothing in code clamps or vetoes
// against them; see server/ai-trading/pipeline.js's file header. `normalizeAiTradingConfig` always resets
// `config.risk` to the defaults below, so a bad PUT or a hand-edited file cannot
// change them; change them here, in code, on purpose.
export const AI_TRADING_RISK_LIMITS = {
  accountEquityUsdt: { min: 10, max: 1_000_000, step: 10, label: 'Account equity (USDT)' },
  riskPerTradePct: { min: 0.1, max: 2, step: 0.1, label: 'Risk per trade (% of equity)' },
  maxLeverage: { min: 1, max: 10, step: 1, label: 'Max leverage (x)' },
  maxStopLossPct: { min: 0.3, max: 5, step: 0.1, label: 'Max stop distance (%)' },
  minStopAtrMultiple: { min: 0, max: 3, step: 0.1, label: 'Min stop distance (x ATR)' },
  minRewardRisk: { min: 1, max: 5, step: 0.1, label: 'Min reward : risk' },
  minConfidence: { min: 50, max: 95, step: 1, label: 'Min entry confidence (%)' },
}

export const AI_TRADING_MODES = ['testnet', 'real']

// Test mode (see DEFAULT_AI_TRADING_SCAN.testMode) also floors leverage here on testnet only, so the fake-money trades it
// opens exercise a high-leverage position. It raises the ceiling to at least this too; sizing (risk per trade) is unchanged,
// so only the margin gets smaller. Outside test mode the normal ceilings apply and this is never used.
export const AI_TRADING_TEST_MODE_MIN_LEVERAGE = 10
// Bounds for the execution settings. `realMaxMarginUsdt` is a hard per-trade
// margin ceiling on the live account, applied after the Risk Manager sized the plan.
export const AI_TRADING_EXECUTION_LIMITS = {
  testnetStartingBalance: { min: 10, max: 1_000_000, step: 10, label: 'Testnet wallet starting balance (USDT)' },
  realMaxMarginUsdt: { min: 1, max: 100, step: 1, label: 'Real money: max margin per trade (USDT)' },
  // Daily limits on AUTOMATIC real-money entries (0 = off). See server/ai-trading/daily-limits.js.
  dailyProfitTargetUsdt: { min: 0, max: 100_000, step: 0.5, label: 'Daily profit target (USDT, 0 = off)' },
  dailyMaxLossUsdt: { min: 0, max: 100_000, step: 0.5, label: 'Daily loss stop (USDT, 0 = off)' },
  dailyMaxTrades: { min: 0, max: 50, step: 1, label: 'Max real trades per day (0 = off)' },
  // Guidance for the Risk Manager, not enforced in code (see profitGoalLines in pipeline.js): a target USDT profit on a
  // winning trade. It reasons toward it with its own riskPercent/leverage/takeProfitPercent, inside the usual ceilings.
  targetProfitPerTradeUsdt: { min: 0, max: 10_000, step: 0.1, label: 'Target profit per trade (USDT, 0 = off)' },
}

export const DEFAULT_AI_TRADING_EXECUTION = {
  mode: 'testnet',
  // Testnet: open approved decisions automatically.
  autoExecuteTestnet: true,
  // Real money: same idea, but a separate explicit opt-in that is only honoured while mode is real AND armed (normalize
  // resets it to false when the mode changes or real money is disarmed), so arming alone never makes anything automatic.
  autoExecuteReal: false,
  // Real-money arm switch. Only honoured while mode === 'real'; switching mode disarms it.
  realArmed: false,
  // The Position Manager always reviews open trades. It only ACTS (moves stops, takes partials, exits) on testnet unless this is
  // switched on for real-money positions; real-money entries are manual, so their management is opt-in too.
  positionManagerActsOnReal: false,
  // Daily limits on automatic real-money entries (0 = off): stop opening new trades once today's realized result (after estimated fees) reaches the
  // profit target or the loss stop, or once this many real trades were opened today. Open positions keep being managed; manual execution is unaffected.
  dailyProfitTargetUsdt: 0,
  dailyMaxLossUsdt: 0,
  dailyMaxTrades: 0,
  // The Risk Manager is told to aim for roughly this much USDT profit on a winning trade (0 = no goal stated). Purely
  // advisory - it never raises a ceiling, never overrides the model's own risk judgement, and is not enforced in code.
  targetProfitPerTradeUsdt: 1,
  testnetStartingBalance: 1000,
  realMaxMarginUsdt: 5,
}

// Auto-scan: every AI_SCAN_INTERVAL_MS the server runs the pipeline for each enabled symbol (see
// server/ai-trading/scan.js). Off by default. It opens real money only when armed AND `autoExecuteReal` is on (`assertCanExecute` enforces it).
export const AI_SCAN_INTERVAL_MS = 5 * 60_000
export const AI_SCAN_COOLDOWN_MS = 15 * 60_000

export const DEFAULT_AI_TRADING_SCAN = {
  enabled: false,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  // Testnet-only pipeline check: the Analyst stops defaulting to HOLD and takes the direction the data leans toward, so the
  // whole chain (Flow, Critic, Risk, testnet open, then the Position Manager) gets exercised. Every later gate and the risk ceilings are
  // unchanged. Never honoured outside testnet mode; the server switches it off after the first trade it opens.
  testMode: false,
  // Active profile (persistent, either mode): the Analyst takes the direction the data leans toward instead of defaulting to HOLD, Market Flow needs two
  // independent adverse signals before it blocks, and the Risk Manager REDUCES (smaller size) an extended-but-valid entry instead of vetoing it. Every
  // code gate, ceiling and daily limit still applies. Off by default.
  activeMode: false,
}

// ---- Strategy (added 2026-09-25) -------------------------------------------------------------------------------------------
// A review of 33 testnet trades (11 won, 22 lost; ~-60 USDT after estimated fees) found the entries had no edge: replayed with their own
// stop/target, the target was hit first 8 times out of 33 (24%) where ~49% was needed after fees, and 5-minute scalps with ~0.4% stops lost a
// quarter of every stop distance to fees. These switches change WHERE trades come from and how they are shaped. Each one is independent
// so its effect can be measured on its own (the shadow tracker tags every signal with the strategy that produced it). Code defaults keep
// the original behavior; the server's config turns them on.

/**
 * Candle timeframes per strategy. `entry` is what the Analyst reads bar by bar (and what ATR / the stop floor are measured on), `bias`
 * drives the trend classifier, `regime` confirms it one level up, `context` is a short list of closes for the prompt. The cadences and the
 * shadow-tracker horizon scale with the timeframe so a swing idea is neither re-run every 5 minutes nor judged after 2 hours.
 */
export const AI_TRADING_TIMEFRAMES = {
  scalp: {
    id: 'scalp',
    label: 'Scalp (5M entries, 1H trend)',
    entry: { interval: '5m', label: '5M', minutes: 5, bars: 120 },
    bias: { interval: '1h', label: '1H', minutes: 60, bars: 120 },
    regime: null,
    context: { interval: '15m', label: '15M', minutes: 15, bars: 120 },
    holdHint: 'the next few 5M candles',
    minRunGapMs: 0,
    cooldownMs: 15 * 60_000,
    managerIntervalMs: 5 * 60_000,
    evidence: { fast: { interval: '5m', label: '5M', minutes: 5, bars: 500 }, slow: { interval: '1h', label: '1H', minutes: 60, bars: 300 }, excursionBars: 12 },
    shadow: { horizonMs: 2 * 60 * 60_000, baselineWindowMs: 60 * 60_000, baselineStepMs: 5 * 60_000, resolution: '1m' },
  },
  swing: {
    id: 'swing',
    label: 'Swing (1H entries, 4H trend, daily confirmation)',
    entry: { interval: '1h', label: '1H', minutes: 60, bars: 200 },
    bias: { interval: '4h', label: '4H', minutes: 240, bars: 200 },
    regime: { interval: '1d', label: '1D', minutes: 1440, bars: 120 },
    context: { interval: '1d', label: '1D', minutes: 1440, bars: 120 },
    holdHint: 'the next 12-48 hours (several 1H candles)',
    // One pipeline run per symbol per closed 1H candle (the scan loop still ticks every 5 minutes).
    minRunGapMs: 55 * 60_000,
    cooldownMs: 2 * 60 * 60_000,
    managerIntervalMs: 15 * 60_000,
    evidence: { fast: { interval: '1h', label: '1H', minutes: 60, bars: 500 }, slow: { interval: '4h', label: '4H', minutes: 240, bars: 300 }, excursionBars: 24 },
    shadow: { horizonMs: 48 * 60 * 60_000, baselineWindowMs: 6 * 60 * 60_000, baselineStepMs: 60 * 60_000, resolution: '5m' },
  },
}
export const AI_TRADING_TIMEFRAME_IDS = Object.keys(AI_TRADING_TIMEFRAMES)

// Fee-aware rules (strategy.feeAware). Taker in + taker out on Binance USDT-M is ~0.05% + 0.05%; kept conservative even with maker entries.
export const AI_TRADING_ROUND_TRIP_FEE_PCT = 0.1
export const AI_TRADING_MIN_TARGET_FEE_MULTIPLE = 5 // target must be at least this many round trips (0.5%)
export const AI_TRADING_MIN_NET_REWARD_RISK = 1.5 // (target - fee) / (stop + fee)
// Trend filter (strategy.trendFilter): the classifier's trend score runs -4..+4 (EMA20 vs 50, slope, gap, higher-timeframe confirmation).
export const AI_TRADING_TREND_THRESHOLD = 2

export const DEFAULT_AI_TRADING_STRATEGY = {
  timeframe: 'scalp',
  feeAware: false,
  trendFilter: false,
  // 3-agent pipeline: Analyst (reads the flow data itself) -> Risk Manager (also does the Critic's job) -> Position Manager.
  lean: false,
  // Enter with a post-only limit order at the best bid/ask (maker fee), falling back to market if it does not fill in time.
  makerEntry: false,
}

/** The timeframe profile a config uses (falls back to the legacy scalp profile). */
export function getAiTradingTimeframe(config) {
  return AI_TRADING_TIMEFRAMES[config?.strategy?.timeframe] || AI_TRADING_TIMEFRAMES.scalp
}

/** Short tag for the active strategy, stored on every run and shadow signal so strategies can be compared, e.g. "swing+trend+fee+lean". */
export function aiStrategyTag(strategy = DEFAULT_AI_TRADING_STRATEGY) {
  const parts = [AI_TRADING_TIMEFRAMES[strategy?.timeframe] ? strategy.timeframe : 'scalp']
  if (strategy?.trendFilter) parts.push('trend')
  if (strategy?.feeAware) parts.push('fee')
  if (strategy?.lean) parts.push('lean')
  if (strategy?.makerEntry) parts.push('maker')
  return parts.join('+')
}

/** Agents that actually run under a config (the 3-agent pipeline skips Market Flow and the Critic). */
export function activeAiTradingAgentIds(config) {
  return config?.strategy?.lean ? ['analyst', 'risk', 'manager'] : AI_TRADING_LLM_AGENT_IDS
}

export const DEFAULT_AI_TRADING_CONFIG = {
  agents: {
    analyst: { providerId: 'anthropic', model: '' },
    flow: { providerId: 'anthropic', model: '' },
    critic: { providerId: 'anthropic', model: '' },
    risk: { providerId: 'anthropic', model: '' },
    manager: { providerId: 'anthropic', model: '' },
  },
  risk: {
    accountEquityUsdt: 1000,
    riskPerTradePct: 1,
    maxLeverage: 5,
    maxStopLossPct: 3,
    minStopAtrMultiple: 1,
    minRewardRisk: 1.5,
    minConfidence: 60,
  },
  execution: DEFAULT_AI_TRADING_EXECUTION,
  scan: DEFAULT_AI_TRADING_SCAN,
  strategy: DEFAULT_AI_TRADING_STRATEGY,
}

function clampNumber(value, { min, max }, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

/** Validates/cleans a config from disk or a request body; anything invalid falls back to the default. */
export function normalizeAiTradingConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const rawAgents = source.agents && typeof source.agents === 'object' ? source.agents : {}
  // The Position Manager took over the retired Decision Agent's assignment (same provider/model) on first read.
  const agentsSource = { ...rawAgents, manager: rawAgents.manager ?? rawAgents.decision }

  const agents = {}
  for (const agentId of AI_TRADING_LLM_AGENT_IDS) {
    const entry = agentsSource[agentId] && typeof agentsSource[agentId] === 'object' ? agentsSource[agentId] : {}
    const providerId = typeof entry.providerId === 'string' ? entry.providerId.trim() : ''
    agents[agentId] = {
      // '' = deliberately unassigned; an unknown id is treated the same way.
      providerId: getAiProvider(providerId) ? providerId : '',
      model: typeof entry.model === 'string' ? entry.model.trim().slice(0, 200) : '',
    }
    if (!('providerId' in entry)) {
      // A config saved before the Risk Manager / Market Flow Agent existed has no entry for it: reuse the
      // Analyst's provider (already normalized above) so an existing setup keeps working instead of failing closed.
      agents[agentId].providerId = (agentId === 'risk' || agentId === 'flow') && agents.analyst
        ? agents.analyst.providerId
        : DEFAULT_AI_TRADING_CONFIG.agents[agentId].providerId
    }
  }

  // Not user-configurable: the Risk Manager model decides within these fixed ceilings.
  const risk = { ...DEFAULT_AI_TRADING_CONFIG.risk }

  const executionSource = source.execution && typeof source.execution === 'object' ? source.execution : {}
  const mode = AI_TRADING_MODES.includes(executionSource.mode) ? executionSource.mode : DEFAULT_AI_TRADING_EXECUTION.mode
  const realArmed = mode === 'real' && executionSource.realArmed === true
  const execution = {
    mode,
    autoExecuteTestnet: 'autoExecuteTestnet' in executionSource
      ? executionSource.autoExecuteTestnet === true
      : DEFAULT_AI_TRADING_EXECUTION.autoExecuteTestnet,
    // Arming needs an explicit `true` AND real mode; anything else (missing, "true", 1) stays disarmed.
    realArmed,
    // Auto-executing real money needs its own explicit `true`, on top of real mode and being armed.
    autoExecuteReal: realArmed && executionSource.autoExecuteReal === true,
    positionManagerActsOnReal: executionSource.positionManagerActsOnReal === true,
    dailyProfitTargetUsdt: Math.round(clampNumber(executionSource.dailyProfitTargetUsdt, AI_TRADING_EXECUTION_LIMITS.dailyProfitTargetUsdt, 0) * 100) / 100,
    dailyMaxLossUsdt: Math.round(clampNumber(executionSource.dailyMaxLossUsdt, AI_TRADING_EXECUTION_LIMITS.dailyMaxLossUsdt, 0) * 100) / 100,
    dailyMaxTrades: Math.round(clampNumber(executionSource.dailyMaxTrades, AI_TRADING_EXECUTION_LIMITS.dailyMaxTrades, 0)),
    targetProfitPerTradeUsdt: Math.round(clampNumber(executionSource.targetProfitPerTradeUsdt, AI_TRADING_EXECUTION_LIMITS.targetProfitPerTradeUsdt, DEFAULT_AI_TRADING_EXECUTION.targetProfitPerTradeUsdt) * 100) / 100,
    testnetStartingBalance: clampNumber(
      executionSource.testnetStartingBalance,
      AI_TRADING_EXECUTION_LIMITS.testnetStartingBalance,
      DEFAULT_AI_TRADING_EXECUTION.testnetStartingBalance,
    ),
    realMaxMarginUsdt: clampNumber(
      executionSource.realMaxMarginUsdt,
      AI_TRADING_EXECUTION_LIMITS.realMaxMarginUsdt,
      DEFAULT_AI_TRADING_EXECUTION.realMaxMarginUsdt,
    ),
  }

  const scanSource = source.scan && typeof source.scan === 'object' ? source.scan : {}
  const scanSymbols = Array.isArray(scanSource.symbols)
    ? AI_TRADING_SYMBOLS.filter((symbol) => scanSource.symbols.includes(symbol))
    : []
  const scan = {
    // Needs an explicit `true`; anything else (missing, "true", 1) stays off.
    enabled: scanSource.enabled === true,
    symbols: scanSymbols.length ? scanSymbols : [...DEFAULT_AI_TRADING_SCAN.symbols],
    // Honoured in either mode. The server resets it on a mode switch and after the first trade it opens, so it never lingers.
    testMode: scanSource.testMode === true,
    activeMode: scanSource.activeMode === true,
  }

  const strategySource = source.strategy && typeof source.strategy === 'object' ? source.strategy : {}
  const strategy = {
    timeframe: AI_TRADING_TIMEFRAMES[strategySource.timeframe] ? strategySource.timeframe : DEFAULT_AI_TRADING_STRATEGY.timeframe,
    // Each switch needs an explicit `true`.
    feeAware: strategySource.feeAware === true,
    trendFilter: strategySource.trendFilter === true,
    lean: strategySource.lean === true,
    makerEntry: strategySource.makerEntry === true,
  }

  return { agents, risk, execution, scan, strategy }
}
