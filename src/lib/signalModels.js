import { getStrategyDerivedMaxLossPerTrade, getStrategyPositionNotional, roundMoney } from './accountMetrics.js'
import { DEFAULT_MARGIN_MODE, normalizeMarginMode } from './marginModes.js'
import { MANUAL_TRADE_STYLE_PRESET_ID, resolveTradeStylePresetId } from './strategyPresets.js'

export const DEFAULT_SIGNAL_MODEL_ID = 'model-1'
export const SIGNAL_MODEL_STRATEGY_OVERRIDE_IDS = ['model-1', 'model-2', 'model-4', 'model-5', 'model-6', 'model-7', 'model-8', 'model-9', 'model-10', 'model-11', 'model-12', 'model-13', 'model-14', 'model-15']
export const SIGNAL_MODEL_STRATEGY_OVERRIDE_KEYS = [
  'tradeStylePresetId',
  'marginMode',
  'marginPerTrade',
  'leverage',
  'maxOpenPositions',
  'stopLossPercent',
  'takeProfitPercent',
  'maxTradesPerDay',
  'maxLossesPerDay',
  'maxLossPerDay',
  'dailyProfitTarget',
  'useSymbolRiskProfile',
]

const model1Signals = [
  {
    key: 'setup-zone-context',
    label: '15M support/resistance zone',
    detail: 'Treat support and resistance as zones, not exact lines. The setup must begin at a meaningful edge of the active 15M range.',
  },
  {
    key: 'bias-multi-timeframe',
    label: '1H + 15M directional alignment',
    detail: 'The higher-timeframe structure should not fight the trade. Longs prefer bullish structure, shorts prefer bearish structure.',
  },
  {
    key: 'setup-price-action-pattern',
    label: 'Reversal candle or breakout close',
    detail: 'At the zone, wait for a professional-style rejection pattern or a decisive breakout close instead of entering on first touch.',
  },
  {
    key: 'setup-volume-confirmation',
    label: 'Volume or money-flow confirmation',
    detail: 'The setup should show above-average participation through volume expansion, absorption, or supportive taker flow.',
  },
  {
    key: 'entry-confirmation',
    label: 'Closed 5M confirmation / retest continuation',
    detail: 'Reversals need the next closed 5M candle to confirm. Breakouts need a retest hold plus a closed continuation candle.',
  },
  {
    key: 'entry-momentum-confirmation',
    label: 'RSI divergence or momentum follow-through',
    detail: 'Reversals prefer divergence. Breakouts prefer RSI and price momentum to stay in the trade direction after confirmation.',
  },
  {
    key: 'session-liquidity-window',
    label: 'London or New York liquidity window',
    detail: 'Entries are allowed only during the high-volume windows around London and New York opens.',
  },
  {
    key: 'risk-reward-room',
    label: 'Protected stop with 1:2 room',
    detail: 'Stops sit beyond the rejection or retest failure point with ATR and zone buffer, and the setup still needs at least 1:2 reward-to-risk.',
  },
]

const model2AdditionalSignals = [
  {
    key: 'entry-volume-delta',
    label: 'Directional volume delta',
    detail: 'Longs prefer positive taker-volume delta after the level confirms. Shorts prefer negative delta after the level confirms.',
  },
  {
    key: 'setup-order-book-imbalance',
    label: 'Order book imbalance at the level',
    detail: 'Longs prefer bid support to outweigh ask pressure after the retest. Shorts prefer the opposite.',
  },
  {
    key: 'macro-funding-bias',
    label: 'Funding-rate contrarian bias',
    detail: 'Positive funding above 0.03% supports shorts. Negative funding below -0.03% supports longs.',
  },
]

const model3Signals = [
  {
    key: 'bias-market-structure',
    label: '1H + 15M market structure trend',
    detail: 'Trend must already be in place. Longs prefer higher highs and higher lows, shorts prefer lower highs and lower lows.',
  },
  {
    key: 'setup-vwap-bias',
    label: 'VWAP bias alignment',
    detail: 'Stay on the correct side of VWAP: longs prefer price above it, shorts prefer price below it.',
  },
  {
    key: 'setup-pullback-into-ema',
    label: 'EMA pullback or breakout retest',
    detail: 'Trend entries must come from an EMA pullback into a nearby zone or from a breakout that comes back to retest the broken level.',
  },
  {
    key: 'setup-vwap-stretch-limit',
    label: 'No-chase distance from EMA/VWAP',
    detail: 'No trade if price is too stretched from the EMA or VWAP. The setup must still be close enough to offer a disciplined entry.',
  },
  {
    key: 'setup-volume-confirmation',
    label: 'Volume or delta confirmation',
    detail: 'The pullback or retest should attract fresh participation through stronger volume, absorption, or directional delta.',
  },
  {
    key: 'entry-structure-hold',
    label: 'Zone hold on the retest',
    detail: 'The pullback zone or breakout retest must hold before the trigger candle can qualify.',
  },
  {
    key: 'entry-price-action-trigger',
    label: 'Closed 5M continuation trigger',
    detail: 'The entry candle must be a closed 5M continuation candle that reclaims or rejects away from the zone instead of guessing early.',
  },
  {
    key: 'risk-reward-room',
    label: 'Protected stop with 1:2 room',
    detail: 'Stop loss goes beyond the pullback or retest failure point with ATR buffer, and the next expansion target still needs at least 1:2 reward-to-risk.',
  },
]

const model4Signals = [
  {
    key: 'bias-ema-trend',
    label: '15M EMA20 vs EMA50 trend',
    detail: 'Long bias needs 15M EMA20 above EMA50. Short bias needs 15M EMA20 below EMA50. This only sets direction, not entry.',
  },
  {
    key: 'bias-rsi-side',
    label: '5M RSI14 momentum side',
    detail: 'Long bias needs 5M RSI14 at or above 50. Short bias needs 5M RSI14 at or below 50.',
  },
  {
    key: 'ai-entry-gate',
    label: 'AI entry score gate',
    detail: 'Once a direction bias exists, the AI entry score is the only decision to take or skip the trade (hard block at the configured threshold).',
  },
]

