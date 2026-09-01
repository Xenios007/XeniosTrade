// Market-regime detector. Classifies a timestamp using ONLY candles closed at or
// before that timestamp — never trade outcomes, never future bars.
//
// Regimes: BULL_TREND | BEAR_TREND | RANGE | HIGH_VOLATILITY | LOW_VOLATILITY | TRANSITION
//
// The classifier is deliberately simple and monotonic so it is easy to test and
// audit for look-ahead. It leans on the 1h bias window (trend) and the 5m entry
// window (volatility), with an optional 4h window to stabilise the trend call.

import { _internals } from './feature-lib.js'

const { emaSeries, atrSeries, adx, mean, stdev } = _internals

const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const REGIMES = [
  'BULL_TREND',
  'BEAR_TREND',
  'RANGE',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'TRANSITION',
]

/**
 * @param {object} p
 * @param {object[]} p.biasCandles  1h closed window (>= 60 bars ideal)
 * @param {object[]} p.entryCandles 5m closed window (>= 200 bars ideal)
 * @param {object[]} [p.regimeCandles] 4h closed window (optional)
 * @returns {{ regime: string, trendScore: number, volScore: number, adx: number }}
 */
export function classifyRegime({ biasCandles = [], entryCandles = [], regimeCandles = null }) {
  if (biasCandles.length < 40 || entryCandles.length < 60) {
    return { regime: 'TRANSITION', trendScore: 0, volScore: 0, adx: 0 }
  }

  const biasCloses = biasCandles.map((c) => c.close)
  const ema20 = emaSeries(biasCloses, 20).filter((v) => v != null)
  const ema50 = emaSeries(biasCloses, 50).filter((v) => v != null)
  const e20 = num(ema20[ema20.length - 1], biasCloses[biasCloses.length - 1])
  const e50 = num(ema50[ema50.length - 1], e20)
  const price = biasCloses[biasCloses.length - 1]

  // trend slope over the last ~12 1h bars, normalised by price
  const e20back = num(ema20[Math.max(0, ema20.length - 12)], e20)
  const slope = (e20 - e20back) / Math.max(price, 1e-9)
  const emaGap = (e20 - e50) / Math.max(price, 1e-9)
  const adx1h = adx(biasCandles, 14)

  let trendScore = 0
  if (e20 > e50) trendScore += 1
  if (e20 < e50) trendScore -= 1
  if (slope > 0.001) trendScore += 1
  if (slope < -0.001) trendScore -= 1
  if (emaGap > 0.004) trendScore += 1
  if (emaGap < -0.004) trendScore -= 1

  // 4h confirmation (optional, ±1)
  if (Array.isArray(regimeCandles) && regimeCandles.length >= 30) {
    const rc = regimeCandles.map((c) => c.close)
    const r20 = emaSeries(rc, 20).filter((v) => v != null)
    const r50 = emaSeries(rc, 50).filter((v) => v != null)
    if (r20.length && r50.length) {
      if (r20[r20.length - 1] > r50[r50.length - 1]) trendScore += 1
      else trendScore -= 1
    }
  }

  // volatility from 5m realized vol percentile vs its own trailing history
  const eCloses = entryCandles.map((c) => c.close)
  const rets = []
  for (let i = 1; i < eCloses.length; i += 1) {
    if (eCloses[i - 1] > 0) rets.push(Math.log(eCloses[i] / eCloses[i - 1]))
  }
  const curVol = stdev(rets.slice(-48))
  const histWindow = []
  for (let i = 96; i < rets.length; i += 24) histWindow.push(stdev(rets.slice(i - 48, i)))
  const sorted = histWindow.slice().sort((a, b) => a - b)
  const medVol = sorted.length ? sorted[Math.floor(sorted.length / 2)] : curVol
  const p80 = sorted.length ? sorted[Math.floor(sorted.length * 0.8)] : curVol
  const p20 = sorted.length ? sorted[Math.floor(sorted.length * 0.2)] : curVol
  const volScore = medVol > 0 ? curVol / medVol : 1

  const atr5 = atrSeries(entryCandles, 14).filter((v) => v != null)
  const atrPct = atr5.length ? num(atr5[atr5.length - 1]) / Math.max(eCloses[eCloses.length - 1], 1e-9) : 0
  void atrPct

  // Decision order: extreme volatility dominates; then trend; then range.
  let regime
  if (curVol >= p80 * 1.15 && curVol > medVol * 1.4) {
    regime = 'HIGH_VOLATILITY'
  } else if (trendScore >= 3) {
    regime = 'BULL_TREND'
  } else if (trendScore <= -3) {
    regime = 'BEAR_TREND'
  } else if (adx1h < 18 && Math.abs(emaGap) < 0.004 && curVol <= medVol * 1.1) {
    regime = 'RANGE'
  } else if (curVol <= p20 * 0.9 && curVol < medVol * 0.7) {
    regime = 'LOW_VOLATILITY'
  } else {
    regime = 'TRANSITION'
  }

  return {
    regime,
    trendScore,
    volScore: Number(volScore.toFixed(4)),
    adx: Number(adx1h.toFixed(2)),
  }
}

// Derive a 4h series by aggregating a 1h raw-kline array (Binance row shape).
// Groups 4 consecutive 1h bars; drops a trailing partial group.
export function deriveRegimeCandlesFromHourly(hourlyRaw) {
  if (!Array.isArray(hourlyRaw) || hourlyRaw.length < 4) return []
  const out = []
  for (let i = 0; i + 4 <= hourlyRaw.length; i += 4) {
    const g = hourlyRaw.slice(i, i + 4)
    out.push({
      time: Number(g[0][0]),
      closeTime: Number(g[3][6]),
      open: Number(g[0][1]),
      high: Math.max(...g.map((r) => Number(r[2]))),
      low: Math.min(...g.map((r) => Number(r[3]))),
      close: Number(g[3][4]),
      volume: g.reduce((s, r) => s + Number(r[5]), 0),
      takerBuyBaseVolume: g.reduce((s, r) => s + Number(r[9] || 0), 0),
      takerSellBaseVolume: g.reduce((s, r) => s + Math.max(Number(r[5]) - Number(r[9] || 0), 0), 0),
      deltaVolume: 0,
    })
  }
  return out
}
