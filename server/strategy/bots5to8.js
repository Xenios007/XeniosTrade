// Bots 5-8 — genuinely different strategy families (NOT parameter variations of
// Bots 1-4). Each is a pure function that takes closed-candle windows and the
// per-bot effective strategy, and returns the same snapshot shape the server's
// buildBot4SignalSnapshot produces, or a not-ready snapshot.
//
//   Bot 5  MEAN_REVERSION      fade stretched moves toward VWAP/mean in
//                              non-trending / exhausted markets
//   Bot 6  VOLATILITY_BREAKOUT genuine expansion out of compression
//   Bot 7  RANGE_FADE          fade the boundaries of a proven sideways range
//   Bot 8  FUNDING_CONTRARIAN  trade crowded futures positioning w/ price confirm
//
// Every emitted snapshot carries strategyFamily + setupFamily so each resulting
// trade preserves which bot and hypothesis produced it.

import { _internals } from '../backtest/feature-lib.js'
import { finiteSeries, indicatorBundle, lastOf, notReady, num, sizeAndShape } from './shared-signals.js'

const { emaSeries, rsiSeries, atrSeries, mean } = _internals

export { indicatorBundle, notReady, sizeAndShape }

const MIN_ENTRY_BARS = 90

// ---- Bot 5 — MEAN REVERSION -------------------------------------------

export function buildBot5SignalSnapshot({ symbol, signalModel, effectiveStrategy, closedBiasTimeframe, closedEntryTimeframe, regime4hTimeframe = null }) {
  const entry = closedEntryTimeframe
  const bias = closedBiasTimeframe
  if (entry.length < MIN_ENTRY_BARS || bias.length < 40) return notReady(symbol, signalModel, effectiveStrategy, lastOf(entry)?.close ?? null, 'Bot 5 waiting for candle history.')
  const b = indicatorBundle(entry, bias, regime4hTimeframe)
  const strongTrend = b.regime === 'BULL_TREND' || b.regime === 'BEAR_TREND'
  const price = b.price

  // LONG: stretched down, exhausted, reclaiming — and not in a strong down-trend continuation
  const longConds = [
    !strongTrend,
    b.zscore <= -1.5,
    b.bb.position < 0.15,
    b.rsi < 42,
    b.atrStretch <= -1.3,
    b.rsiSlope > -0.6,          // selling momentum no longer accelerating
    b.bullReclaim,              // reversal/reclaim confirmation
    b.relVol < b.relVolPrev * 1.2, // volume exhaustion (not a fresh impulse)
  ]
  const shortConds = [
    !strongTrend,
    b.zscore >= 1.5,
    b.bb.position > 0.85,
    b.rsi > 58,
    b.atrStretch >= 1.3,
    b.rsiSlope < 0.6,
    b.bearReject,
    b.relVol < b.relVolPrev * 1.2,
  ]
  const longScore = longConds.filter(Boolean).length
  const shortScore = shortConds.filter(Boolean).length
  // 6 of 8 — must always include a stretch signal (z-score or ATR-stretch) plus a
  // reversal candle; enforced below.
  const NEED = 6

  // mandatory: a stretch signal + a reversal candle on the chosen side
  const longCore = (longConds[1] || longConds[4]) && longConds[6]
  const shortCore = (shortConds[1] || shortConds[4]) && shortConds[6]
  let direction = null
  let score = 0
  if (longScore >= NEED && longCore && longScore >= shortScore) { direction = 'LONG'; score = longScore }
  else if (shortScore >= NEED && shortCore) { direction = 'SHORT'; score = shortScore }
  if (!direction) return notReady(symbol, signalModel, effectiveStrategy, price, `Bot 5: no exhausted-reversion setup (L${longScore}/S${shortScore} of ${NEED}).`)

  const slDist = Math.max(1.3 * b.atr, price * 0.005)
  const stopLoss = direction === 'LONG' ? price - slDist : price + slDist
  // target = the mean; clamp reward between 0.8x and 2.5x the risk
  let tpDist = Math.abs(b.sma20 - price)
  tpDist = Math.min(Math.max(tpDist, slDist * 0.8), slDist * 2.5)
  const takeProfit = direction === 'LONG' ? price + tpDist : price - tpDist

  const summary = `Bot 5 ${direction.toLowerCase()} mean-reversion: z=${b.zscore.toFixed(2)}, RSI ${b.rsi.toFixed(0)}, BB pos ${b.bb.position.toFixed(2)}, regime ${b.regime}. Fading toward SMA20.`
  return sizeAndShape({
    symbol, signalModel, effectiveStrategy, direction, entryPrice: price, stopLoss, takeProfit,
    score, maxScore: 8, summary, strategyFamily: 'mean-reversion',
    setupFamily: direction === 'LONG' ? 'Oversold reversion' : 'Overbought reversion',
    aiFeatures: { zscore: b.zscore, rsi14: b.rsi, bbPosition: b.bb.position, atrStretch: b.atrStretch, regime: b.regime },
  })
}