const model5Signals = [
  { key: 'mr-regime-not-trend', label: 'Market not in a strong trend', detail: 'Mean reversion only fires when the higher-timeframe regime is range / low-vol / transition — never a strong bull or bear trend continuation.' },
  { key: 'mr-zscore-stretch', label: 'Price statistically stretched from mean', detail: 'Close is at least ~1.6 standard deviations from the 20-bar mean (z-score), i.e. an outlier, not normal noise.' },
  { key: 'mr-bollinger-extreme', label: 'Outside / at the Bollinger band', detail: 'Price sits beyond the outer Bollinger band on the fade side.' },
  { key: 'mr-rsi-extreme', label: 'RSI oversold / overbought', detail: 'RSI14 confirms the exhaustion (below ~42 for longs, above ~58 for shorts).' },
  { key: 'mr-atr-stretch', label: 'ATR-normalised deviation elevated', detail: '(close − mean) / ATR is stretched, so the move is large relative to recent volatility.' },
  { key: 'mr-momentum-weakening', label: 'Pressure in the move is weakening', detail: 'RSI slope is no longer accelerating against the trade — selling (or buying) is losing steam.' },
  { key: 'mr-reversal-candle', label: 'Reversal / reclaim candle', detail: 'The latest closed candle reclaims back toward the mean instead of extending the stretch.' },
  { key: 'mr-volume-exhaustion', label: 'Volume exhaustion, not fresh impulse', detail: 'Relative volume is not spiking — the stretch looks like capitulation, not a new trend leg.' },
]

const model6Signals = [
  { key: 'vb-compression', label: 'Prior compression / squeeze', detail: 'Bollinger band width was in the lower band of its recent range, or ATR had compressed — energy was coiling.' },
  { key: 'vb-atr-expansion', label: 'ATR now expanding', detail: 'Current ATR is meaningfully above its value ~20 bars ago — volatility is releasing.' },
  { key: 'vb-range-break', label: 'Break of the recent range', detail: 'Close is beyond the prior 20-bar high (long) or low (short).' },
  { key: 'vb-not-overextended', label: 'Breakout not overextended', detail: 'Distance past the broken level is within ~0.8 ATR, so the entry is not chasing a stretched candle.' },
  { key: 'vb-volume-expansion', label: 'Volume expansion on the break', detail: 'Relative volume above ~1.5× confirms real participation behind the move.' },
  { key: 'vb-trend-context', label: 'Higher-timeframe not fighting it', detail: 'The 1h EMA structure / BTC context is aligned with, or at least neutral to, the breakout direction.' },
]

const model7Signals = [
  { key: 'rf-is-ranging', label: 'Market is genuinely ranging', detail: 'Low ADX, flat EMA slope, bounded normalised price range, and a non-trending regime — proven sideways, not a pause in a trend.' },
  { key: 'rf-range-not-broken', label: 'Range boundary intact', detail: 'Price has not closed beyond the range boundary by more than ~0.2 ATR. A range break invalidates the setup.' },
  { key: 'rf-at-boundary', label: 'Price at a range extreme', detail: 'Price is in the lower ~20% of the range for longs, upper ~20% for shorts.' },
  { key: 'rf-rejection-candle', label: 'Rejection candle off the boundary', detail: 'A prominent wick shows the boundary is being defended.' },
  { key: 'rf-room-to-mid', label: 'Sufficient room toward the midpoint', detail: 'The distance to the range midpoint is at least ~1.2× the stop distance.' },
]

const model8Signals = [
  { key: 'fc-funding-extreme', label: 'Funding rate at an extreme', detail: 'Funding is significantly negative (longs) or positive (shorts), or in the top/bottom decile of its own history. Funding alone never triggers a trade — it is only context.' },
  { key: 'fc-funding-available', label: 'Genuine funding history for the period', detail: 'If funding history is missing for the period, the funding-dependent setup is skipped rather than assumed.' },
  { key: 'fc-price-stretched', label: 'Price extended from VWAP / mean', detail: 'Z-score and VWAP distance confirm the crowd is offside, not just the funding print.' },
  { key: 'fc-momentum-decelerating', label: 'Momentum decelerating', detail: 'RSI slope shows the prevailing push is losing force.' },
  { key: 'fc-reversal-confirmation', label: 'Reversal candle confirmation', detail: 'A reclaim (longs) or rejection (shorts) candle closes against the crowded side.' },
  { key: 'fc-structure-hold', label: 'Support / resistance evidence', detail: 'Price is holding above a recent swing low (longs) or below a recent swing high (shorts).' },
]

const model9Signals = [
  { key: 'hp-4h-trend', label: 'Completed 4H EMA50 / EMA200 trend', detail: 'Longs require the completed 4H EMA50 above EMA200; shorts require the reverse.' },
  { key: 'hp-rsi2-exhaustion', label: '1H RSI(2) exhaustion', detail: 'The 1H pullback must reach RSI(2) <= 10 in the prevailing 4H trend direction.' },
  { key: 'hp-volume-confirmation', label: '1H volume at least its prior 20-bar mean', detail: 'The reversal occurs with real participation, not a thin-candle fluctuation.' },
  { key: 'hp-taker-flow', label: 'Direction-aligned taker flow', detail: 'Taker-buy share is at least 50% for longs and at most 50% for shorts.' },
  { key: 'hp-reclaim', label: 'Closed 1H reclaim candle', detail: 'The qualifying 1H candle closes in the trade direction and beyond the preceding close.' },
  { key: 'hp-fixed-exit', label: 'Fixed experimental exit', detail: 'A 2 ATR stop and 1 ATR target are fixed from the preregistered study; no intraday retuning.' },
]

const model10Signals = [
  { key: 'c-source-ready', label: 'A Bot 1–8 source setup is ready', detail: 'Bot 10 never invents a trade. A source engine must first emit a closed-candle setup.' },
  { key: 'c-frozen-selector', label: 'Frozen expected-R selector accepts it', detail: 'Entry-time features, source identity and stop distance must pass the stored selector.' },
  { key: 'c-ranked-candidate', label: 'Best eligible source candidate is ranked first', detail: 'Bot 10 selects one eligible candidate deterministically rather than combining positions.' },
  { key: 'c-testnet-guardrails', label: 'Separate testnet risk guardrails pass', detail: 'Exchange position, protective-order, daily-loss, size and freshness checks must all pass.' },
]

