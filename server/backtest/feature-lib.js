// Leakage-free entry-time feature library for the 8-bot backtest.
//
// Every function here takes ONLY candle windows that the caller has already
// sliced to "closed at or before entry time t" (see sliceClosedBy in
// replay-dataset.js). Nothing in this file may look at a bar with
// closeTime > t, at the trade outcome, or at any future price. The output is a
// flat { key: number } map plus a FEATURE_VERSION string that is recorded with
// every run so a dataset can be tied back to the exact feature code.
//
// Candle shape (from toCandleData): { time, closeTime, open, high, low, close,
// volume, takerBuyBaseVolume, takerSellBaseVolume, deltaVolume }.

export const FEATURE_VERSION = 'featv1-2026-09'

// ---- tiny numeric helpers -------------------------------------------------

const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const safeDiv = (a, b, d = 0) => {
  const bb = Number(b)
  if (!Number.isFinite(bb) || bb === 0) return d
  const r = Number(a) / bb
  return Number.isFinite(r) ? r : d
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
const stdev = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}
const last = (xs) => (xs.length ? xs[xs.length - 1] : undefined)
const pctRank = (xs, v) => {
  if (!xs.length) return 0.5
  let below = 0
  for (const x of xs) if (x <= v) below += 1
  return below / xs.length
}

// EMA over a plain number series -> array aligned to the input (leading nulls).
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let ema = mean(values.slice(0, period))
  out[period - 1] = ema
  for (let i = period; i < values.length; i += 1) {
    ema = (values[i] - ema) * k + ema
    out[i] = ema
  }
  return out
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null)
  if (closes.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1]
    if (ch >= 0) gain += ch
    else loss -= ch
  }
  gain /= period
  loss /= period
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1]
    const g = ch >= 0 ? ch : 0
    const l = ch < 0 ? -ch : 0
    gain = (gain * (period - 1) + g) / period
    loss = (loss * (period - 1) + l) / period
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null)
  if (candles.length <= period) return out
  const trs = []
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]
    const p = candles[i - 1]
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    ))
  }
  // trs[i] corresponds to candles[i+1]
  let atr = mean(trs.slice(0, period))
  out[period] = atr
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period
    out[i + 1] = atr
  }
  return out
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = emaSeries(closes, fast)
  const s = emaSeries(closes, slow)
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null))
  const lineVals = line.filter((v) => v != null)
  const sig = emaSeries(lineVals, signal)
  const sigLast = last(sig.filter((v) => v != null))
  const lineLast = last(lineVals)
  return {
    line: num(lineLast),
    signal: num(sigLast),
    hist: num(lineLast) - num(sigLast),
  }
}

// Session VWAP anchored at the start of the window (rolling proxy: full window).
function vwapSeries(candles) {
  const out = new Array(candles.length).fill(null)
  let pv = 0
  let vol = 0
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]
    const tp = (c.high + c.low + c.close) / 3
    pv += tp * c.volume
    vol += c.volume
    out[i] = vol > 0 ? pv / vol : c.close
  }
  return out
}

function adx(candles, period = 14) {
  if (candles.length <= period * 2) return 0
  let plusDM = 0
  let minusDM = 0
  let tr = 0
  const dxs = []
  let smPlus = 0
  let smMinus = 0
  let smTr = 0
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]
    const p = candles[i - 1]
    const up = c.high - p.high
    const down = p.low - c.low
    const pdm = up > down && up > 0 ? up : 0
    const mdm = down > up && down > 0 ? down : 0
    const t = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    if (i <= period) {
      smPlus += pdm
      smMinus += mdm
      smTr += t
      if (i === period) {
        const pdi = 100 * safeDiv(smPlus, smTr)
        const mdi = 100 * safeDiv(smMinus, smTr)
        dxs.push(100 * safeDiv(Math.abs(pdi - mdi), pdi + mdi))
      }
    } else {
      smPlus = smPlus - smPlus / period + pdm
      smMinus = smMinus - smMinus / period + mdm
      smTr = smTr - smTr / period + t
      const pdi = 100 * safeDiv(smPlus, smTr)
      const mdi = 100 * safeDiv(smMinus, smTr)
      dxs.push(100 * safeDiv(Math.abs(pdi - mdi), pdi + mdi))
    }
    plusDM = pdm
    minusDM = mdm
    tr = t
  }
  void plusDM; void minusDM; void tr
  if (dxs.length < period) return mean(dxs)
  let adxVal = mean(dxs.slice(0, period))
  for (let i = period; i < dxs.length; i += 1) adxVal = (adxVal * (period - 1) + dxs[i]) / period
  return adxVal
}

