// Timestamp-aligned BTC (and optional ETH) market-context features for altcoin
// samples. The caller fetches BTC's 5m/15m/1h series once for the whole run and
// passes windows ALREADY sliced to bars closed at or before the sample time t.
// Nothing here reads a future bar.

import { _internals } from './feature-lib.js'
import { classifyRegime } from './regime.js'

const { emaSeries, rsiSeries, stdev } = _internals

const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const ret = (closes, n) => (closes.length > n && closes[closes.length - 1 - n] > 0
  ? (closes[closes.length - 1] - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n]
  : 0)

/**
 * @param {string} prefix  'btc' | 'eth'
 * @param {object} p
 * @param {object[]} p.c5   5m closed candles <= t
 * @param {object[]} p.c15  15m closed candles <= t
 * @param {object[]} p.c1h  1h closed candles <= t
 * @param {object[]} [p.c4h] derived 4h closed candles <= t
 */
export function buildMarketContext(prefix, { c5 = [], c15 = [], c1h = [], c4h = null }) {
  const f = {}
  const p5 = c5.map((c) => c.close)
  const p15 = c15.map((c) => c.close)
  const p1h = c1h.map((c) => c.close)

  f[`${prefix}_ret_5m`] = ret(p5, 1)
  f[`${prefix}_ret_15m`] = ret(p15, 1)
  f[`${prefix}_ret_1h`] = ret(p1h, 1)
  f[`${prefix}_ret_4h`] = c4h && c4h.length ? ret(c4h.map((c) => c.close), 1) : ret(p1h, 4)

  const rsi = rsiSeries(p1h, 14).filter((v) => v != null)
  f[`${prefix}_rsi_1h`] = num(rsi[rsi.length - 1], 50) / 100

  const e20 = emaSeries(p1h, 20).filter((v) => v != null)
  const e50 = emaSeries(p1h, 50).filter((v) => v != null)
  const last20 = num(e20[e20.length - 1], p1h[p1h.length - 1])
  const last50 = num(e50[e50.length - 1], last20)
  f[`${prefix}_trend`] = last20 > last50 ? 1 : last20 < last50 ? -1 : 0
  f[`${prefix}_trend_gap`] = last50 > 0 ? (last20 - last50) / last50 : 0

  // volatility regime: current 5m realized vol vs trailing median (-1 low / 0 mid / 1 high)
  const rets = []
  for (let i = 1; i < p5.length; i += 1) if (p5[i - 1] > 0) rets.push(Math.log(p5[i] / p5[i - 1]))
  const cur = stdev(rets.slice(-48))
  const hist = []
  for (let i = 96; i < rets.length; i += 24) hist.push(stdev(rets.slice(i - 48, i)))
  const sorted = hist.slice().sort((a, b) => a - b)
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : cur
  f[`${prefix}_vol_regime`] = med > 0
    ? (cur > med * 1.4 ? 1 : cur < med * 0.7 ? -1 : 0)
    : 0

  const reg = classifyRegime({ biasCandles: c1h, entryCandles: c5, regimeCandles: c4h })
  // one-hot-ish numeric regime code for the model
  const codes = { BULL_TREND: 2, BEAR_TREND: -2, RANGE: 0, HIGH_VOLATILITY: 1, LOW_VOLATILITY: -1, TRANSITION: 0 }
  f[`${prefix}_regime_code`] = codes[reg.regime] ?? 0

  for (const k of Object.keys(f)) {
    const v = Number(f[k])
    f[k] = Number.isFinite(v) ? Number(v.toFixed(8)) : 0
  }
  return f
}

export function buildBtcContext(windows) {
  return buildMarketContext('btc', windows)
}
export function buildEthContext(windows) {
  return buildMarketContext('eth', windows)
}