// Every LLM-driven bot scans this same small, fixed universe rather than the
// full volatility-ranked list: it bounds live-API spend and keeps a
// head-to-head comparison apples-to-apples (all five bots are asked about
// the exact same symbols on the exact same schedule).
export const LLM_TRADE_FIXED_UNIVERSE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']

// Every LLM-driven bot (Claude / GPT / Gemini / Grok / OpenRouter) is
// evaluated on the exact same five checkpoints — only the calling provider
// differs — so a head-to-head comparison is fair rather than an artifact of
// different gating.
function buildLlmModelSignals(providerLabel, apiLabel = providerLabel) {
  return [
    { key: 'llm-context-snapshot', label: 'Multi-timeframe feature snapshot built', detail: 'A closed-candle 1H/15M/5M indicator snapshot (trend, RSI, ATR, Bollinger, VWAP, volume, funding) is assembled for the live model call.' },
    { key: 'llm-live-call', label: `Live ${apiLabel} API call for this symbol/candle`, detail: `The ${apiLabel} API is called fresh for this symbol once its 5M candle has closed — never a cached or hand-coded rule.` },
    { key: 'llm-direction-decision', label: `${providerLabel} returns LONG, SHORT, or WAIT`, detail: `The model reads the snapshot and decides a direction or explicitly waits; it never defaults to a trade.` },
    { key: 'llm-confidence-gate', label: 'Confidence at or above the trade floor', detail: `${providerLabel} also returns a 0–100 confidence score. Only decisions at or above the configured floor are taken.` },
    { key: 'llm-risk-plan', label: `${providerLabel} sets its own stop/target distance`, detail: `Stop-loss and take-profit are ${providerLabel}-chosen percentages off the current close, applied to a small fixed testnet risk budget.` },
  ]
}

const model11Signals = buildLlmModelSignals('Claude', 'Anthropic Claude')
const model12Signals = buildLlmModelSignals('GPT', 'OpenAI GPT')
const model13Signals = buildLlmModelSignals('Gemini', 'Google Gemini')
const model14Signals = buildLlmModelSignals('Grok', 'xAI Grok')
const model15Signals = buildLlmModelSignals('OpenRouter', 'OpenRouter')


export const DEFAULT_BOT3_RISK_PRESET_ID = 'bot3-20'
// Risk profiles tightened 2026-08-31 to cap the loss side: lower leverage,
// tighter stops, and much smaller daily-loss / loss-count ceilings so a bad
// day can't erase the room to recover. The AI entry filter (hard-block for
// bots 1-3) skips setup families each bot has historically lost on.
export const DEFAULT_BOT1_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 100,
  leverage: 8,
  maxOpenPositions: 1,
  stopLossPercent: 0.6,
  takeProfitPercent: 1,
  maxTradesPerDay: 6,
  maxLossesPerDay: 3,
  maxLossPerDay: 18,
  dailyProfitTarget: 60,
}

export const DEFAULT_BOT2_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 120,
  leverage: 12,
  maxOpenPositions: 1,
  stopLossPercent: 0.55,
  takeProfitPercent: 1.1,
  maxTradesPerDay: 5,
  maxLossesPerDay: 3,
  maxLossPerDay: 18,
  dailyProfitTarget: 60,
}

export const DEFAULT_BOT4_MOMENTUM_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 10,
  leverage: 50,
  maxOpenPositions: 2,
  stopLossPercent: 0.2,
  takeProfitPercent: 0.4,
  maxTradesPerDay: 25,
  maxLossesPerDay: 15,
  maxLossPerDay: 15,
  dailyProfitTarget: 50,
}


// Bots 5-8 risk profiles. Deliberately modest leverage and asymmetric SL/TP that
// match each family's hypothesis (mean-reversion / range = small tight targets,
// breakout / contrarian = wider room). These are starting points the backtest
// then evaluates — the objective is dataset diversity, not tuned returns.
export const DEFAULT_BOT5_MEAN_REVERSION_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 100,
  leverage: 6,
  maxOpenPositions: 1,
  stopLossPercent: 0.7,
  takeProfitPercent: 0.9,
  maxTradesPerDay: 8,
  maxLossesPerDay: 4,
  maxLossPerDay: 18,
  dailyProfitTarget: 50,
}

export const DEFAULT_BOT6_VOLATILITY_BREAKOUT_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 80,
  leverage: 10,
  maxOpenPositions: 1,
  stopLossPercent: 0.8,
  takeProfitPercent: 1.6,
  maxTradesPerDay: 6,
  maxLossesPerDay: 3,
  maxLossPerDay: 18,
  dailyProfitTarget: 60,
}

export const DEFAULT_BOT7_RANGE_FADE_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 100,
  leverage: 6,
  maxOpenPositions: 1,
  stopLossPercent: 0.5,
  takeProfitPercent: 0.8,
  maxTradesPerDay: 8,
  maxLossesPerDay: 4,
  maxLossPerDay: 15,
  dailyProfitTarget: 45,
}

export const DEFAULT_BOT8_FUNDING_CONTRARIAN_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 100,
  leverage: 8,
  maxOpenPositions: 1,
  stopLossPercent: 0.9,
  takeProfitPercent: 1.4,
  maxTradesPerDay: 4,
  maxLossesPerDay: 3,
  maxLossPerDay: 15,
  dailyProfitTarget: 45,
}

// Experimental only: based on a validation-rejected high-hit-rate study.
// Small testnet sizing is intentional; it must earn a forward sample before
// it can be considered for any promotion.
export const DEFAULT_BOT9_HIGH_PRECISION_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 10,
  leverage: 5,
  maxOpenPositions: 1,
  stopLossPercent: 1.5,
  takeProfitPercent: 0.75,
  maxTradesPerDay: 2,
  maxLossesPerDay: 2,
  maxLossPerDay: 5,
  dailyProfitTarget: 10,
}

export const DEFAULT_BOT10_CONSOLIDATED_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 10,
  leverage: 1,
  maxOpenPositions: 1,
  stopLossPercent: 1,
  takeProfitPercent: 1,
  maxTradesPerDay: 3,
  maxLossesPerDay: 3,
  maxLossPerDay: 3,
  dailyProfitTarget: 10,
}

