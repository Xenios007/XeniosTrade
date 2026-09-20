// Shared (client + server) definition of the AI Trading pipeline: the five
// agents, their default provider assignments, and the fixed risk ceilings the
// deterministic Risk Manager enforces on the Risk Manager model's answer. No Node builtins here, same as
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
    // The model chooses stop, target, risk and leverage (or vetoes); code then clamps every number to the
    // fixed ceilings (AI_TRADING_RISK_LIMITS), so the model can only ever be stricter than them, never looser.
    guardrail: 'Fixed ceilings enforced in code',
    role: 'The AI model decides stop-loss, size, risk and leverage, or vetoes. Nothing is set by hand; fixed ceilings in code only cap its answer.',
    output: 'Sized trade plan or veto',
  },
  {
    id: 'decision',
    name: 'Decision Agent',
    kind: 'ai',
    role: 'Combines the other agents and approves LONG/SHORT or returns HOLD.',
    output: 'Trade / No Trade',
  },
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
// setting to edit. These are the fixed ceilings (and the accountEquity baseline)
// that plain code enforces on whatever the model answers, so it can be stricter
// than them but never looser. `normalizeAiTradingConfig` always resets
// `config.risk` to the defaults below, so a bad PUT or a hand-edited file cannot
// change them; change them here, in code, on purpose.
export const AI_TRADING_RISK_LIMITS = {
  accountEquityUsdt: { min: 10, max: 1_000_000, step: 10, label: 'Account equity (USDT)' },
  riskPerTradePct: { min: 0.1, max: 2, step: 0.1, label: 'Risk per trade (% of equity)' },
  maxLeverage: { min: 1, max: 10, step: 1, label: 'Max leverage (x)' },
  maxStopLossPct: { min: 0.3, max: 5, step: 0.1, label: 'Max stop distance (%)' },
  minStopAtrMultiple: { min: 0, max: 3, step: 0.1, label: 'Min stop distance (x ATR)' },
  minRewardRisk: { min: 1, max: 5, step: 0.1, label: 'Min reward : risk' },
  minConfidence: { min: 50, max: 95, step: 1, label: 'Min decision confidence (%)' },
}

export const AI_TRADING_MODES = ['testnet', 'real']

// Bounds for the execution settings. `realMaxMarginUsdt` is a hard per-trade
// margin ceiling on the live account, applied after the Risk Manager sized the plan.
export const AI_TRADING_EXECUTION_LIMITS = {
  testnetStartingBalance: { min: 10, max: 1_000_000, step: 10, label: 'Testnet wallet starting balance (USDT)' },
  realMaxMarginUsdt: { min: 1, max: 100, step: 1, label: 'Real money: max margin per trade (USDT)' },
}

export const DEFAULT_AI_TRADING_EXECUTION = {
  mode: 'testnet',
  // Testnet only: open approved decisions automatically. Real money is NEVER automatic.
  autoExecuteTestnet: true,
  // Real-money arm switch. Only honoured while mode === 'real'; switching mode disarms it.
  realArmed: false,
  testnetStartingBalance: 1000,
  realMaxMarginUsdt: 5,
}

// Auto-scan: every AI_SCAN_INTERVAL_MS the server runs the pipeline for each enabled symbol (see
// server/ai-trading/scan.js). Off by default. It never opens real money: `assertCanExecute` refuses auto + real.
export const AI_SCAN_INTERVAL_MS = 5 * 60_000
export const AI_SCAN_COOLDOWN_MS = 15 * 60_000

export const DEFAULT_AI_TRADING_SCAN = {
  enabled: false,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
}

export const DEFAULT_AI_TRADING_CONFIG = {
  agents: {
    analyst: { providerId: 'anthropic', model: '' },
    flow: { providerId: 'anthropic', model: '' },
    critic: { providerId: 'anthropic', model: '' },
    risk: { providerId: 'anthropic', model: '' },
    decision: { providerId: 'anthropic', model: '' },
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
}

function clampNumber(value, { min, max }, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

/** Validates/cleans a config from disk or a request body; anything invalid falls back to the default. */
export function normalizeAiTradingConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const agentsSource = source.agents && typeof source.agents === 'object' ? source.agents : {}

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
  const execution = {
    mode,
    autoExecuteTestnet: 'autoExecuteTestnet' in executionSource
      ? executionSource.autoExecuteTestnet === true
      : DEFAULT_AI_TRADING_EXECUTION.autoExecuteTestnet,
    // Arming needs an explicit `true` AND real mode; anything else (missing, "true", 1) stays disarmed.
    realArmed: mode === 'real' && executionSource.realArmed === true,
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
  }

  return { agents, risk, execution, scan }
}