// ---- Bot 6 — VOLATILITY BREAKOUT ------------------------------------

export function buildBot6SignalSnapshot({ symbol, signalModel, effectiveStrategy, closedBiasTimeframe, closedEntryTimeframe, regime4hTimeframe = null }) {
  const entry = closedEntryTimeframe
  const bias = closedBiasTimeframe
  if (entry.length < MIN_ENTRY_BARS || bias.length < 40) return notReady(symbol, signalModel, effectiveStrategy, lastOf(entry)?.close ?? null, 'Bot 6 waiting for candle history.')
  const b = indicatorBundle(entry, bias, regime4hTimeframe)
  const price = b.price
  const priorWin = entry.slice(-21, -1)
  const priorHigh = Math.max(...priorWin.map((c) => c.high))
  const priorLow = Math.min(...priorWin.map((c) => c.low))
  const rangeHeight = priorHigh - priorLow

  const compressed = b.squeeze === 1 || b.atrCompressed
  const brokeUp = price > priorHigh && (price - priorHigh) <= 0.8 * b.atr
  const brokeDn = price < priorLow && (priorLow - price) <= 0.8 * b.atr

  const longConds = [
    compressed,
    b.atrExpanding,
    brokeUp,
    b.relVol > 1.5,
    b.bodyRange > 0.5 && b.cur.close > b.cur.open,
    b.biasTrendGap >= -0.002,        // 1h not fighting it
  ]
  const shortConds = [
    compressed,
    b.atrExpanding,
    brokeDn,
    b.relVol > 1.5,
    b.bodyRange > 0.5 && b.cur.close < b.cur.open,
    b.biasTrendGap <= 0.002,
  ]
  const longScore = longConds.filter(Boolean).length
  const shortScore = shortConds.filter(Boolean).length
  const NEED = 5

  let direction = null
  let score = 0
  if (longScore >= NEED && longScore >= shortScore) { direction = 'LONG'; score = longScore }
  else if (shortScore >= NEED) { direction = 'SHORT'; score = shortScore }
  if (!direction) return notReady(symbol, signalModel, effectiveStrategy, price, `Bot 6: no compression-expansion breakout (L${longScore}/S${shortScore} of ${NEED}).`)

  // stop back inside the broken range; target a measured move capped to 3R
  const level = direction === 'LONG' ? priorHigh : priorLow
  const slDist = Math.max(Math.abs(price - level) + 0.3 * b.atr, price * 0.004)
  const stopLoss = direction === 'LONG' ? price - slDist : price + slDist
  let tpDist = Math.max(rangeHeight, 1.5 * slDist)
  tpDist = Math.min(tpDist, 3 * slDist)
  const takeProfit = direction === 'LONG' ? price + tpDist : price - tpDist

  const summary = `Bot 6 ${direction.toLowerCase()} volatility breakout: ${b.squeeze ? 'BB squeeze' : 'ATR compression'} → expansion, relVol ${b.relVol.toFixed(2)}, break of ${direction === 'LONG' ? 'range high' : 'range low'}.`
  return sizeAndShape({
    symbol, signalModel, effectiveStrategy, direction, entryPrice: price, stopLoss, takeProfit,
    score, maxScore: 6, summary, strategyFamily: 'volatility-breakout',
    setupFamily: direction === 'LONG' ? 'Upside expansion' : 'Downside expansion',
    aiFeatures: { bbWidth: b.bb.width, squeeze: b.squeeze, relVol: b.relVol, atrExpanding: b.atrExpanding ? 1 : 0, regime: b.regime },
  })
}

// ---- Bot 7 — RANGE / S-R FADE ---------------------------------------