// Bollinger Bands on the last `period` closes.
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return { mid: num(last(closes)), upper: 0, lower: 0, width: 0, position: 0.5 }
  const win = closes.slice(-period)
  const mid = mean(win)
  const sd = stdev(win)
  const upper = mid + mult * sd
  const lower = mid - mult * sd
  const price = num(last(closes))
  return {
    mid,
    upper,
    lower,
    width: safeDiv(upper - lower, mid),
    position: clamp(safeDiv(price - lower, upper - lower, 0.5), -0.5, 1.5),
  }
}

function obvLast(candles) {
  let obv = 0
  for (let i = 1; i < candles.length; i += 1) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume
  }
  return obv
}

// swing high/low structure over the last `lb` bars (pivot width 2)
function swingStructure(candles, lb = 40) {
  const win = candles.slice(-lb)
  const highs = []
  const lows = []
  for (let i = 2; i < win.length - 2; i += 1) {
    const c = win[i]
    if (c.high >= win[i - 1].high && c.high >= win[i - 2].high && c.high >= win[i + 1].high && c.high >= win[i + 2].high) {
      highs.push(c.high)
    }
    if (c.low <= win[i - 1].low && c.low <= win[i - 2].low && c.low <= win[i + 1].low && c.low <= win[i + 2].low) {
      lows.push(c.low)
    }
  }
  const hh = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2] ? 1 : 0
  const lh = highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2] ? 1 : 0
  const hl = lows.length >= 2 && lows[lows.length - 1] > lows[lows.length - 2] ? 1 : 0
  const ll = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2] ? 1 : 0
  return { hh, hl, lh, ll, highs, lows }
}

// ---- per-timeframe block ------------------------------------------------