// Every LLM-driven bot (Claude / GPT / Gemini / Grok / OpenRouter) shares
// the same small, testnet-scoped footprint as the other experimental bots
// (9/10) until it has earned a forward sample — and the same footprint
// across all five keeps a head-to-head comparison about the model's calls,
// not different risk sizing.
const DEFAULT_LLM_BOT_SETTINGS = {
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 10,
  leverage: 5,
  maxOpenPositions: 1,
  stopLossPercent: 1,
  takeProfitPercent: 1.5,
  maxTradesPerDay: 4,
  maxLossesPerDay: 3,
  maxLossPerDay: 8,
  dailyProfitTarget: 15,
}

export const DEFAULT_BOT11_CLAUDE_SETTINGS = { ...DEFAULT_LLM_BOT_SETTINGS }
export const DEFAULT_BOT12_GPT_SETTINGS = { ...DEFAULT_LLM_BOT_SETTINGS }
export const DEFAULT_BOT13_GEMINI_SETTINGS = { ...DEFAULT_LLM_BOT_SETTINGS }
export const DEFAULT_BOT14_GROK_SETTINGS = { ...DEFAULT_LLM_BOT_SETTINGS }
export const DEFAULT_BOT15_OPENROUTER_SETTINGS = { ...DEFAULT_LLM_BOT_SETTINGS }

const SIGNAL_MODEL_DEFAULT_STRATEGY_OVERRIDES = {
  'model-1': DEFAULT_BOT1_SETTINGS,
  'model-2': DEFAULT_BOT2_SETTINGS,
  'model-4': DEFAULT_BOT4_MOMENTUM_SETTINGS,
  'model-5': DEFAULT_BOT5_MEAN_REVERSION_SETTINGS,
  'model-6': DEFAULT_BOT6_VOLATILITY_BREAKOUT_SETTINGS,
  'model-7': DEFAULT_BOT7_RANGE_FADE_SETTINGS,
  'model-8': DEFAULT_BOT8_FUNDING_CONTRARIAN_SETTINGS,
  'model-9': DEFAULT_BOT9_HIGH_PRECISION_SETTINGS,
  'model-10': DEFAULT_BOT10_CONSOLIDATED_SETTINGS,
  'model-11': DEFAULT_BOT11_CLAUDE_SETTINGS,
  'model-12': DEFAULT_BOT12_GPT_SETTINGS,
  'model-13': DEFAULT_BOT13_GEMINI_SETTINGS,
  'model-14': DEFAULT_BOT14_GROK_SETTINGS,
  'model-15': DEFAULT_BOT15_OPENROUTER_SETTINGS,
}

export const BOT3_RISK_PRESETS = [
  {
    id: DEFAULT_BOT3_RISK_PRESET_ID,
    name: '20 USDT Profit',
    tag: 'Current',
    description: 'Bot 3 balance-risk profile, loss-capped for AI training. On a 1,000 USDT wallet a full 2R winner is roughly 15 USDT before fees.',
    mode: 'balance-risk',
    riskPerTradePercent: 0.75,
    suggestedRiskFloorPercent: 0.75,
    suggestedRiskCeilingPercent: 0.75,
    maxLossesPerDay: 3,
    dailyMaxLossPercent: 2,
    estimatedStopLossPercent: 1,
    summary: 'Bot 3 risks 0.75% of running balance per trade, stops after 3 losing trades, and caps the day at 2% loss.',
  },
  {
    id: 'bot3-10',
    name: '10 USDT Profit',
    tag: 'Lower Risk',
    description: 'Cuts Bot 3 risk in half. On a 1,000 USDT wallet, a full 2R winner is roughly 10 USDT before fees.',
    mode: 'balance-risk',
    riskPerTradePercent: 0.5,
    suggestedRiskFloorPercent: 0.5,
    suggestedRiskCeilingPercent: 0.5,
    maxLossesPerDay: 3,
    dailyMaxLossPercent: 1.5,
    estimatedStopLossPercent: 1,
    summary: 'Bot 3 risks 0.5% of running balance per trade, stops after 3 losing trades, and caps the day at 1.5% loss.',
  },
]

export function getBot3RiskPreset(presetId = DEFAULT_BOT3_RISK_PRESET_ID) {
  return BOT3_RISK_PRESETS.find((preset) => preset.id === presetId) || BOT3_RISK_PRESETS[0]
}

export function resolveBot3RiskPresetId(presetId = DEFAULT_BOT3_RISK_PRESET_ID) {
  return getBot3RiskPreset(presetId).id
}

function getResolvedSignalModelRiskProfile(signalModel, strategy = {}) {
  if (signalModel?.id === 'model-3') {
    return getBot3RiskPreset(strategy?.bot3RiskPresetId)
  }

  return signalModel?.riskProfile || null
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function buildSignalModelStrategySnapshot(strategy = {}) {
  return SIGNAL_MODEL_STRATEGY_OVERRIDE_KEYS.reduce((snapshot, key) => {
    snapshot[key] = strategy?.[key]
    return snapshot
  }, {})
}

function normalizeSignalModelStrategyOverride(modelId, override, strategy = {}) {
  const baseSnapshot = {
    ...buildSignalModelStrategySnapshot(strategy),
    ...(SIGNAL_MODEL_DEFAULT_STRATEGY_OVERRIDES[modelId] || {}),
  }
  const source = override && typeof override === 'object' ? override : {}
  const normalized = SIGNAL_MODEL_STRATEGY_OVERRIDE_KEYS.reduce((accumulator, key) => {
    accumulator[key] = key in source ? source[key] : baseSnapshot[key]
    return accumulator
  }, {})

  normalized.marginMode = normalizeMarginMode(normalized.marginMode || DEFAULT_MARGIN_MODE)
  normalized.useSymbolRiskProfile = normalized.useSymbolRiskProfile !== false
  normalized.tradeStylePresetId = resolveTradeStylePresetId(normalized, source.tradeStylePresetId)
  normalized.maxLossPerTrade = getStrategyDerivedMaxLossPerTrade(normalized)
  return normalized
}

export function normalizeSymbolRiskProfiles(profiles = {}) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return {}
  return Object.fromEntries(Object.entries(profiles).map(([rawSymbol, rawProfile]) => {
    const symbol = String(rawSymbol || '').trim().toUpperCase()
    const leverage = Number(rawProfile?.leverage)
    const stopLossPercent = Number(rawProfile?.stopLossPercent)
    const takeProfitPercent = Number(rawProfile?.takeProfitPercent)
    return symbol && Number.isFinite(leverage) && leverage > 0 && Number.isFinite(stopLossPercent) && stopLossPercent > 0 && Number.isFinite(takeProfitPercent) && takeProfitPercent > 0
      ? [symbol, { leverage, stopLossPercent, takeProfitPercent }]
      : null
  }).filter(Boolean))
}

