import { STARTING_RUNNING_BALANCE_USDT } from './tradingConfig.js'

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function roundMoney(value) {
  return Number(toFiniteNumber(value).toFixed(2))
}

export function isTradeOpen(trade) {
  return trade?.status === 'OPEN'
}

export function isTradeClosed(trade) {
  return trade?.status === 'CLOSED_TP'
    || trade?.status === 'CLOSED_SL'
    || trade?.status === 'CLOSED_MANUAL'
    || trade?.pnl != null
    || trade?.exitPrice != null
}

export function getTradeRiskRatio(trade, strategy = {}) {
  const entryPrice = toFiniteNumber(trade?.entryPrice)
  const stopLoss = toFiniteNumber(trade?.stopLoss)

  if (entryPrice > 0 && stopLoss > 0) {
    return Math.abs(stopLoss - entryPrice) / entryPrice
  }

  const configuredPercent = toFiniteNumber(trade?.configuredStopLossPercent ?? strategy?.stopLossPercent)
  return configuredPercent > 0 ? configuredPercent / 100 : null
}

export function getTradeMaxLossPerTrade(trade, strategy = {}) {
  const riskRatio = getTradeRiskRatio(trade, strategy)
  const notional = toFiniteNumber(trade?.notional)

  if (riskRatio == null || notional <= 0) {
    return 0
  }

  return roundMoney(riskRatio * notional)
}

export function getTradeRiskAmount(trade, strategy = {}) {
  return getTradeMaxLossPerTrade(trade, strategy)
}

export function buildStopLossFromRisk(entryPrice, side, riskRatio) {
  if (!entryPrice || !riskRatio) {
    return null
  }

  return side === 'BUY'
    ? entryPrice * (1 - riskRatio)
    : entryPrice * (1 + riskRatio)
}

export function getTradeEffectiveStopLoss(trade, strategy = {}) {
  const entryPrice = toFiniteNumber(trade?.entryPrice)
  const explicitStopLoss = toFiniteNumber(trade?.stopLoss)

  if (entryPrice > 0 && explicitStopLoss > 0) {
    return explicitStopLoss
  }

  const riskRatio = getTradeRiskRatio(trade, strategy)
  return buildStopLossFromRisk(entryPrice, trade?.side, riskRatio)
}

export function getTradePnlForExitPrice(trade, exitPrice) {
  const entryPrice = toFiniteNumber(trade?.entryPrice)
  const notional = toFiniteNumber(trade?.notional)
  const resolvedExitPrice = toFiniteNumber(exitPrice)

  if (!entryPrice || !notional || !resolvedExitPrice) {
    return null
  }

  const pnlRatio = trade?.side === 'BUY'
    ? (resolvedExitPrice - entryPrice) / entryPrice
    : (entryPrice - resolvedExitPrice) / entryPrice

  return roundMoney(pnlRatio * notional)
}

export function getTradeUnrealizedPnl(trade, currentPrice) {
  const entryPrice = toFiniteNumber(trade?.entryPrice)
  const notional = toFiniteNumber(trade?.notional)
  const resolvedCurrentPrice = toFiniteNumber(currentPrice)

  if (!entryPrice || !notional || !resolvedCurrentPrice) {
    return 0
  }

  const pnlRatio = trade?.side === 'BUY'
    ? (resolvedCurrentPrice - entryPrice) / entryPrice
    : (entryPrice - resolvedCurrentPrice) / entryPrice

  return roundMoney(pnlRatio * notional)
}

export function getTradeMargin(trade, strategy = {}) {
  const explicitMargin = toFiniteNumber(trade?.margin)
  if (explicitMargin > 0) {
    return explicitMargin
  }

  const leverage = toFiniteNumber(trade?.leverage ?? strategy?.leverage)
  const notional = toFiniteNumber(trade?.notional)
  if (notional > 0 && leverage > 0) {
    return roundMoney(notional / leverage)
  }

  const fallbackMargin = toFiniteNumber(strategy?.marginPerTrade)
  return fallbackMargin > 0 ? fallbackMargin : 0
}

export function getStrategyPositionNotional(strategy = {}) {
  const marginPerTrade = toFiniteNumber(strategy?.marginPerTrade)
  const leverage = toFiniteNumber(strategy?.leverage)

  if (marginPerTrade <= 0 || leverage <= 0) {
    return 0
  }

  return roundMoney(marginPerTrade * leverage)
}

