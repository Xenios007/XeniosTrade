export function getTradeDirection(side) {
  if (side === 'BUY') {
    return 'LONG'
  }

  if (side === 'SELL') {
    return 'SHORT'
  }

  return 'N/A'
}

export function isAutoTradeSource(source) {
  return String(source || '') === 'AUTO'
}

export function formatTradeSource(source) {
  return String(source || 'UNKNOWN').replaceAll('_', ' ')
}

export function isTradeOpen(trade) {
  return trade?.status === 'OPEN'
}

export function getTradePnlRatio(trade, currentPrice) {
  const entryPrice = Number(trade?.entryPrice || 0)
  const price = Number(currentPrice || 0)

  if (!entryPrice || !price) {
    return null
  }

  if (trade?.side === 'BUY') {
    return (price - entryPrice) / entryPrice
  }

  if (trade?.side === 'SELL') {
    return (entryPrice - price) / entryPrice
  }

  return null
}

export function getTradePnlAmount(trade, currentPrice) {
  const ratio = getTradePnlRatio(trade, currentPrice)
  if (ratio == null) {
    return null
  }

  return ratio * Number(trade?.notional || 0)
}

export function getTradeRoiPercent(trade, currentPrice) {
  const pnlAmount = getTradePnlAmount(trade, currentPrice)
  const margin = Number(trade?.margin || 0)

  if (pnlAmount == null || !margin) {
    return null
  }

  return (pnlAmount / margin) * 100
}

export function getTradeTakeProfitGap(trade, currentPrice) {
  const takeProfit = Number(trade?.takeProfit || 0)
  const price = Number(currentPrice || 0)

  if (!takeProfit || !price) {
    return null
  }

  if (trade?.side === 'BUY') {
    return takeProfit - price
  }

  if (trade?.side === 'SELL') {
    return price - takeProfit
  }

  return null
}

export function getTradeTakeProfitGapPercent(trade, currentPrice) {
  const gap = getTradeTakeProfitGap(trade, currentPrice)
  const price = Number(currentPrice || 0)

  if (gap == null || !price) {
    return null
  }

  return (gap / price) * 100
}