function calculateMarginFromNotional(notional, leverage) {
  const resolvedNotional = toFiniteNumber(notional)
  const resolvedLeverage = toFiniteNumber(leverage)

  if (resolvedNotional <= 0 || resolvedLeverage <= 0) {
    return 0
  }

  return roundMoney(resolvedNotional / resolvedLeverage)
}

export const SIGNAL_MODELS = [
  {
    id: 'model-1',
    name: 'Bot 1',
    tag: 'Zone Confirmation',
    status: 'live',
    strategyFamily: 'zone-reversal-breakout',
    description: 'Baseline professional support/resistance engine: treat levels as zones, wait for a real rejection pattern or a decisive breakout close, and only enter after a closed 5M confirmation.',
    executionRule: 'Auto-trade only after a closed 15M zone reaction or breakout plus a closed 5M confirmation. Need 6 of 8 signals aligned.',
    minimumScore: 6,
    totalSignals: model1Signals.length,
    professionalSignalCount: 0,
    signals: model1Signals,
  },
  {
    id: 'model-2',
    name: 'Bot 2',
    tag: 'Order-Flow Filters',
    status: 'ready',
    strategyFamily: 'flow-funding-confirmation',
    description: 'Bot 1 plus professional order-flow filters from delta, order book imbalance, and funding bias before the bot is allowed to enter.',
    executionRule: 'Auto-trade only after the Bot 1 structure confirms. Need 8 of 11 signals aligned and at least 2 of 3 professional filters.',
    minimumScore: 8,
    totalSignals: model1Signals.length + model2AdditionalSignals.length,
    professionalSignalCount: model2AdditionalSignals.length,
    signals: [...model1Signals, ...model2AdditionalSignals],
    additionalSignals: model2AdditionalSignals,
  },
  {
    id: 'model-3',
    name: 'Bot 3',
    tag: 'Trend Pullback + Retest',
    status: 'ready',
    strategyFamily: 'trend-pullback',
    description: 'Trend-following model built around structure, EMA, VWAP, and professional retests. It waits for pullbacks or breakout retests in trend direction and only acts after a closed 5M continuation trigger.',
    executionRule: 'Auto-trade when a pullback / retest context, a closed 5M continuation trigger, and 1:2 reward room line up. Need 4 of 8 signals. Higher-timeframe structure alignment is scored but no longer mandatory. Risk is handled by Bot 3\'s selected profit preset.',
    minimumScore: 4,
    totalSignals: model3Signals.length,
    professionalSignalCount: 0,
    signals: model3Signals,
    riskProfile: getBot3RiskPreset(),
  },
  {
    id: 'model-4',
    name: 'Bot 4',
    tag: 'AI-Gated EMA/RSI Scalper',
    status: 'ready',
    strategyFamily: 'momentum',
    description: 'Derives a simple 15M EMA20/EMA50 + 5M RSI14 directional bias across the full preferred-symbols universe, then hands the entry decision entirely to the AI entry score. Fixed 10 USDT margin at 50x with a hard 1 USDT loss cut per trade.',
    executionRule: 'Scan every preferred symbol. Long bias when 15M EMA20 > EMA50 and 5M RSI14 >= 50 (short bias mirrored). The AI entry score is the only go / no-go gate (hard block); while it has no self-trained policy it runs in bootstrap mode and takes every biased setup to build the dataset. Each trade uses 10 USDT margin at 50x, exits immediately once unrealized PnL hits -1 USDT, lets the take-profit run, and is capped at 40 trades per day.',
    minimumScore: 0,
    totalSignals: model4Signals.length,
    professionalSignalCount: 0,
    signals: model4Signals,
  },
  {
    id: 'model-5',
    name: 'Bot 5',
    tag: 'Mean Reversion',
    status: 'ready',
    strategyFamily: 'mean-reversion',
    description: 'Fades statistically stretched moves back toward the 20-bar mean / VWAP during non-trending or exhausted markets. Requires exhaustion and reclaim evidence — it does not blindly buy every oversold reading.',
    executionRule: 'Only when the regime is not a strong trend. Needs 7 of 8 signals: z-score stretch, Bollinger extreme, RSI extreme, ATR-normalised stretch, weakening pressure, reversal/reclaim candle, and volume exhaustion. Targets the mean; stop beyond the extreme.',
    minimumScore: 7,
    totalSignals: model5Signals.length,
    professionalSignalCount: 0,
    signals: model5Signals,
  },
  {
    id: 'model-6',
    name: 'Bot 6',
    tag: 'Volatility Breakout',
    status: 'ready',
    strategyFamily: 'volatility-breakout',
    description: 'Captures genuine expansion out of compression: Bollinger squeeze / ATR compression followed by an ATR-normalised break of the recent range on expanding volume. Avoids chasing overextended breakout candles.',
    executionRule: 'Needs 5 of 6 signals: prior compression, ATR now expanding, range break within ~0.8 ATR, relative volume > 1.5, a decisive closed breakout candle, and higher-timeframe context not fighting the move. Stop back inside the range; target a measured move capped at 3R.',
    minimumScore: 5,
    totalSignals: model6Signals.length,
    professionalSignalCount: 0,
    signals: model6Signals,
  },
  {
    id: 'model-7',
    name: 'Bot 7',
    tag: 'Range / S-R Fade',
    status: 'ready',
    strategyFamily: 'range-fade',
    description: 'Trades established sideways ranges rather than trend continuation. First proves the market is ranging (low ADX, flat EMA slope, bounded range, non-trending regime), then fades the boundaries toward the midpoint. A range break invalidates the setup. Complements Bot 3.',
    executionRule: 'Range must be proven first. Needs 4 of 5 fade signals: price at a range extreme, rejection candle, momentum stabilising, and room to the midpoint of at least 1.2× the stop. Does not fade trend breakouts.',
    minimumScore: 4,
    totalSignals: model7Signals.length,
    professionalSignalCount: 0,
    signals: model7Signals,
  },
  {
    id: 'model-8',
    name: 'Bot 8',
    tag: 'Funding Contrarian',
    status: 'ready',
    strategyFamily: 'funding-contrarian',
    description: 'High-frequency testnet funding-contrarian profile. It scans every current volatile USDT market and evaluates all six available funding/price signals. Genuine extreme funding remains mandatory; the remaining confirmations are intentionally permissive to collect more test observations.',
    executionRule: 'Requires genuine extreme funding plus any 2 of 5 available price/action confirmations: z-score / VWAP extension, decelerating momentum, a reversal candle, and swing-structure hold. Ten entries per Manila day are allowed regardless of prior wins or losses, subject to exchange, balance, and safety protections. AI monitors open trades: it can emergency-exit a deteriorating position or extend a near-target winner only when its learned policy supports that action.',
    minimumScore: 3,
    totalSignals: model8Signals.length,
    professionalSignalCount: 0,
    signals: model8Signals,
  },
  {
    id: 'model-9',
    name: 'Bot 9',
    tag: 'Experimental High Precision',
    status: 'experimental',
    strategyFamily: 'trend-pullback-reversion',
    description: 'Experimental testnet-only trend pullback with 4H trend, 1H RSI(2) exhaustion, real volume, taker-flow, and reclaim confirmation. Its research validation failed; forward testnet observation is the only purpose.',
    executionRule: 'Completed 4H trend plus a closed 1H exhaustion-and-reclaim sequence. Fixed 2 ATR stop / 1 ATR target. Maximum two testnet entries daily; never use as a validated production signal.',
    minimumScore: 6,
    totalSignals: model9Signals.length,
    professionalSignalCount: 0,
    signals: model9Signals,
  },
  {
    id: 'model-10',
    name: 'Bot 10',
    tag: 'Consolidated Knowledge',
    status: 'experimental',
    strategyFamily: 'consolidated-selector',
    description: 'The separate Bot 10 selector ranks eligible source setups from Bots 1–8 using its frozen entry-time model. It has its own wallet card and testnet ledger, but never duplicates ordinary wallet execution.',
    executionRule: 'A source Bot 1–8 setup must be ready, accepted by the frozen selector, ranked first, current on the latest bar, and pass Bot 10’s separate Binance Futures Testnet safety checks.',
    minimumScore: 4,
    totalSignals: model10Signals.length,
    professionalSignalCount: 0,
    signals: model10Signals,
  },
  {
    id: 'model-11',
    name: 'Bot Claude',
    tag: 'Claude AI Trader',
    status: 'experimental',
    strategyFamily: 'llm-claude',
    description: 'The first of a family of LLM-driven bots (Bot Claude, Bot GPT, Bot Gemini, Bot Grok, Bot OpenRouter) meant to compare how different frontier models trade the same market. Every scan cycle it sends a fresh multi-timeframe feature snapshot to the Anthropic Claude API and lets the model decide direction, confidence, and its own stop/target — there is no hand-coded technical rule engine behind this bot.',
    executionRule: 'Once a symbol’s 5M candle closes, Claude is called live with that symbol’s 1H/15M/5M snapshot. A trade is only taken when Claude returns LONG or SHORT with confidence at or above the configured floor; Claude also sets the stop-loss/take-profit percentages. Scans a small fixed universe (BTC/ETH/SOL/BNB) to bound API spend and keep the comparison apples-to-apples. Runs on a small, testnet-scoped risk budget until it has earned a forward sample.',
    minimumScore: 60,
    totalSignals: model11Signals.length,
    professionalSignalCount: 0,
    signals: model11Signals,
    fixedUniverseSymbols: LLM_TRADE_FIXED_UNIVERSE_SYMBOLS,
  },
  {
    id: 'model-12',
    name: 'Bot GPT',
    tag: 'GPT AI Trader',
    status: 'experimental',
    strategyFamily: 'llm-gpt',
    description: 'Bot Claude\'s sibling in the frontier-model comparison family, calling OpenAI\'s API instead. Sees the exact same multi-timeframe feature snapshot, on the same schedule, with the same confidence floor and risk budget as Bot Claude — the only thing that differs is which model answers.',
    executionRule: 'Once a symbol’s 5M candle closes, GPT is called live with that symbol’s 1H/15M/5M snapshot. A trade is only taken when GPT returns LONG or SHORT with confidence at or above the configured floor; GPT also sets the stop-loss/take-profit percentages. Scans the same small fixed universe (BTC/ETH/SOL/BNB) as its siblings. Runs on a small, testnet-scoped risk budget until it has earned a forward sample.',
    minimumScore: 60,
    totalSignals: model12Signals.length,
    professionalSignalCount: 0,
    signals: model12Signals,
    fixedUniverseSymbols: LLM_TRADE_FIXED_UNIVERSE_SYMBOLS,
  },
  {
    id: 'model-13',
    name: 'Bot Gemini',
    tag: 'Gemini AI Trader',
    status: 'experimental',
    strategyFamily: 'llm-gemini',
    description: 'Bot Claude\'s sibling in the frontier-model comparison family, calling Google\'s Gemini API instead. Sees the exact same multi-timeframe feature snapshot, on the same schedule, with the same confidence floor and risk budget as Bot Claude — the only thing that differs is which model answers.',
    executionRule: 'Once a symbol’s 5M candle closes, Gemini is called live with that symbol’s 1H/15M/5M snapshot. A trade is only taken when Gemini returns LONG or SHORT with confidence at or above the configured floor; Gemini also sets the stop-loss/take-profit percentages. Scans the same small fixed universe (BTC/ETH/SOL/BNB) as its siblings. Runs on a small, testnet-scoped risk budget until it has earned a forward sample.',
    minimumScore: 60,
    totalSignals: model13Signals.length,
    professionalSignalCount: 0,
    signals: model13Signals,
    fixedUniverseSymbols: LLM_TRADE_FIXED_UNIVERSE_SYMBOLS,
  },
  {
    id: 'model-14',
    name: 'Bot Grok',
    tag: 'Grok AI Trader',
    status: 'experimental',
    strategyFamily: 'llm-grok',
    description: 'Bot Claude\'s sibling in the frontier-model comparison family, calling xAI\'s Grok API instead. Sees the exact same multi-timeframe feature snapshot, on the same schedule, with the same confidence floor and risk budget as Bot Claude — the only thing that differs is which model answers.',
    executionRule: 'Once a symbol’s 5M candle closes, Grok is called live with that symbol’s 1H/15M/5M snapshot. A trade is only taken when Grok returns LONG or SHORT with confidence at or above the configured floor; Grok also sets the stop-loss/take-profit percentages. Scans the same small fixed universe (BTC/ETH/SOL/BNB) as its siblings. Runs on a small, testnet-scoped risk budget until it has earned a forward sample.',
    minimumScore: 60,
    totalSignals: model14Signals.length,
    professionalSignalCount: 0,
    signals: model14Signals,
    fixedUniverseSymbols: LLM_TRADE_FIXED_UNIVERSE_SYMBOLS,
  },
  {
    id: 'model-15',
    name: 'Bot OpenRouter',
    tag: 'OpenRouter AI Trader',
    status: 'experimental',
    strategyFamily: 'llm-openrouter',
    description: 'Bot Claude\'s sibling in the frontier-model comparison family, routed through OpenRouter instead of a single provider — defaults to a Llama model so the five-bot roster covers five distinct model families, but can be pointed at any model OpenRouter serves. Sees the exact same multi-timeframe feature snapshot, on the same schedule, with the same confidence floor and risk budget as Bot Claude.',
    executionRule: 'Once a symbol’s 5M candle closes, the configured OpenRouter model is called live with that symbol’s 1H/15M/5M snapshot. A trade is only taken when it returns LONG or SHORT with confidence at or above the configured floor; it also sets the stop-loss/take-profit percentages. Scans the same small fixed universe (BTC/ETH/SOL/BNB) as its siblings. Runs on a small, testnet-scoped risk budget until it has earned a forward sample.',
    minimumScore: 60,
    totalSignals: model15Signals.length,
    professionalSignalCount: 0,
    signals: model15Signals,
    fixedUniverseSymbols: LLM_TRADE_FIXED_UNIVERSE_SYMBOLS,
  },
]