// Compute the standard feature block for one already-closed candle window.
// prefix distinguishes timeframes ('e5' / 's15' / 'b1h').
function timeframeBlock(candles, prefix) {
  const f = {}
  if (!Array.isArray(candles) || candles.length < 30) return f
  const closes = candles.map((c) => c.close)
  const vols = candles.map((c) => c.volume)
  const price = num(last(closes))
  const cur = last(candles)

  // RETURNS
  const ret = (n) => (closes.length > n ? safeDiv(price - closes[closes.length - 1 - n], closes[closes.length - 1 - n]) : 0)
  f[`${prefix}_ret1`] = ret(1)
  f[`${prefix}_ret3`] = ret(3)
  f[`${prefix}_ret6`] = ret(6)
  f[`${prefix}_ret12`] = ret(12)
  f[`${prefix}_ret24`] = ret(24)
  f[`${prefix}_logret1`] = closes.length > 1 && closes[closes.length - 2] > 0 ? Math.log(price / closes[closes.length - 2]) : 0

  // TREND
  const ema9 = emaSeries(closes, 9)
  const ema20 = emaSeries(closes, 20)
  const ema50 = emaSeries(closes, 50)
  const ema200 = emaSeries(closes, 200)
  const e9 = num(last(ema9.filter((v) => v != null)), price)
  const e20 = num(last(ema20.filter((v) => v != null)), price)
  const e50 = num(last(ema50.filter((v) => v != null)), price)
  const e200v = ema200.filter((v) => v != null)
  const e200 = e200v.length ? num(last(e200v)) : null
  f[`${prefix}_ema9_dist`] = safeDiv(price - e9, price)
  f[`${prefix}_ema20_dist`] = safeDiv(price - e20, price)
  f[`${prefix}_ema50_dist`] = safeDiv(price - e50, price)
  f[`${prefix}_ema200_dist`] = e200 != null ? safeDiv(price - e200, price) : 0
  f[`${prefix}_ema200_warm`] = e200 != null ? 1 : 0
  f[`${prefix}_ema20_50_spread`] = safeDiv(e20 - e50, price)
  const e20prev = num(ema20.filter((v) => v != null).slice(-6)[0], e20)
  f[`${prefix}_ema20_slope`] = safeDiv(e20 - e20prev, price)
  f[`${prefix}_trend_dir`] = e20 > e50 ? 1 : e20 < e50 ? -1 : 0
  f[`${prefix}_trend_strength`] = clamp(adx(candles, 14) / 100, 0, 1)

  // MOMENTUM
  const rsi = rsiSeries(closes, 14).filter((v) => v != null)
  const rsiLast = num(last(rsi), 50)
  f[`${prefix}_rsi14`] = rsiLast / 100
  f[`${prefix}_rsi_change`] = rsi.length > 1 ? (rsiLast - rsi[rsi.length - 2]) / 100 : 0
  f[`${prefix}_rsi_slope`] = rsi.length > 4 ? (rsiLast - rsi[rsi.length - 5]) / 100 / 4 : 0
  const m = macd(closes)
  f[`${prefix}_macd_line`] = safeDiv(m.line, price)
  f[`${prefix}_macd_signal`] = safeDiv(m.signal, price)
  f[`${prefix}_macd_hist`] = safeDiv(m.hist, price)
  f[`${prefix}_roc12`] = ret(12)
  f[`${prefix}_mom_accel`] = ret(3) - (closes.length > 6 ? safeDiv(closes[closes.length - 4] - closes[closes.length - 7], closes[closes.length - 7]) : 0)

  // VOLATILITY
  const atr = atrSeries(candles, 14).filter((v) => v != null)
  const atrLast = num(last(atr), price * 0.003)
  f[`${prefix}_atr`] = safeDiv(atrLast, price)
  f[`${prefix}_atr_pct`] = safeDiv(atrLast, price)
  const rv = []
  for (let i = Math.max(1, closes.length - 20); i < closes.length; i += 1) {
    if (closes[i - 1] > 0) rv.push(Math.log(closes[i] / closes[i - 1]))
  }
  f[`${prefix}_realized_vol`] = stdev(rv)
  const bb = bollinger(closes, 20, 2)
  f[`${prefix}_bb_width`] = bb.width
  f[`${prefix}_bb_position`] = bb.position
  // volatility percentile vs its own trailing history of atr%
  const atrPctHist = atr.map((a, i) => safeDiv(a, closes[i + (candles.length - atr.length)] || price))
  f[`${prefix}_vol_percentile`] = pctRank(atrPctHist.slice(-120), safeDiv(atrLast, price))
  // compression / expansion: current bb width vs trailing median
  const widthHist = []
  for (let i = 20; i < closes.length; i += 5) widthHist.push(bollinger(closes.slice(0, i), 20, 2).width)
  const wMed = widthHist.length ? widthHist.slice().sort((a, b) => a - b)[Math.floor(widthHist.length / 2)] : bb.width
  f[`${prefix}_compression`] = bb.width < wMed * 0.8 ? 1 : 0
  f[`${prefix}_expansion`] = bb.width > wMed * 1.3 ? 1 : 0

  // VOLUME / FLOW
  const volLast = num(last(vols))
  const volMa = mean(vols.slice(-20))
  f[`${prefix}_rel_volume`] = safeDiv(volLast, volMa, 1)
  f[`${prefix}_vol_ma_ratio`] = safeDiv(mean(vols.slice(-5)), volMa, 1)
  f[`${prefix}_vol_change`] = vols.length > 1 ? safeDiv(volLast - vols[vols.length - 2], vols[vols.length - 2]) : 0
  f[`${prefix}_vol_zscore`] = safeDiv(volLast - volMa, stdev(vols.slice(-20)))
  const tb = candles.slice(-20).reduce((s, c) => s + num(c.takerBuyBaseVolume), 0)
  const tot = candles.slice(-20).reduce((s, c) => s + num(c.volume), 0)
  f[`${prefix}_taker_buy_ratio`] = safeDiv(tb, tot, 0.5)
  f[`${prefix}_taker_delta_proxy`] = safeDiv(
    candles.slice(-5).reduce((s, c) => s + num(c.deltaVolume), 0),
    candles.slice(-5).reduce((s, c) => s + num(c.volume), 0),
  )
  f[`${prefix}_obv_norm`] = safeDiv(obvLast(candles.slice(-60)), volMa * 60)

  // CANDLE STRUCTURE (current closed bar)
  const rng = Math.max(cur.high - cur.low, 1e-12)
  f[`${prefix}_body_range`] = safeDiv(Math.abs(cur.close - cur.open), rng)
  f[`${prefix}_upper_wick`] = safeDiv(cur.high - Math.max(cur.open, cur.close), rng)
  f[`${prefix}_lower_wick`] = safeDiv(Math.min(cur.open, cur.close) - cur.low, rng)
  f[`${prefix}_close_pos`] = safeDiv(cur.close - cur.low, rng)
  f[`${prefix}_bull`] = cur.close >= cur.open ? 1 : 0
  f[`${prefix}_range_atr`] = safeDiv(rng, atrLast, 1)
  f[`${prefix}_rejection`] = Math.max(f[`${prefix}_upper_wick`], f[`${prefix}_lower_wick`]) - f[`${prefix}_body_range`]

  // MARKET STRUCTURE
  const ss = swingStructure(candles, 40)
  f[`${prefix}_hh`] = ss.hh
  f[`${prefix}_hl`] = ss.hl
  f[`${prefix}_lh`] = ss.lh
  f[`${prefix}_ll`] = ss.ll
  const win40 = candles.slice(-40)
  const recentHigh = Math.max(...win40.map((c) => c.high))
  const recentLow = Math.min(...win40.map((c) => c.low))
  f[`${prefix}_recent_high_dist`] = safeDiv(recentHigh - price, price)
  f[`${prefix}_recent_low_dist`] = safeDiv(price - recentLow, price)
  f[`${prefix}_range_pos`] = clamp(safeDiv(price - recentLow, recentHigh - recentLow, 0.5), 0, 1)
  f[`${prefix}_breakout_up`] = price >= recentHigh * 0.999 ? 1 : 0
  f[`${prefix}_breakout_dn`] = price <= recentLow * 1.001 ? 1 : 0
  const bandPct = safeDiv(recentHigh - recentLow, price)
  f[`${prefix}_is_range`] = adx(candles, 14) < 20 && bandPct < 0.08 ? 1 : 0

  // VWAP
  const vw = vwapSeries(candles)
  const vwLast = num(last(vw), price)
  const vwPrev = num(vw[Math.max(0, vw.length - 6)], vwLast)
  f[`${prefix}_vwap_dist`] = safeDiv(price - vwLast, price)
  f[`${prefix}_vwap_slope`] = safeDiv(vwLast - vwPrev, price)
  f[`${prefix}_above_vwap`] = price >= vwLast ? 1 : 0

  return f
}

