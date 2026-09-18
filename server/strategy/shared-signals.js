// Shared building blocks for the strategy-family builders in this directory
// (bots5to8.js and bot-claude.js). Split out so bot-claude.js — which
// bots5to8.js imports for the BOT5TO8_BUILDERS dispatch table — never needs
// to import bots5to8.js itself, avoiding a circular module dependency.

import { calculateSignalModelPositionSizing } from '../../src/lib/signalModels.js'
import { _internals } from '../backtest/feature-lib.js'
import { classifyRegime } from '../backtest/regime.js'

const { emaSeries, rsiSeries, atrSeries, bollinger, vwapSeries, adx, mean, stdev } = _internals

export const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
export const lastOf = (a) => (a.length ? a[a.length - 1] : undefined)
export const finiteSeries = (s) => s.filter((v) => v != null)

// ---- shared indicator bundle over a closed 5m window + 1h window --------

export function indicatorBundle(entry, bias, regime4h) {
  const closes = entry.map((c) => c.close)
  const vols = entry.map((c) => c.volume)
  const price = num(lastOf(closes))
  const cur = lastOf(entry)
  const prev = entry[entry.length - 2]

  const rsiArr = finiteSeries(rsiSeries(closes, 14))
  const rsi = num(lastOf(rsiArr), 50)
  const rsiSlope = rsiArr.length > 4 ? (rsi - rsiArr[rsiArr.length - 5]) / 4 : 0

  const atrArr = finiteSeries(atrSeries(entry, 14))
  const atr = num(lastOf(atrArr), price * 0.003)

  const sma20 = mean(closes.slice(-20))
  const sd20 = stdev(closes.slice(-20))
  const zscore = sd20 > 0 ? (price - sma20) / sd20 : 0
  const atrStretch = atr > 0 ? (price - sma20) / atr : 0

  const bb = bollinger(closes, 20, 2)
  const bbWidthHist = []
  for (let i = 25; i < closes.length; i += 3) bbWidthHist.push(bollinger(closes.slice(0, i), 20, 2).width)
  const bbWidthSorted = bbWidthHist.slice().sort((a, b) => a - b)
  const bbWidthP30 = bbWidthSorted.length ? bbWidthSorted[Math.floor(bbWidthSorted.length * 0.3)] : bb.width
  const squeeze = bb.width <= bbWidthP30 ? 1 : 0

  const atrPrev = num(atrArr[Math.max(0, atrArr.length - 21)], atr)
  const atrExpanding = atr > atrPrev * 1.15
  const atrCompressed = atr < atrPrev * 0.85

  const vwap = num(lastOf(vwapSeries(entry)), price)
  const vwapDist = price > 0 ? (price - vwap) / price : 0

  const e20a = finiteSeries(emaSeries(closes, 20))
  const e50a = finiteSeries(emaSeries(closes, 50))
  const e20 = num(lastOf(e20a), price)
  const e50 = num(lastOf(e50a), e20)
  const emaDist = price > 0 ? (price - e20) / price : 0

  const relVol = mean(vols.slice(-20)) > 0 ? num(lastOf(vols)) / mean(vols.slice(-20)) : 1
  const relVolPrev = mean(vols.slice(-21, -1)) > 0 ? num(vols[vols.length - 2]) / mean(vols.slice(-21, -1)) : 1

  const win40 = entry.slice(-40)
  const recentHigh = Math.max(...win40.map((c) => c.high))
  const recentLow = Math.min(...win40.map((c) => c.low))
  const rangeBandPct = price > 0 ? (recentHigh - recentLow) / price : 0
  const rangePos = recentHigh > recentLow ? (price - recentLow) / (recentHigh - recentLow) : 0.5

  const rng = Math.max(cur.high - cur.low, 1e-12)
  const bodyRange = Math.abs(cur.close - cur.open) / rng
  const lowerWick = (Math.min(cur.open, cur.close) - cur.low) / rng
  const upperWick = (cur.high - Math.max(cur.open, cur.close)) / rng
  const bullReclaim = cur.close > cur.open && prev && cur.close > prev.close
  const bearReject = cur.close < cur.open && prev && cur.close < prev.close

  const adx1h = adx(bias, 14)
  const biasCloses = bias.map((c) => c.close)
  const be20 = num(lastOf(finiteSeries(emaSeries(biasCloses, 20))), num(lastOf(biasCloses)))
  const be50 = num(lastOf(finiteSeries(emaSeries(biasCloses, 50))), be20)
  const biasTrendGap = num(lastOf(biasCloses)) > 0 ? (be20 - be50) / num(lastOf(biasCloses)) : 0

  const reg = classifyRegime({ biasCandles: bias, entryCandles: entry, regimeCandles: regime4h })

  return {
    price, cur, prev, atr, rsi, rsiSlope, sma20, zscore, atrStretch,
    bb, squeeze, atrExpanding, atrCompressed, vwap, vwapDist, e20, e50, emaDist,
    relVol, relVolPrev, recentHigh, recentLow, rangeBandPct, rangePos,
    bodyRange, lowerWick, upperWick, bullReclaim, bearReject,
    adx1h, biasTrendGap, regime: reg.regime, trendScore: reg.trendScore,
  }
}