export function getSignalModel(modelId) {
  return SIGNAL_MODELS.find((model) => model.id === modelId) || SIGNAL_MODELS[0]
}

export function ensureSignalModelId(modelId) {
  return getSignalModel(modelId).id
}

export function getSignalModelName(modelId) {
  return getSignalModel(modelId).name
}

export function getSignalModelRiskProfile(modelId, strategy = {}) {
  return getResolvedSignalModelRiskProfile(getSignalModel(modelId), strategy) || null
}

export function buildDefaultSignalModelStrategies(strategy = {}) {
  return Object.fromEntries(
    SIGNAL_MODEL_STRATEGY_OVERRIDE_IDS.map((modelId) => [
      modelId,
      normalizeSignalModelStrategyOverride(modelId, {}, strategy),
    ]),
  )
}

export function normalizeSignalModelStrategies(signalModelStrategies = {}, strategy = {}) {
  const source = signalModelStrategies && typeof signalModelStrategies === 'object'
    ? signalModelStrategies
    : {}

  return Object.fromEntries(
    SIGNAL_MODEL_STRATEGY_OVERRIDE_IDS.map((modelId) => [
      modelId,
      normalizeSignalModelStrategyOverride(modelId, source[modelId], strategy),
    ]),
  )
}

export function getSignalModelStrategyOverride(strategy = {}, modelId) {
  const signalModel = getSignalModel(modelId || strategy?.activeSignalModelId)

  if (!SIGNAL_MODEL_STRATEGY_OVERRIDE_IDS.includes(signalModel.id)) {
    return null
  }

  const normalizedStrategies = normalizeSignalModelStrategies(strategy?.signalModelStrategies, strategy)
  return normalizedStrategies[signalModel.id] || null
}