export function getStrategyDerivedMaxLossPerTrade(strategy = {}) {
  const positionNotional = getStrategyPositionNotional(strategy)
  return getTradeMaxLossPerTrade({
    notional: positionNotional,
    configuredStopLossPercent: strategy?.stopLossPercent,
  }, strategy)
}

export function getStrategyDerivedTakeProfitPerTrade(strategy = {}) {
  const positionNotional = getStrategyPositionNotional(strategy)
  const takeProfitPercent = toFiniteNumber(strategy?.takeProfitPercent)

  if (positionNotional <= 0 || takeProfitPercent <= 0) {
    return 0
  }

  return roundMoney((takeProfitPercent / 100) * positionNotional)
}

export function summarizeAccount({
  trades = [],
  livePrices = {},
  strategy = {},
  startingBalance = STARTING_RUNNING_BALANCE_USDT,
} = {}) {
  const closedTrades = trades.filter((trade) => isTradeClosed(trade))
  const openTrades = trades.filter((trade) => isTradeOpen(trade))
  const wins = closedTrades.filter((trade) => toFiniteNumber(trade?.pnl) > 0).length
  const losses = closedTrades.filter((trade) => toFiniteNumber(trade?.pnl) < 0).length
  const realizedPnl = roundMoney(
    closedTrades.reduce((sum, trade) => sum + toFiniteNumber(trade?.pnl), 0),
  )
  const unrealizedPnl = roundMoney(
    openTrades.reduce((sum, trade) => (
      sum + getTradeUnrealizedPnl(trade, livePrices?.[trade.symbol])
    ), 0),
  )
  const walletBalance = roundMoney(startingBalance + realizedPnl)
  const runningBalance = roundMoney(walletBalance + unrealizedPnl)
  const reservedMargin = roundMoney(
    openTrades.reduce((sum, trade) => sum + getTradeMargin(trade, strategy), 0),
  )
  const availableBalance = roundMoney(runningBalance - reservedMargin)
  const marginPerTrade = toFiniteNumber(strategy?.marginPerTrade)
  const configuredMaxOpenPositions = Math.max(Math.floor(toFiniteNumber(strategy?.maxOpenPositions)), 0)
  const balanceBasedMaxOpenPositions = marginPerTrade > 0
    ? Math.max(Math.floor(Math.max(runningBalance, 0) / marginPerTrade), 0)
    : 0
  const effectiveMaxOpenPositions = configuredMaxOpenPositions > 0
    ? Math.min(configuredMaxOpenPositions, balanceBasedMaxOpenPositions)
    : balanceBasedMaxOpenPositions
  const availableMarginSlots = marginPerTrade > 0
    ? Math.max(Math.floor(Math.max(availableBalance, 0) / marginPerTrade), 0)
    : 0
  const remainingOpenSlots = Math.max(
    Math.min(effectiveMaxOpenPositions - openTrades.length, availableMarginSlots),
    0,
  )
  const positionNotional = getStrategyPositionNotional(strategy)
  const derivedMaxLossPerTrade = getStrategyDerivedMaxLossPerTrade(strategy)
  const riskPerTradePercentOfBalance = runningBalance > 0
    ? roundMoney((derivedMaxLossPerTrade / runningBalance) * 100)
    : 0
  const marginUtilizationPercent = runningBalance > 0
    ? roundMoney((reservedMargin / runningBalance) * 100)
    : 0

  return {
    startingBalance,
    trades,
    closedTrades,
    openTrades,
    tradeCount: trades.length,
    closedTradeCount: closedTrades.length,
    openTradeCount: openTrades.length,
    wins,
    losses,
    realizedPnl,
    unrealizedPnl,
    walletBalance,
    runningBalance,
    reservedMargin,
    availableBalance,
    marginPerTrade,
    leverage: toFiniteNumber(strategy?.leverage),
    stopLossPercent: toFiniteNumber(strategy?.stopLossPercent),
    positionNotional,
    derivedMaxLossPerTrade,
    configuredMaxOpenPositions,
    balanceBasedMaxOpenPositions,
    effectiveMaxOpenPositions,
    availableMarginSlots,
    remainingOpenSlots,
    riskPerTradePercentOfBalance,
    marginUtilizationPercent,
  }
}
