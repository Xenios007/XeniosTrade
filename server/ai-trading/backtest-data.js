// Historical, point-in-time-correct market inputs for AI Trading's backtest runner (backtest-runner.js). Reuses
// the bot backtest harness's candle/funding cache (server/backtest/{data-cache,historical-data}.js) instead of
// refetching: same Binance public endpoints, same on-disk cache, same "fetch only what's missing" behavior.
//
// "Point-in-time-correct" is the whole point here: the live pipeline's buildMarketSnapshot already filters out
// any candle not yet closed as of `nowMs` (see pipeline.js's closedOnly), so the only job this module has is
// handing it enough trailing history ending at (not after) a simulated `nowMs` - never real data from the
// simulation's own future.

import { getCachedFunding, getCachedKlines } from '../backtest/data-cache.js'
import { fundingRateAt } from '../backtest/historical-data.js'

// Daily regime/context needs 120 trailing bars = 120 days; 4H bias needs 200 bars = ~33 days. 150 days of
// lookback buffer before the backtest's own start covers both with room, for any of the configured timeframes.
const LOOKBACK_BUFFER_MS = 150 * 24 * 60 * 60_000

/** Same conversion mock-trading-server.js's toCandleData does for live klines - duplicated (not imported) to
 * avoid a circular import between this module and the main server file. */
function toCandleData(klines) {
  return klines.map((entry) => ({
    time: entry[0],
    closeTime: Number(entry[6] || 0),
    open: Number(entry[1]),
    high: Number(entry[2]),
    low: Number(entry[3]),
    close: Number(entry[4]),
    volume: Number(entry[5]),
    takerBuyBaseVolume: Number(entry[9] || 0),
    takerSellBaseVolume: Math.max(Number(entry[5] || 0) - Number(entry[9] || 0), 0),
    deltaVolume: Number(entry[9] || 0) - Math.max(Number(entry[5] || 0) - Number(entry[9] || 0), 0),
  }))
}

/** The trailing `bars` candles whose close time is at or before `nowMs` - never a candle still open (or later) at that point. */
export function sliceClosedAsOf(candles, nowMs, bars) {
  let end = candles.length
  while (end > 0 && candles[end - 1].closeTime > nowMs) end -= 1
  return candles.slice(Math.max(0, end - bars), end)
}

/**
 * Pre-fetches every candle series + funding history a symbol's AI Trading timeframe profile needs for
 * [startMs, endMs] (plus lookback), then returns an `atMs(nowMs)` accessor shaped exactly like the live
 * pipeline's getMarketInputs result ({ entry, bias, higher, regime?, marketContext }) - the only difference is
 * every series in it is sliced to what would actually have been known at that simulated moment.
 *
 * Deliberately missing (and left for runAiTradingPipeline's existing graceful-degradation paths to handle):
 * order book depth and open-interest / long-short-ratio history are live-only endpoints with no reliable
 * historical replay, so `getFlowData` is simply omitted by the caller for backtest runs (lean mode already
 * handles "no flow data" with its own "Flow data unavailable for this run" prompt line).
 */
export async function loadBacktestSeries(symbol, timeframe, startMs, endMs, { onFetch } = {}) {
  const fetchStart = startMs - LOOKBACK_BUFFER_MS
  const [entryRows, biasRows, contextRows, regimeRows, fundingHistory] = await Promise.all([
    getCachedKlines(symbol, timeframe.entry.interval, fetchStart, endMs, { onFetch }),
    getCachedKlines(symbol, timeframe.bias.interval, fetchStart, endMs, { onFetch }),
    getCachedKlines(symbol, timeframe.context.interval, fetchStart, endMs, { onFetch }),
    timeframe.regime ? getCachedKlines(symbol, timeframe.regime.interval, fetchStart, endMs, { onFetch }) : Promise.resolve([]),
    getCachedFunding(symbol, fetchStart, endMs, { onFetch }).catch(() => []),
  ])

  const entry = toCandleData(entryRows)
  const bias = toCandleData(biasRows)
  const context = toCandleData(contextRows)
  const regime = timeframe.regime ? toCandleData(regimeRows) : []

  return {
    atMs(nowMs) {
      return {
        entry: sliceClosedAsOf(entry, nowMs, timeframe.entry.bars),
        bias: sliceClosedAsOf(bias, nowMs, timeframe.bias.bars),
        higher: sliceClosedAsOf(context, nowMs, timeframe.context.bars),
        ...(timeframe.regime ? { regime: sliceClosedAsOf(regime, nowMs, timeframe.regime.bars) } : {}),
        marketContext: { fundingRate: fundingRateAt(fundingHistory, nowMs) },
      }
    },
  }
}