export function buildBot7SignalSnapshot({ symbol, signalModel, effectiveStrategy, closedBiasTimeframe, closedEntryTimeframe, regime4hTimeframe = null }) {
  const entry = closedEntryTimeframe
  const bias = closedBiasTimeframe
  if (entry.length < MIN_ENTRY_BARS || bias.length < 40) return notReady(symbol, signalModel, effectiveStrategy, lastOf(entry)?.close ?? null, 'Bot 7 waiting for candle history.')
  const b = indicatorBundle(entry, bias, regime4hTimeframe)
  const price = b.price

  // 1. prove the market is genuinely ranging
  const ranging = b.adx1h < 20
    && Math.abs(b.biasTrendGap) < 0.004
    && b.rangeBandPct > 0.012 && b.rangeBandPct < 0.07
    && b.regime !== 'BULL_TREND' && b.regime !== 'BEAR_TREND'
    && b.regime !== 'HIGH_VOLATILITY'
  if (!ranging) return notReady(symbol, signalModel, effectiveStrategy, price, `Bot 7: market not ranging (ADX ${b.adx1h.toFixed(0)}, gap ${(b.biasTrendGap * 100).toFixed(2)}%, regime ${b.regime}).`)

  // 2. range-break invalidation — only fade from INSIDE the range
  const outUp = price > b.recentHigh + 0.2 * b.atr
  const outDn = price < b.recentLow - 0.2 * b.atr
  if (outUp || outDn) return notReady(symbol, signalModel, effectiveStrategy, price, 'Bot 7: price has broken the range boundary — setup invalidated.')

  const mid = (b.recentHigh + b.recentLow) / 2
  const longConds = [
    b.rangePos < 0.22,
    b.lowerWick > 0.35,            // rejection candle off support
    b.rsiSlope >= -0.2,           // momentum stabilising
    (mid - price) > 1.2 * Math.max(0.8 * b.atr, price * 0.004), // room to midpoint
    b.rsi < 45,
  ]
  const shortConds = [
    b.rangePos > 0.78,
    b.upperWick > 0.35,
    b.rsiSlope <= 0.2,
    (price - mid) > 1.2 * Math.max(0.8 * b.atr, price * 0.004),
    b.rsi > 55,
  ]
  const longScore = longConds.filter(Boolean).length
  const shortScore = shortConds.filter(Boolean).length
  const NEED = 4

  let direction = null
  let score = 0
  if (longScore >= NEED && longScore >= shortScore) { direction = 'LONG'; score = longScore }
  else if (shortScore >= NEED) { direction = 'SHORT'; score = shortScore }
  if (!direction) return notReady(symbol, signalModel, effectiveStrategy, price, `Bot 7: ranging but no boundary fade (L${longScore}/S${shortScore} of ${NEED}).`)

  const boundary = direction === 'LONG' ? b.recentLow : b.recentHigh
  const slDist = Math.max(Math.abs(price - boundary) + 0.5 * b.atr, price * 0.004)
  const stopLoss = direction === 'LONG' ? price - slDist : price + slDist
  let tpDist = Math.abs(mid - price)
  tpDist = Math.min(Math.max(tpDist, slDist * 0.9), slDist * 2.2)
  const takeProfit = direction === 'LONG' ? price + tpDist : price - tpDist

  const summary = `Bot 7 ${direction.toLowerCase()} range fade: ADX ${b.adx1h.toFixed(0)}, range pos ${b.rangePos.toFixed(2)}, fading ${direction === 'LONG' ? 'support' : 'resistance'} toward mid.`
  return sizeAndShape({
    symbol, signalModel, effectiveStrategy, direction, entryPrice: price, stopLoss, takeProfit,
    score, maxScore: 5, summary, strategyFamily: 'range-fade',
    setupFamily: direction === 'LONG' ? 'Support fade' : 'Resistance fade',
    aiFeatures: { adx1h: b.adx1h, rangePos: b.rangePos, rangeBandPct: b.rangeBandPct, rsi14: b.rsi, regime: b.regime },
  })
}

// ---- Bot 8 — FUNDING EXTREME / CONTRARIAN --------------------------