export function getSignalModelTrackedSymbols(modelId, strategySymbols = []) {
  const signalModel = getSignalModel(modelId)
  if (Array.isArray(signalModel.fixedUniverseSymbols) && signalModel.fixedUniverseSymbols.length > 0) {
    return [...new Set(signalModel.fixedUniverseSymbols.map((symbol) => String(symbol || '').toUpperCase()).filter(Boolean))]
  }

  return Array.isArray(strategySymbols)
    ? [...new Set(strategySymbols.map((symbol) => String(symbol || '').toUpperCase()).filter(Boolean))]
    : []
}

export function getEffectiveSignalModelStrategy(strategy = {}, modelId, { runningBalance = null, symbol = null } = {}) {
  const signalModel = getSignalModel(modelId || strategy?.activeSignalModelId)
  const resolvedBot3RiskPresetId = signalModel.id === 'model-3'
    ? resolveBot3RiskPresetId(strategy?.bot3RiskPresetId)
    : null
  const riskProfile = getResolvedSignalModelRiskProfile(signalModel, strategy)
  const signalModelStrategies = normalizeSignalModelStrategies(strategy?.signalModelStrategies, strategy)
  const strategyOverride = signalModelStrategies[signalModel.id] || null
  const resolvedSymbol = String(symbol || '').trim().toUpperCase()
  const symbolRiskProfiles = normalizeSymbolRiskProfiles(strategy?.symbolRiskProfiles)
  const symbolRiskProfile = strategyOverride?.useSymbolRiskProfile !== false && resolvedSymbol ? symbolRiskProfiles[resolvedSymbol] || null : null
  const baseStrategy = {
    ...strategy,
    ...(resolvedBot3RiskPresetId ? { bot3RiskPresetId: resolvedBot3RiskPresetId } : {}),
    ...(strategyOverride ? strategyOverride : {}),
    ...(symbolRiskProfile || {}),
    signalModelStrategies,
    symbolRiskProfiles,
    symbolRiskProfileSymbol: resolvedSymbol || null,
    symbolRiskProfile: symbolRiskProfile || null,
  }
  const baseMaxLossPerTrade = getStrategyDerivedMaxLossPerTrade(baseStrategy)
  const resolvedBaseStrategy = {
    ...baseStrategy,
    maxLossPerTrade: baseMaxLossPerTrade,
  }

  if (!riskProfile || riskProfile.mode !== 'balance-risk') {
    return {
      ...resolvedBaseStrategy,
      maxLossPerTrade: baseMaxLossPerTrade,
      signalModelId: signalModel.id,
      signalModelName: signalModel.name,
      ...(resolvedBot3RiskPresetId ? { bot3RiskPresetId: resolvedBot3RiskPresetId } : {}),
      riskProfile: null,
      usesDedicatedRiskProfile: false,
    }
  }

  const resolvedRunningBalance = toFiniteNumber(runningBalance ?? resolvedBaseStrategy.runningBalance, 0)
  const riskPerTradePercent = Math.max(toFiniteNumber(riskProfile.riskPerTradePercent), 0)
  const dailyMaxLossPercent = Math.max(toFiniteNumber(riskProfile.dailyMaxLossPercent), 0)
  const estimatedStopLossPercent = Math.max(
    toFiniteNumber(symbolRiskProfile?.stopLossPercent ?? riskProfile.estimatedStopLossPercent, resolvedBaseStrategy.stopLossPercent),
    0,
  )
  const configuredRiskAmount = resolvedRunningBalance > 0
    ? roundMoney(resolvedRunningBalance * (riskPerTradePercent / 100))
    : baseMaxLossPerTrade
  const estimatedPositionNotional = configuredRiskAmount > 0 && estimatedStopLossPercent > 0
    ? roundMoney(configuredRiskAmount / (estimatedStopLossPercent / 100))
    : getStrategyPositionNotional(resolvedBaseStrategy)
  const estimatedMarginPerTrade = calculateMarginFromNotional(estimatedPositionNotional, resolvedBaseStrategy.leverage)
  const maxLossPerDay = resolvedRunningBalance > 0 && dailyMaxLossPercent > 0
    ? roundMoney(resolvedRunningBalance * (dailyMaxLossPercent / 100))
    : toFiniteNumber(resolvedBaseStrategy.maxLossPerDay)

  return {
    ...resolvedBaseStrategy,
    marginPerTrade: estimatedMarginPerTrade > 0 ? estimatedMarginPerTrade : toFiniteNumber(resolvedBaseStrategy.marginPerTrade),
    stopLossPercent: estimatedStopLossPercent > 0 ? estimatedStopLossPercent : toFiniteNumber(resolvedBaseStrategy.stopLossPercent),
    maxLossPerTrade: configuredRiskAmount > 0 ? configuredRiskAmount : baseMaxLossPerTrade,
    maxLossPerDay: maxLossPerDay > 0 ? maxLossPerDay : toFiniteNumber(resolvedBaseStrategy.maxLossPerDay),
    maxLossesPerDay: Number.isFinite(Number(riskProfile.maxLossesPerDay))
      ? Number(riskProfile.maxLossesPerDay)
      : toFiniteNumber(resolvedBaseStrategy.maxLossesPerDay),
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    ...(resolvedBot3RiskPresetId ? { bot3RiskPresetId: resolvedBot3RiskPresetId } : {}),
    runningBalance: resolvedRunningBalance > 0 ? resolvedRunningBalance : null,
    riskProfile,
    usesDedicatedRiskProfile: true,
  }
}

