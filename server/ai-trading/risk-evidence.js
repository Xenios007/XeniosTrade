// Measured evidence for the Risk Manager AI: numbers computed from recent market data, not opinions. Everything here is pure (no I/O) so
// it is unit-testable; the server fetches the candles and the order book and hands them in (see getAiTradeConstraints).
//
// Honesty rules baked in: every statistic carries its sample size, the excursion figures are BASE RATES for the symbol (any 5M close), not
// statistics of this particular setup, and overlapping windows are reported as such. The prompt text says so too.

const QUANTILE_STEP = 5 // tables hold the 0th, 5th, ... 100th percentile (21 numbers): compact enough to store on the run

// null / undefined / '' must NOT count as 0: a missing measurement has to stay missing, never become a fabricated zero.
const finite = (value) => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value))
const round = (value, digits = 3) => (finite(value) ? Number(Number(value).toFixed(digits)) : null)
const fx = (value, digits = 2) => (finite(value) ? Number(value).toFixed(digits) : 'n/a')

/** 0th..100th percentile (every 5) of `values`, linear interpolation. null when there is nothing to measure. */
export function quantileTable(values) {
  const sorted = values.filter(finite).map(Number).sort((a, b) => a - b)
  if (!sorted.length) return null
  const table = []
  for (let percentile = 0; percentile <= 100; percentile += QUANTILE_STEP) {
    const position = (percentile / 100) * (sorted.length - 1)
    const low = Math.floor(position)
    const high = Math.ceil(position)
    table.push(round(sorted[low] + (sorted[high] - sorted[low]) * (position - low), 4))
  }
  return table
}

/** Fraction (0..1) of the measured sample at or below `x`, read off a quantile table by interpolation. */
export function rankIn(table, x) {
  if (!Array.isArray(table) || !table.length || !finite(x)) return null
  if (x <= table[0]) return 0
  if (x >= table[table.length - 1]) return 1
  for (let index = 1; index < table.length; index += 1) {
    if (x <= table[index]) {
      const span = table[index] - table[index - 1]
      const within = span > 0 ? (x - table[index - 1]) / span : 1
      return ((index - 1) + within) * (QUANTILE_STEP / 100)
    }
  }
  return 1
}

const percentileOf = (table, percentile) => table?.[percentile / QUANTILE_STEP] ?? null

/** Wilder ATR as a percent of price, one value per candle from index `period` on. */
export function atrPctSeries(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return []
  const trueRange = (index) => {
    const c = candles[index]
    const previousClose = candles[index - 1].close
    return Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose))
  }
  let atr = 0
  for (let index = 1; index <= period; index += 1) atr += trueRange(index)
  atr /= period
  const series = [(atr / candles[period].close) * 100]
  for (let index = period + 1; index < candles.length; index += 1) {
    atr = (atr * (period - 1) + trueRange(index)) / period
    series.push((atr / candles[index].close) * 100)
  }
  return series.filter(finite)
}

/** Where the latest ATR% sits among all the ATR% values in the window (0-100), with the sample size. */
export function atrPercentile(candles, period = 14) {
  const series = atrPctSeries(candles, period)
  if (series.length < 20) return null
  const latest = series[series.length - 1]
  const atOrBelow = series.filter((value) => value <= latest).length
  return { atrPct: round(latest, 4), percentile: Math.round((atOrBelow / series.length) * 100), samples: series.length }
}

/**
 * After ANY close in the window, how far did price travel in the next `horizonBars` bars, for and against a LONG / a SHORT?
 * Quantile tables of the favorable (MFE-like) and adverse (MAE-like) move, in percent of that close.
 * Windows overlap, so `independent` (windows / horizon) is the honest count of separate observations.
 */