export function buildBot8SignalSnapshot({ symbol, signalModel, effectiveStrategy, closedBiasTimeframe, closedEntryTimeframe, marketContext = {}, regime4hTimeframe = null }) {
  const entry = closedEntryTimeframe
  const bias = closedBiasTimeframe
  if (entry.length < MIN_ENTRY_BARS || bias.length < 40) return notReady(symbol, signalModel, effectiveStrategy, lastOf(entry)?.close ?? null, 'Bot 8 waiting for candle history.')

  // Funding history MUST exist for this period — never invent it.
  const fundingAvailable = marketContext.fundingAvailable === true
    || (Number.isFinite(Number(marketContext.fundingRate)) && Number(marketContext.fundingRate) !== 0)
  if (!fundingAvailable) return notReady(symbol, signalModel, effectiveStrategy, lastOf(entry)?.close ?? null, 'Bot 8: no funding history for this period — funding-dependent setup skipped.')

  const b = indicatorBundle(entry, bias, regime4hTimeframe)
  const price = b.price
  const funding = Number(marketContext.fundingRate)
  const fundingPct = Number.isFinite(Number(marketContext.fundingPercentile)) ? Number(marketContext.fundingPercentile) : null

  const fundingVeryNeg = funding <= -0.0003 || (fundingPct != null && fundingPct <= 0.1)
  const fundingVeryPos = funding >= 0.0003 || (fundingPct != null && fundingPct >= 0.9)

  // Bot 8's high-frequency test profile still requires genuine extreme funding,
  // but accepts any two available price/action confirmations. This deliberately
  // broadens coverage without turning an ordinary price move into a funding trade.
  const longConds = [
    fundingVeryNeg,
    b.zscore <= -1.3,
    b.vwapDist <= -0.012,
    b.rsiSlope > -0.3,            // selling momentum weakening
    b.bullReclaim,               // reversal confirmation
    b.price > b.recentLow * 1.001, // holding above the recent swing low
  ]
  const shortConds = [
    fundingVeryPos,
    b.zscore >= 1.3,
    b.vwapDist >= 0.012,
    b.rsiSlope < 0.3,
    b.bearReject,
    b.price < b.recentHigh * 0.999,
  ]
  const longScore = longConds.filter(Boolean).length
  const shortScore = shortConds.filter(Boolean).length
  const NEED = 3 // funding condition + any two price/action confirmations

  let direction = null
  let score = 0
  if (longScore >= NEED && longConds[0] && longScore >= shortScore) { direction = 'LONG'; score = longScore }
  else if (shortScore >= NEED && shortConds[0]) { direction = 'SHORT'; score = shortScore }
  if (!direction) return notReady(symbol, signalModel, effectiveStrategy, price, `Bot 8: funding ${(funding * 100).toFixed(4)}% but price/action not confirming (L${longScore}/S${shortScore} of ${NEED}).`)

  const slDist = Math.max(1.4 * b.atr, price * 0.006)
  const stopLoss = direction === 'LONG' ? price - slDist : price + slDist
  // target back to VWAP / mean, clamped 1.0x–2.5x risk
  let tpDist = Math.abs(b.vwap - price)
  tpDist = Math.min(Math.max(tpDist, slDist * 1.0), slDist * 2.5)
  const takeProfit = direction === 'LONG' ? price + tpDist : price - tpDist

  const summary = `Bot 8 ${direction.toLowerCase()} funding contrarian: funding ${(funding * 100).toFixed(4)}%${fundingPct != null ? ` (pct ${fundingPct.toFixed(2)})` : ''}, z=${b.zscore.toFixed(2)}, VWAP dist ${(b.vwapDist * 100).toFixed(2)}%, ${direction === 'LONG' ? 'reclaim' : 'rejection'} confirmed.`
  return sizeAndShape({
    symbol, signalModel, effectiveStrategy, direction, entryPrice: price, stopLoss, takeProfit,
    score, maxScore: 6, summary, strategyFamily: 'funding-contrarian',
    setupFamily: direction === 'LONG' ? 'Negative-funding squeeze' : 'Positive-funding flush',
    aiFeatures: { funding, fundingPercentile: fundingPct ?? 0, zscore: b.zscore, vwapDist: b.vwapDist, rsi14: b.rsi, regime: b.regime },
  })
}

// Bots 9-15 (the validation-rejected Bot 9 trend-pullback experiment, the old Bot 10
// consolidated placeholder, and the LLM-per-bot family 11-15) were removed outright - no
// trade history existed for any of them. Consolidated Knowledge continues unaffected as its
// own standalone feature (consolidated-bot.js / ConsolidatedBotPage.jsx), unrelated to the
// placeholder that used to sit here.
export const BOT5TO8_BUILDERS = {
  'model-5': buildBot5SignalSnapshot,
  'model-6': buildBot6SignalSnapshot,
  'model-7': buildBot7SignalSnapshot,
  'model-8': buildBot8SignalSnapshot,
}
