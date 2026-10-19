// Historical, point-in-time-correct market inputs for the Bot Trading backtest runner
// (bot-backtest-runner.js). Reuses the bot research harness's candle/funding cache
// (server/backtest/{data-cache,historical-data}.js) - same Binance public endpoints, same
// on-disk cache the AI Trading backtest and the 8-bot replay dataset tool both already use.
//
// Every native bot (model-1..8) is evaluated off the SAME three timeframes (5m entry, 15m
// setup, 1h bias) regardless of which bot - see server/backtest/replay-worker.js's BIAS_TF /
// SETUP_TF / ENTRY_TF constants, which this mirrors exactly so a backtest result is directly
// comparable to that tool's own findings.

import { getCachedFunding, getCachedKlines } from '../backtest/data-cache.js'
import { fundingRateAt } from '../backtest/historical-data.js'
import { sliceClosedAsOf } from '../ai-trading/backtest-data.js'

export const BIAS_TF = '1h'
export const SETUP_TF = '15m'
export const ENTRY_TF = '5m'
// How many trailing bars analyzeSymbolStrategy gets per call - matches replay-worker.js's
// ENTRY_WIN/SETUP_WIN/BIAS_WIN so a signal fires on exactly the same window live/backtest/
// research-tool all three use.
export const ENTRY_WIN = 300
export const SETUP_WIN = 160
export const BIAS_WIN = 160
// 1h bias needs ~220 warm-up 5m bars before the first real decision point (same as
// replay-worker.js's WARMUP_BARS) so the indicators behind it are not running on thin data.
export const WARMUP_BARS = 220
// 1h bias lookback buffer before the backtest's own start, generous enough for BIAS_WIN.
const LOOKBACK_BUFFER_MS = 14 * 24 * 60 * 60_000

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

/**
 * Pre-fetches entry/setup/bias candles + funding history for a symbol over [startMs, endMs]
 * (plus lookback). Returns the raw entry klines (simulateExitPolicy needs raw rows + a bar
 * index, not parsed objects) alongside an `atIndex(i)` accessor giving analyzeSymbolStrategy
 * exactly the trailing-window candles it would see live at that bar.
 */
export async function loadBotBacktestSeries(symbol, startMs, endMs, { onFetch } = {}) {
  const fetchStart = startMs - LOOKBACK_BUFFER_MS
  const [entryRows, setupRows, biasRows, fundingHistory] = await Promise.all([
    getCachedKlines(symbol, ENTRY_TF, fetchStart, endMs, { onFetch }),
    getCachedKlines(symbol, SETUP_TF, fetchStart, endMs, { onFetch }),
    getCachedKlines(symbol, BIAS_TF, fetchStart, endMs, { onFetch }),
    getCachedFunding(symbol, fetchStart, endMs, { onFetch }).catch(() => []),
  ])
  const setupC = toCandleData(setupRows)
  const biasC = toCandleData(biasRows)

  return {
    entryRows,
    atIndex(i) {
      const nowMs = Number(entryRows[i]?.[6] || 0)
      return {
        entryCandles: toCandleData(entryRows.slice(Math.max(0, i - ENTRY_WIN), i + 1)),
        setupCandles: sliceClosedAsOf(setupC, nowMs, SETUP_WIN),
        biasCandles: sliceClosedAsOf(biasC, nowMs, BIAS_WIN),
        marketContext: { fundingRate: fundingRateAt(fundingHistory, nowMs), fundingAvailable: true },
      }
    },
  }
}
