// Evidence for the Market Flow Agent: derivatives positioning and order flow that
// the Analyst (which only sees price/indicators) cannot see. All from Binance's
// public futures endpoints plus the candles/order book the pipeline already has —
// no extra API keys.
//
//   funding + mark/index basis   how expensive it is to hold the position, and crowding
//   open interest vs price       are new positions being opened, or old ones closed/squeezed
//   long/short account ratio     retail positioning; top-trader position ratio: bigger accounts
//   taker buy/sell               who is hitting the book (aggressor flow)
//   order book imbalance         resting liquidity near the price
//   BTC move                     for alts, the market-wide tide
//
// summarizeFlow is pure (fixtures in tests); collectFlowData does the fetching.

const num = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)
const pctChange = (from, to) => (from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : null)
const at = (list, indexFromEnd) => (list.length > indexFromEnd ? list[list.length - 1 - indexFromEnd] : null)

/** Minimum number of independent derivatives sources (of premium/OI/global L-S/top L-S/taker) needed to run the agent. */
export const MIN_FLOW_SOURCES = 2

// Below these moves a series is treated as flat, so noise isn't read as "new longs".
const FLAT_PRICE_PCT = 0.1
const FLAT_OI_PCT = 0.2

/** Classic price-vs-open-interest read, computed in code so the model has a checked label to reason from. */
export function classifyOiPriceRegime(priceChangePct, oiChangePct) {
  if (!Number.isFinite(priceChangePct) || !Number.isFinite(oiChangePct)) return null
  if (Math.abs(priceChangePct) < FLAT_PRICE_PCT || Math.abs(oiChangePct) < FLAT_OI_PCT) return 'no clear signal (price or open interest is flat)'
  if (priceChangePct > 0) return oiChangePct > 0 ? 'new longs opening (price up, OI up)' : 'short covering (price up, OI down)'
  return oiChangePct > 0 ? 'new shorts opening (price down, OI up)' : 'long liquidation / unwinding (price down, OI down)'
}

function candleChange(candles, barsBack) {
  const last = at(candles, 0)
  const past = at(candles, barsBack)
  return last && past ? pctChange(past.close, last.close) : null
}

function bookImbalance(orderBook) {
  if (!orderBook?.bids?.length || !orderBook?.asks?.length) return null
  const sum = (levels) => levels.reduce((total, [, quantity]) => total + (Number(quantity) || 0), 0)
  const bids = sum(orderBook.bids)
  const asks = sum(orderBook.asks)
  return asks > 0 ? round(bids / asks, 2) : null
}

/**
 * @param {object} raw
 * @param {object|null} raw.premium     /fapi/v1/premiumIndex
 * @param {object[]|null} raw.oiHist    /futures/data/openInterestHist, 5m, oldest first
 * @param {object[]|null} raw.globalLs  /futures/data/globalLongShortAccountRatio, 1h
 * @param {object[]|null} raw.topLs     /futures/data/topLongShortPositionRatio, 1h
 * @param {object[]|null} raw.taker     /futures/data/takerlongshortRatio, 5m
 * @param {object|null} raw.orderBook   { bids, asks }
 * @param {object[]} raw.entry          closed 5m candles for the symbol
 * @param {object[]|null} raw.btcCandles closed 5m BTCUSDT candles (omit when the symbol is BTC)
 */
export function summarizeFlow({ premium, oiHist, globalLs, topLs, taker, orderBook, entry = [], btcCandles = null }) {
  const priceChange1h = candleChange(entry, 12)
  const priceChange4h = candleChange(entry, 48)

  const oi = Array.isArray(oiHist) ? oiHist.map((row) => num(row.sumOpenInterestValue)).filter((value) => value != null) : []
  const oiNow = at(oi, 0)
  const oiChange1h = oi.length > 12 ? pctChange(at(oi, 12), oiNow) : null
  const oiChange4h = oi.length > 2 ? pctChange(oi[0], oiNow) : null

  const funding = num(premium?.lastFundingRate)
  const mark = num(premium?.markPrice)
  const index = num(premium?.indexPrice)

  const lsRatios = Array.isArray(globalLs) ? globalLs.map((row) => num(row.longShortRatio)).filter((value) => value != null) : []
  const lsLatest = at(lsRatios, 0)
  const topRatios = Array.isArray(topLs) ? topLs.map((row) => num(row.longShortRatio)).filter((value) => value != null) : []

  const takerRows = Array.isArray(taker) ? taker.slice(-12) : []
  const takerRatios = takerRows.map((row) => num(row.buySellRatio)).filter((value) => value != null)
  // Volume-weighted (sum of buys / sum of sells): averaging per-candle ratios overweights thin candles and can
  // point the opposite way from the real aggressor flow.
  const takerBuyVol = takerRows.reduce((total, row) => total + (num(row.buyVol) || 0), 0)
  const takerSellVol = takerRows.reduce((total, row) => total + (num(row.sellVol) || 0), 0)
  const takerWeighted = takerSellVol > 0 ? takerBuyVol / takerSellVol : null

  const recentCandles = entry.slice(-12)
  const candleVolume = recentCandles.reduce((total, candle) => total + (candle.volume || 0), 0)
  const candleTakerBuy = recentCandles.reduce((total, candle) => total + (candle.takerBuyBaseVolume || 0), 0)

  const metrics = {
    fundingRatePct: funding == null ? null : round(funding * 100, 4),
    fundingAnnualizedPct: funding == null ? null : round(funding * 100 * 3 * 365, 1), // assumes 8h funding intervals
    markIndexBasisPct: mark != null && index ? round(((mark - index) / index) * 100, 4) : null,
    openInterestUsd: oiNow == null ? null : Math.round(oiNow),
    oiChange1hPct: round(oiChange1h, 2),
    oiChange4hPct: round(oiChange4h, 2),
    priceChange1hPct: round(priceChange1h, 2),
    priceChange4hPct: round(priceChange4h, 2),
    oiPriceRegime: classifyOiPriceRegime(priceChange1h, oiChange1h),
    longShortRatio: round(lsLatest, 2),
    longAccountPct: lsLatest == null ? null : round((lsLatest / (1 + lsLatest)) * 100, 1),
    longShortRatioChange: lsRatios.length > 1 ? round(lsLatest - lsRatios[0], 2) : null,
    topTraderLongShortRatio: round(at(topRatios, 0), 2),
    takerBuySellRatio1h: takerWeighted != null ? round(takerWeighted, 2) : takerRatios.length ? round(takerRatios.reduce((a, b) => a + b, 0) / takerRatios.length, 2) : null,
    candleTakerBuySharePct: candleVolume > 0 ? round((candleTakerBuy / candleVolume) * 100, 1) : null,
    bookImbalance: bookImbalance(orderBook),
    btcChange1hPct: btcCandles ? round(candleChange(btcCandles, 12), 2) : null,
    btcChange4hPct: btcCandles ? round(candleChange(btcCandles, 48), 2) : null,
  }

  const sources = {
    premium: funding != null,
    openInterest: oi.length > 2,
    longShort: lsRatios.length > 0,
    topTraders: topRatios.length > 0,
    taker: takerRatios.length > 0,
  }
  const derivativesSources = Object.values(sources).filter(Boolean).length

  return { metrics, sources, derivativesSources }
}

