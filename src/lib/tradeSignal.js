function latestValue(series) {
  return series.length > 0 ? series[series.length - 1] : null
}

function average(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return 0
  }

  return numbers.reduce((sum, value) => sum + Number(value || 0), 0) / numbers.length
}

function candleBodySize(candle) {
  return Math.abs(Number(candle?.close || 0) - Number(candle?.open || 0))
}

function candleRange(candle) {
  return Math.max(Number(candle?.high || 0) - Number(candle?.low || 0), 0.0000001)
}

function candleMidpoint(candle) {
  return (Number(candle?.high || 0) + Number(candle?.low || 0)) / 2
}

function isAbsorptionCandle(candle, averageVolume, multiplier = 2) {
  if (!candle || averageVolume <= 0) {
    return false
  }

  return Number(candle.volume || 0) >= averageVolume * multiplier
    && (candleBodySize(candle) / candleRange(candle)) <= 0.4
}

function getRsiValueAtOrBeforeTime(series, time) {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index].time <= time) {
      return Number(series[index].value || 0)
    }
  }

  return null
}

function detectRsiDivergence(candles, rsiSeries, direction, currentIndex) {
  if (candles.length < 12 || rsiSeries.length < 4 || currentIndex < 6) {
    return false
  }

  const searchStart = Math.max(0, currentIndex - 8)
  let priorIndex = searchStart

  for (let index = searchStart + 1; index < currentIndex - 1; index += 1) {
    const betterLow = direction === 'LONG' && candles[index].low < candles[priorIndex].low
    const betterHigh = direction === 'SHORT' && candles[index].high > candles[priorIndex].high

    if (betterLow || betterHigh) {
      priorIndex = index
    }
  }

  const currentRsi = getRsiValueAtOrBeforeTime(rsiSeries, candles[currentIndex].time)
  const priorRsi = getRsiValueAtOrBeforeTime(rsiSeries, candles[priorIndex].time)

  if (currentRsi == null || priorRsi == null) {
    return false
  }

  if (direction === 'LONG') {
    return candles[currentIndex].low < candles[priorIndex].low && currentRsi > priorRsi + 2
  }

  return candles[currentIndex].high > candles[priorIndex].high && currentRsi < priorRsi - 2
}

function isWithinHighLiquidityWindow(timestamp) {
  if (!timestamp) {
    return false
  }

  const date = new Date(timestamp)
  const totalMinutes = date.getUTCHours() * 60 + date.getUTCMinutes()

  return (
    (totalMinutes >= 7 * 60 && totalMinutes <= 10 * 60 + 30)
    || (totalMinutes >= 12 * 60 + 30 && totalMinutes <= 16 * 60 + 30)
  )
}

function calculateRewardToRisk(targetPrice, entryPrice, stopPrice, direction) {
  const risk = direction === 'LONG'
    ? entryPrice - stopPrice
    : stopPrice - entryPrice
  const reward = direction === 'LONG'
    ? targetPrice - entryPrice
    : entryPrice - targetPrice

  if (risk <= 0 || reward <= 0) {
    return 0
  }

  return reward / risk
}