// ---- funding / derivatives --------------------------------------------

// fundingHistory: [{ fundingTime, fundingRate }] ascending, already trimmed to <= t
// by the caller. Returns funding features + a fundingAvailable flag.
export function fundingFeatures(fundingHistory, tMs) {
  const f = {
    fund_rate: 0,
    fund_sign: 0,
    fund_magnitude: 0,
    fund_change: 0,
    fund_percentile: 0.5,
    fund_zscore: 0,
    fund_available: 0,
  }
  if (!Array.isArray(fundingHistory) || fundingHistory.length === 0) return f
  const past = fundingHistory.filter((e) => e.fundingTime <= tMs)
  if (past.length === 0) return f
  const rate = num(last(past).fundingRate)
  f.fund_available = 1
  f.fund_rate = rate
  f.fund_sign = rate > 0 ? 1 : rate < 0 ? -1 : 0
  f.fund_magnitude = Math.abs(rate)
  f.fund_change = past.length > 1 ? rate - num(past[past.length - 2].fundingRate) : 0
  const hist = past.slice(-240).map((e) => num(e.fundingRate))
  f.fund_percentile = pctRank(hist, rate)
  f.fund_zscore = safeDiv(rate - mean(hist), stdev(hist))
  return f
}

// ---- time / session --------------------------------------------------