export function excursionStats(candles, horizonBars = 12) {
  if (!Array.isArray(candles) || candles.length < horizonBars + 40) return null
  const up = []
  const down = []
  for (let index = 0; index + horizonBars < candles.length; index += 1) {
    const entry = candles[index].close
    if (!(entry > 0)) continue
    let high = -Infinity
    let low = Infinity
    for (let ahead = 1; ahead <= horizonBars; ahead += 1) {
      const c = candles[index + ahead]
      if (c.high > high) high = c.high
      if (c.low < low) low = c.low
    }
    up.push(((high - entry) / entry) * 100)
    down.push(((entry - low) / entry) * 100)
  }
  if (up.length < 40) return null
  return {
    horizonBars,
    windows: up.length,
    independent: Math.floor(up.length / horizonBars),
    long: { mfe: quantileTable(up), mae: quantileTable(down) },
    short: { mfe: quantileTable(down), mae: quantileTable(up) },
  }
}

/** Spread and the average slippage of a market order of each size, walked through the visible book. `null` for a size the book cannot fill. */
export function bookImpact(book, notionalsUsdt = []) {
  const parse = (levels) => (Array.isArray(levels) ? levels.map(([price, quantity]) => [Number(price), Number(quantity)]).filter(([p, q]) => p > 0 && q > 0) : [])
  const bids = parse(book?.bids)
  const asks = parse(book?.asks)
  if (!bids.length || !asks.length) return null
  const mid = (bids[0][0] + asks[0][0]) / 2
  const walk = (levels, notional, direction) => {
    let remaining = notional
    let quantity = 0
    for (const [price, size] of levels) {
      const take = Math.min(remaining, price * size)
      quantity += take / price
      remaining -= take
      if (remaining <= 1e-9) break
    }
    if (remaining > 1e-9 || !(quantity > 0)) return null
    return round((direction * ((notional / quantity) - mid) / mid) * 100, 4)
  }
  return {
    levels: Math.min(bids.length, asks.length),
    spreadPct: round(((asks[0][0] - bids[0][0]) / mid) * 100, 4),
    impacts: [...new Set(notionalsUsdt.filter((value) => value > 0).map((value) => round(value, 2)))].map((notionalUsdt) => ({
      notionalUsdt,
      buyPct: walk(asks, notionalUsdt, 1),
      sellPct: walk(bids, notionalUsdt, -1),
    })),
  }
}

/** Everything measurable from the market data (each part is optional and skipped when there is not enough data). */
export function buildRiskEvidence({ candles5m = null, candles1h = null, depth = null, notionalsUsdt = [] } = {}) {
  const safely = (fn) => { try { return fn() } catch { return null } }
  const evidence = {
    atr5m: candles5m ? safely(() => atrPercentile(candles5m)) : null,
    atr1h: candles1h ? safely(() => atrPercentile(candles1h)) : null,
    excursion: candles5m ? safely(() => excursionStats(candles5m, 12)) : null,
    book: depth ? safely(() => bookImpact(depth, notionalsUsdt)) : null,
  }
  return Object.values(evidence).some(Boolean) ? evidence : null
}

const spanLabel = (bars, barMinutes) => {
  const hours = (bars * barMinutes) / 60
  return hours >= 48 ? `~${(hours / 24).toFixed(1)} days` : `~${hours.toFixed(0)}h`
}

/**
 * The prompt lines for the Risk Manager. `side` is the Analyst's LONG/SHORT; `stopPct` / `targetPct` are the Analyst's numbers (used only
 * to express them as base rates); `flowMetrics` supplies funding. Returns [] when there is nothing to say.
 */