export function sizeAndShape({
  symbol, signalModel, effectiveStrategy, direction, entryPrice, stopLoss, takeProfit,
  score, maxScore, summary, strategyFamily, setupFamily, aiFeatures,
}) {
  const side = direction === 'LONG' ? 'BUY' : 'SELL'
  const profile = effectiveStrategy.symbolRiskProfile
  const resolvedStopLoss = profile
    ? direction === 'LONG' ? entryPrice * (1 - effectiveStrategy.stopLossPercent / 100) : entryPrice * (1 + effectiveStrategy.stopLossPercent / 100)
    : stopLoss
  const resolvedTakeProfit = profile
    ? direction === 'LONG' ? entryPrice * (1 + effectiveStrategy.takeProfitPercent / 100) : entryPrice * (1 - effectiveStrategy.takeProfitPercent / 100)
    : takeProfit
  const ps = calculateSignalModelPositionSizing({
    strategy: effectiveStrategy,
    signalModelId: signalModel.id,
    entryPrice,
    stopLoss: resolvedStopLoss,
    runningBalance: effectiveStrategy.runningBalance,
    symbol,
  })
  return {
    symbol,
    side,
    direction,
    checklistSide: direction,
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    strategyFamily,
    setupFamily,
    status: 'ready',
    ready: true,
    score,
    maxScore,
    professionalSignalScore: 0,
    professionalRequiredCount: 0,
    allSignalsPassed: score >= maxScore,
    entryPrice: Number(entryPrice.toFixed(8)),
    stopLoss: Number(resolvedStopLoss.toFixed(8)),
    takeProfit: Number(resolvedTakeProfit.toFixed(8)),
    confidence: Math.min(0.9, 0.35 + 0.1 * (score - Math.floor(maxScore / 2))),
    positionNotional: ps.positionNotional,
    margin: ps.margin,
    leverage: ps.strategy.leverage,
    configuredStopLossPercent: ps.configuredStopLossPercent,
    maxLossPerTrade: ps.maxLossPerTrade,
    summary,
    support: direction === 'LONG' ? resolvedStopLoss : resolvedTakeProfit,
    resistance: direction === 'LONG' ? resolvedTakeProfit : resolvedStopLoss,
    checklist: [],
    setupType: strategyFamily,
    patternLabel: signalModel.tag,
    aiFeatures,
  }
}

export function notReady(symbol, signalModel, effectiveStrategy, price, summary) {
  return {
    symbol,
    side: null,
    direction: 'WAIT',
    checklistSide: 'WAIT',
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    status: 'watching',
    ready: false,
    score: 0,
    maxScore: 0,
    professionalSignalScore: 0,
    professionalRequiredCount: 0,
    allSignalsPassed: false,
    entryPrice: price ?? null,
    stopLoss: null,
    takeProfit: null,
    confidence: 0,
    positionNotional: num(effectiveStrategy.marginPerTrade) * num(effectiveStrategy.leverage),
    margin: num(effectiveStrategy.marginPerTrade),
    configuredStopLossPercent: num(effectiveStrategy.stopLossPercent),
    maxLossPerTrade: num(effectiveStrategy.maxLossPerTrade),
    summary: summary || `${signalModel.name} has no qualifying setup.`,
    support: null,
    resistance: null,
    checklist: [],
    setupType: null,
    patternLabel: null,
  }
}