const show = (value, suffix = '', fallback = 'unavailable') => (value == null ? fallback : `${value}${suffix}`)

/** Prompt-ready lines for the Flow Agent (and the Critic/Risk Manager, who reference the same evidence). */
export function describeFlow(metrics) {
  return [
    `Funding rate: ${show(metrics.fundingRatePct, '% per interval')} (~${show(metrics.fundingAnnualizedPct, '% annualised')}); mark-vs-index basis ${show(metrics.markIndexBasisPct, '%')}`,
    `Open interest: ${metrics.openInterestUsd == null ? 'unavailable' : `${(metrics.openInterestUsd / 1e6).toFixed(0)}M USD`}; change ${show(metrics.oiChange1hPct, '%')} over 1h, ${show(metrics.oiChange4hPct, '%')} over 4h`,
    `Price change: ${show(metrics.priceChange1hPct, '%')} over 1h, ${show(metrics.priceChange4hPct, '%')} over 4h`,
    `Price vs open interest (1h, computed): ${metrics.oiPriceRegime || 'unavailable'}`,
    `Long/short account ratio: ${show(metrics.longShortRatio)} (${show(metrics.longAccountPct, '% of accounts long')}), change over 8h ${show(metrics.longShortRatioChange)}`,
    `Top-trader long/short position ratio: ${show(metrics.topTraderLongShortRatio)}`,
    `Futures taker buy/sell volume ratio (last 1h, volume-weighted, >1 = aggressive buying): ${show(metrics.takerBuySellRatio1h)}; separately, spot taker buy share over the last 12 5m candles: ${show(metrics.candleTakerBuySharePct, '%')} (a different market, so the two can differ)`,
    `Order book bid/ask depth ratio (top 20 levels, >1 = more bids): ${show(metrics.bookImbalance)}`,
    `BTC move (market tide): ${show(metrics.btcChange1hPct, '%')} over 1h, ${show(metrics.btcChange4hPct, '%')} over 4h`,
  ]
}

/**
 * Fetches everything in parallel; any single source failing just leaves its metrics null.
 * Throws only when too few derivatives sources came back to say anything useful.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {(url: string, cacheKey: string) => Promise<any>} args.fetchJson
 * @param {string} args.baseUrl          Binance USDT-M futures base URL (mainnet: public market data)
 * @param {object[]} args.entry          closed 5m candles for the symbol
 * @param {object|null} args.orderBook
 * @param {object[]|null} args.btcCandles
 */
export async function collectFlowData({ symbol, fetchJson, baseUrl, entry, orderBook = null, btcCandles = null }) {
  const query = (path, extra = '') => `${baseUrl}${path}?symbol=${symbol}${extra}`
  const [premium, oiHist, globalLs, topLs, taker] = await Promise.allSettled([
    fetchJson(query('/fapi/v1/premiumIndex'), `flow:premium:${symbol}`),
    fetchJson(query('/futures/data/openInterestHist', '&period=5m&limit=48'), `flow:oi:${symbol}`),
    fetchJson(query('/futures/data/globalLongShortAccountRatio', '&period=1h&limit=8'), `flow:gls:${symbol}`),
    fetchJson(query('/futures/data/topLongShortPositionRatio', '&period=1h&limit=8'), `flow:top:${symbol}`),
    fetchJson(query('/futures/data/takerlongshortRatio', '&period=5m&limit=12'), `flow:taker:${symbol}`),
  ]).then((results) => results.map((result) => (result.status === 'fulfilled' ? result.value : null)))

  // Binance returns the history endpoints oldest-first already; sort defensively by timestamp.
  const byTime = (rows) => (Array.isArray(rows) ? [...rows].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)) : null)

  const summary = summarizeFlow({
    premium,
    oiHist: byTime(oiHist),
    globalLs: byTime(globalLs),
    topLs: byTime(topLs),
    taker: byTime(taker),
    orderBook,
    entry,
    btcCandles,
  })

  if (summary.derivativesSources < MIN_FLOW_SOURCES) {
    throw new Error(`Flow data unavailable for ${symbol}: only ${summary.derivativesSources} of 5 derivatives sources responded.`)
  }
  return summary
}