export function calculateSignalModelPositionSizing({
  strategy = {},
  signalModelId = DEFAULT_SIGNAL_MODEL_ID,
  entryPrice,
  stopLoss,
  runningBalance = null,
  symbol = null,
} = {}) {
  const effectiveStrategy = getEffectiveSignalModelStrategy(strategy, signalModelId, {
    runningBalance,
    symbol: symbol || strategy?.symbolRiskProfileSymbol,
  })
  const resolvedEntryPrice = toFiniteNumber(entryPrice)
  const resolvedStopLoss = toFiniteNumber(stopLoss)
  const riskRatio = resolvedEntryPrice > 0 && resolvedStopLoss > 0
    ? Math.abs(resolvedStopLoss - resolvedEntryPrice) / resolvedEntryPrice
    : 0
  const configuredStopLossPercent = riskRatio > 0
    ? Number((riskRatio * 100).toFixed(4))
    : toFiniteNumber(effectiveStrategy.stopLossPercent)
  const basePositionNotional = getStrategyPositionNotional(effectiveStrategy)

  if (effectiveStrategy.usesDedicatedRiskProfile && riskRatio > 0 && effectiveStrategy.maxLossPerTrade > 0) {
    const positionNotional = roundMoney(effectiveStrategy.maxLossPerTrade / riskRatio)
    return {
      strategy: effectiveStrategy,
      positionNotional,
      margin: calculateMarginFromNotional(positionNotional, effectiveStrategy.leverage),
      maxLossPerTrade: roundMoney(effectiveStrategy.maxLossPerTrade),
      configuredStopLossPercent,
      riskRatio,
    }
  }

  const configuredRiskBudget = roundMoney(toFiniteNumber(effectiveStrategy.maxLossPerTrade))
  const riskCappedPositionNotional = riskRatio > 0 && configuredRiskBudget > 0
    ? roundMoney(configuredRiskBudget / riskRatio)
    : 0
  // Fixed-margin bots should not let a wider structural stop expand the actual loss
  // beyond the configured budget, but they also should not exceed the configured size.
  const positionNotional = riskCappedPositionNotional > 0
    ? (basePositionNotional > 0 ? Math.min(basePositionNotional, riskCappedPositionNotional) : riskCappedPositionNotional)
    : basePositionNotional
  const margin = positionNotional > 0
    ? calculateMarginFromNotional(positionNotional, effectiveStrategy.leverage)
    : toFiniteNumber(effectiveStrategy.marginPerTrade)
  const inferredRiskAmount = riskRatio > 0
    ? roundMoney(positionNotional * riskRatio)
    : configuredRiskBudget

  return {
    strategy: effectiveStrategy,
    positionNotional,
    margin: margin > 0 ? margin : toFiniteNumber(effectiveStrategy.marginPerTrade),
    maxLossPerTrade: inferredRiskAmount,
    configuredStopLossPercent,
    riskRatio,
  }
}