export function analyzeTradeSignal({ chartData, indicators, symbol }) {
  if (chartData.length < 32) {
    return {
      symbol,
      direction: 'WAIT',
      checklistSide: 'WAIT',
      summary: 'Waiting for more candles before evaluating a setup.',
      reasons: [],
      support: null,
      resistance: null,
      stopLoss: null,
      takeProfit: null,
      confidence: 0,
      entryPrice: null,
    }
  }

  const confirmationCandle = chartData[chartData.length - 1]
  const sweepCandle = chartData[chartData.length - 2]
  const recentRange = chartData.slice(-32, -2)
  const support = Math.min(...recentRange.map((item) => item.low))
  const resistance = Math.max(...recentRange.map((item) => item.high))
  const rangeSize = Math.max(resistance - support, confirmationCandle.close * 0.002)
  const averageVolume = average(chartData.slice(-22, -2).map((item) => item.volume))
  const absorptionDetected = isAbsorptionCandle(sweepCandle, averageVolume, 2) || isAbsorptionCandle(confirmationCandle, averageVolume, 2)
  const bullishSweep = sweepCandle.low < support && sweepCandle.close > support
  const bearishSweep = sweepCandle.high > resistance && sweepCandle.close < resistance
  const nearSupport = sweepCandle.close <= support + rangeSize * 0.22 || bullishSweep
  const nearResistance = sweepCandle.close >= resistance - rangeSize * 0.22 || bearishSweep
  const bullishConfirmation = bullishSweep
    && confirmationCandle.close > confirmationCandle.open
    && confirmationCandle.close > Math.max(sweepCandle.close, candleMidpoint(sweepCandle))
  const bearishConfirmation = bearishSweep
    && confirmationCandle.close < confirmationCandle.open
    && confirmationCandle.close < Math.min(sweepCandle.close, candleMidpoint(sweepCandle))
  const rsiSeries = indicators.rsi || []
  const bullishRsiDivergence = detectRsiDivergence(chartData, rsiSeries, 'LONG', chartData.length - 2)
  const bearishRsiDivergence = detectRsiDivergence(chartData, rsiSeries, 'SHORT', chartData.length - 2)
  const highLiquidityWindow = isWithinHighLiquidityWindow(confirmationCandle.time)
  const stopBuffer = Math.max(rangeSize * 0.08, confirmationCandle.close * 0.0015)
  const longStopLoss = Math.min(sweepCandle.low, confirmationCandle.low) - stopBuffer
  const shortStopLoss = Math.max(sweepCandle.high, confirmationCandle.high) + stopBuffer
  const longRisk = Math.max(confirmationCandle.close - longStopLoss, confirmationCandle.close * 0.0005)
  const shortRisk = Math.max(shortStopLoss - confirmationCandle.close, confirmationCandle.close * 0.0005)
  const longRewardRoom = calculateRewardToRisk(resistance, confirmationCandle.close, longStopLoss, 'LONG')
  const shortRewardRoom = calculateRewardToRisk(support, confirmationCandle.close, shortStopLoss, 'SHORT')
  const longTakeProfit = confirmationCandle.close + longRisk * 2
  const shortTakeProfit = confirmationCandle.close - shortRisk * 2

  const longChecks = [
    { label: 'Range edge', passed: nearSupport },
    { label: 'Liquidity sweep', passed: bullishSweep },
    { label: 'Absorption volume', passed: absorptionDetected },
    { label: 'Confirmation close', passed: bullishConfirmation },
    { label: 'RSI divergence', passed: bullishRsiDivergence },
    { label: 'London/NY session', passed: highLiquidityWindow },
    { label: 'Hidden stop with 1:2 room', passed: longRewardRoom >= 2 },
  ]

  const shortChecks = [
    { label: 'Range edge', passed: nearResistance },
    { label: 'Liquidity sweep', passed: bearishSweep },
    { label: 'Absorption volume', passed: absorptionDetected },
    { label: 'Confirmation close', passed: bearishConfirmation },
    { label: 'RSI divergence', passed: bearishRsiDivergence },
    { label: 'London/NY session', passed: highLiquidityWindow },
    { label: 'Hidden stop with 1:2 room', passed: shortRewardRoom >= 2 },
  ]

  const longScore = longChecks.filter((item) => item.passed).length
  const shortScore = shortChecks.filter((item) => item.passed).length

  if (longScore >= 5 && longScore > shortScore) {
    return {
      symbol,
      direction: 'LONG',
      checklistSide: 'LONG',
      summary: 'Bullish whale-rejection setup confirmed: support sweep, absorption, and a close-back reversal are aligned.',
      reasons: longChecks,
      support,
      resistance,
      stopLoss: longStopLoss,
      takeProfit: longTakeProfit,
      confidence: longScore / longChecks.length,
      entryPrice: confirmationCandle.close,
    }
  }

  if (shortScore >= 5 && shortScore > longScore) {
    return {
      symbol,
      direction: 'SHORT',
      checklistSide: 'SHORT',
      summary: 'Bearish whale-rejection setup confirmed: resistance sweep, absorption, and a close-back reversal are aligned.',
      reasons: shortChecks,
      support,
      resistance,
      stopLoss: shortStopLoss,
      takeProfit: shortTakeProfit,
      confidence: shortScore / shortChecks.length,
      entryPrice: confirmationCandle.close,
    }
  }

  return {
    symbol,
    direction: 'WAIT',
    checklistSide: longScore >= shortScore ? 'LONG' : 'SHORT',
    summary: "No whale-rejection edge yet. Either the sweep is missing, the confirmation close has not arrived, or the setup is sitting in the middle of the range.",
    reasons: longScore >= shortScore ? longChecks : shortChecks,
    support,
    resistance,
    stopLoss: null,
    takeProfit: null,
    confidence: Math.max(longScore, shortScore) / longChecks.length,
    entryPrice: confirmationCandle.close,
  }
}