export function describeRiskEvidence({ evidence = null, side = 'LONG', stopPct = null, targetPct = null, flowMetrics = null, maxLeverage = 5 } = {}) {
  const lines = []
  const direction = side === 'SHORT' ? 'short' : 'long'
  const label = direction.toUpperCase()

  if (evidence?.atr5m || evidence?.atr1h) {
    const parts = []
    if (evidence.atr5m) parts.push(`5M ATR is ${fx(evidence.atr5m.atrPct, 3)}% of price, the ${evidence.atr5m.percentile}th percentile of the last ${evidence.atr5m.samples} 5M bars (${spanLabel(evidence.atr5m.samples, 5)})`)
    if (evidence.atr1h) parts.push(`1H ATR is ${fx(evidence.atr1h.atrPct, 3)}%, the ${evidence.atr1h.percentile}th percentile of the last ${evidence.atr1h.samples} 1H bars (${spanLabel(evidence.atr1h.samples, 60)})`)
    lines.push(`- Volatility context: ${parts.join('; ')}.`)
  }

  const stats = evidence?.excursion?.[direction]
  if (stats?.mfe && stats?.mae) {
    const horizonMinutes = evidence.excursion.horizonBars * 5
    const trio = (table) => `median ${fx(percentileOf(table, 50), 2)}% / 75th ${fx(percentileOf(table, 75), 2)}% / 90th ${fx(percentileOf(table, 90), 2)}%`
    lines.push(`- Typical excursion in the ${horizonMinutes} minutes after ANY 5M close, for a ${label} (n=${evidence.excursion.windows} overlapping windows, about ${evidence.excursion.independent} independent): favorable ${trio(stats.mfe)}; adverse ${trio(stats.mae)}. This is a base rate for the symbol, not this setup.`)
    const stopTouched = finite(stopPct) && stopPct > 0 ? rankIn(stats.mae, stopPct) : null
    const targetReached = finite(targetPct) && targetPct > 0 ? rankIn(stats.mfe, targetPct) : null
    if (stopTouched != null || targetReached != null) {
      const bits = []
      if (stopTouched != null) bits.push(`price moved at least ${fx(stopPct)}% against a ${label} (the Analyst's stop distance) in about ${Math.round((1 - stopTouched) * 100)}% of windows`)
      if (targetReached != null) bits.push(`at least ${fx(targetPct)}% in favor (the Analyst's target distance) in about ${Math.round((1 - targetReached) * 100)}%`)
      lines.push(`- At the Analyst's numbers, within that horizon: ${bits.join('; ')}. Separate frequencies, not a win probability.`)
    }
  }

  const rate = flowMetrics?.fundingRatePct
  if (finite(rate)) {
    const pays = direction === 'long' ? Number(rate) > 0 : Number(rate) < 0
    lines.push(`- Funding is ${fx(rate, 4)}% per interval (~${fx(flowMetrics.fundingAnnualizedPct, 1)}% annualised, assuming 8h intervals): a ${label} ${Number(rate) === 0 ? 'neither pays nor receives' : pays ? 'PAYS' : 'RECEIVES'} about ${fx(Math.abs(Number(rate)), 4)}% of notional per interval held.`)
  }

  const book = evidence?.book
  if (book) {
    const sizes = (book.impacts || []).map((impact) => (
      impact.buyPct == null || impact.sellPct == null
        ? `${fx(impact.notionalUsdt)} USDT exceeds the visible depth`
        : `${fx(impact.notionalUsdt)} USDT slips about ${fx(impact.buyPct, 4)}% buying / ${fx(impact.sellPct, 4)}% selling`))
    lines.push(`- Live futures order book (top ${book.levels} levels): spread ${fx(book.spreadPct, 4)}%${sizes.length ? `; a market order of ${sizes.join('; ')}` : ''}.`)
  }

  // Nothing measured -> say nothing (the liquidation table is general knowledge, it must not make an empty block look like evidence).
  if (!lines.length) return []
  const leverages = [1, 2, 3, 5, 10].filter((leverage) => leverage <= Math.max(maxLeverage, 1))
  lines.push(`- Isolated-margin liquidation is roughly 100/leverage % from entry before maintenance margin (${leverages.map((leverage) => `${leverage}x ~ ${fx(100 / leverage, 0)}%`).join(', ')}); the code requires the stop inside 90% of that.`)
  lines.unshift('Measured evidence (computed from recent market data; symbol base rates, not statistics of this exact setup):')
  lines.push('- Not measured, so unavailable to you: exchange fees, account drawdown / daily loss, and MFE/MAE of comparable setups.')
  return lines
}
