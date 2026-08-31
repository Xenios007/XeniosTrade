import { getStrategyDerivedMaxLossPerTrade, getStrategyPositionNotional, roundMoney } from './accountMetrics.js'
import { DEFAULT_MARGIN_MODE, normalizeMarginMode } from './marginModes.js'
import { MANUAL_TRADE_STYLE_PRESET_ID, resolveTradeStylePresetId } from './strategyPresets.js'

export const DEFAULT_SIGNAL_MODEL_ID = 'model-1'
export const SIGNAL_MODEL_STRATEGY_OVERRIDE_IDS = ['model-1', 'model-2', 'model-4']
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


const SIGNAL_MODEL_DEFAULT_STRATEGY_OVERRIDES = {
  'model-1': DEFAULT_BOT1_SETTINGS,
  'model-2': DEFAULT_BOT2_SETTINGS,
  'model-4': DEFAULT_BOT4_MOMENTUM_SETTINGS,
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
  normalized.tradeStylePresetId = resolveTradeStylePresetId(normalized, source.tradeStylePresetId)
  normalized.maxLossPerTrade = getStrategyDerivedMaxLossPerTrade(normalized)
  return normalized
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
    description: 'Derives a simple 15M EMA20/EMA50 + 5M RSI14 directional bias across the full preferred-symbols universe, then hands the entry decision entirely to the AI entry score. Fixed 10 USDT margin at 50x with a hard 1 USDT loss cut per trade.',
    executionRule: 'Scan every preferred symbol. Long bias when 15M EMA20 > EMA50 and 5M RSI14 >= 50 (short bias mirrored). The AI entry score is the only go / no-go gate (hard block); while it has no self-trained policy it runs in bootstrap mode and takes every biased setup to build the dataset. Each trade uses 10 USDT margin at 50x, exits immediately once unrealized PnL hits -1 USDT, lets the take-profit run, and is capped at 40 trades per day.',
    minimumScore: 0,
    totalSignals: model4Signals.length,
    professionalSignalCount: 0,
    signals: model4Signals,
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

export function getEffectiveSignalModelStrategy(strategy = {}, modelId, { runningBalance = null } = {}) {
  const signalModel = getSignalModel(modelId || strategy?.activeSignalModelId)
  const resolvedBot3RiskPresetId = signalModel.id === 'model-3'
    ? resolveBot3RiskPresetId(strategy?.bot3RiskPresetId)
    : null
  const riskProfile = getResolvedSignalModelRiskProfile(signalModel, strategy)
  const signalModelStrategies = normalizeSignalModelStrategies(strategy?.signalModelStrategies, strategy)
  const strategyOverride = signalModelStrategies[signalModel.id] || null
  const baseStrategy = {
    ...strategy,
    ...(resolvedBot3RiskPresetId ? { bot3RiskPresetId: resolvedBot3RiskPresetId } : {}),
    ...(strategyOverride ? strategyOverride : {}),
    signalModelStrategies,
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
    toFiniteNumber(riskProfile.estimatedStopLossPercent, resolvedBaseStrategy.stopLossPercent),
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
} = {}) {
  const effectiveStrategy = getEffectiveSignalModelStrategy(strategy, signalModelId, {
    runningBalance,
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