export function timeFeatures(tMs) {
  const d = new Date(tMs)
  const h = d.getUTCHours() + d.getUTCMinutes() / 60
  const dow = d.getUTCDay()
  // London ~07:00-16:00 UTC, New York ~12:00-21:00 UTC
  return {
    hour_sin: Math.sin((2 * Math.PI * h) / 24),
    hour_cos: Math.cos((2 * Math.PI * h) / 24),
    dow_sin: Math.sin((2 * Math.PI * dow) / 7),
    dow_cos: Math.cos((2 * Math.PI * dow) / 7),
    london_session: h >= 7 && h < 16 ? 1 : 0,
    ny_session: h >= 12 && h < 21 ? 1 : 0,
  }
}

// ---- top-level assembly --------------------------------------------------

/**
 * Build the full leakage-free entry-time feature vector.
 * All windows MUST already be sliced to bars closed at or before tMs.
 *
 * @param {object} p
 * @param {object[]} p.entryCandles  5m closed window (>= 60 bars ideal)
 * @param {object[]} p.setupCandles  15m closed window
 * @param {object[]} p.biasCandles   1h closed window
 * @param {object[]} [p.regimeCandles] derived 4h closed window (optional)
 * @param {Array} [p.fundingHistory] [{fundingTime,fundingRate}] ascending
 * @param {number} p.tMs             entry timestamp (bar close)
 * @returns {{ features: Record<string, number>, featureVersion: string }}
 */
export function buildEntryFeatures({
  entryCandles = [],
  setupCandles = [],
  biasCandles = [],
  regimeCandles = null,
  fundingHistory = [],
  tMs,
}) {
  const features = {}
  Object.assign(features, timeframeBlock(entryCandles, 'e5'))
  Object.assign(features, timeframeBlock(setupCandles, 's15'))
  Object.assign(features, timeframeBlock(biasCandles, 'b1h'))
  if (Array.isArray(regimeCandles) && regimeCandles.length >= 30) {
    Object.assign(features, timeframeBlock(regimeCandles, 'r4h'))
  }
  Object.assign(features, fundingFeatures(fundingHistory, tMs))
  Object.assign(features, timeFeatures(tMs))

  // Coerce everything to finite numbers so downstream never sees NaN/undefined.
  for (const k of Object.keys(features)) {
    const v = Number(features[k])
    features[k] = Number.isFinite(v) ? Number(v.toFixed(8)) : 0
  }
  return { features, featureVersion: FEATURE_VERSION }
}

// Exported for unit tests / reuse.
export const _internals = {
  emaSeries, rsiSeries, atrSeries, macd, vwapSeries, adx, bollinger,
  obvLast, swingStructure, timeframeBlock, mean, stdev, pctRank, safeDiv,
}
