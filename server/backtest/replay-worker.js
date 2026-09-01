// worker_threads entry for the 8-bot replay. One worker owns one CPU core and
// processes symbols one at a time end-to-end: load cached klines, step the 5m
// bars, run the real analyzeSymbolStrategy, capture the leakage-free entry-time
// feature vector + regime + split tag, simulate the exit, write the symbol's
// rows to RUN_DIR/<symbol>.ndjson, and post a summary back to the parent.
//
// Each worker loads BTC/ETH context once and reuses it across its symbols.

process.env.XENIOS_SERVER_AUTOSTART = 'off'

import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { fundingRateAt } from './historical-data.js'
import { getCachedKlines, getCachedFunding, readMeta } from './data-cache.js'
import { buildEntryFeatures, fundingFeatures } from './feature-lib.js'
import { classifyRegime, deriveRegimeCandlesFromHourly } from './regime.js'
import { computeSplitBoundaries, assignSplit, SPLIT_EMBARGO_MS } from './splits.js'
import { buildMarketContext } from './btc-context.js'
import { SIGNAL_MODELS, getSignalModelName, getSignalModel, getEffectiveSignalModelStrategy } from '../../src/lib/signalModels.js'
import { isExtendedBacktestSymbol } from '../../src/lib/tradingConfig.js'

const { analyzeSymbolStrategy, toCandleData, getSettings } = await import('../mock-trading-server.js')

const {
  RUN_DIR, MONTHS, STRIDE, FEE_BPS, SLIPPAGE_BPS, MAX_HOLD_MS,
  CAP_PER_SYMBOL_BOT, STRICT_CONTEXT, ETH_CONTEXT, NO_FEATURES, RUN_ID, activeBots,
} = workerData

const BIAS_TF = '1h'
const SETUP_TF = '15m'
const ENTRY_TF = '5m'
const WARMUP_BARS = 220
const ENTRY_WIN = 300
const SETUP_WIN = 160
const BIAS_WIN = 160

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const round2 = (n) => Math.round(Number(n) * 100) / 100
const endMs = Date.now()
const startMs = endMs - MONTHS * 30 * 86_400_000

const settings = await getSettings()
const effStrategy = {}
for (const botId of activeBots) {
  effStrategy[botId] = getEffectiveSignalModelStrategy(settings.strategy, botId, { runningBalance: 1000 })
}

// ---- shared market context (loaded once per worker) --------------------

function sliceClosedBy(rawKlines, nowMs) {
  let hi = rawKlines.length
  while (hi > 0 && Number(rawKlines[hi - 1][6]) > nowMs) hi -= 1
  return rawKlines.slice(0, hi)
}
function takerImbalanceProxy(entryCandles) {
  const w = entryCandles.slice(-5)
  let buy = 0
  let sell = 0
  for (const c of w) { buy += Number(c.takerBuyBaseVolume || 0); sell += Number(c.takerSellBaseVolume || 0) }
  if (sell <= 0) return buy > 0 ? 3 : 1
  return buy / sell
}
function tradePnl({ side, entryPrice, exitPrice, notional }) {
  const r = side === 'BUY' ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice
  return r * notional
}
function simulateExit({ side, entryPrice, stopLoss, takeProfit, notional, isBot4, entryBarIndex, entryTfRaw }) {
  const entryTime = Number(entryTfRaw[entryBarIndex][0])
  const moneyStopUsd = isBot4 ? 1 : 0
  const moneyStopPrice = moneyStopUsd > 0 && notional > 0
    ? (side === 'BUY' ? entryPrice * (1 - moneyStopUsd / notional) : entryPrice * (1 + moneyStopUsd / notional))
    : null
  for (let i = entryBarIndex + 1; i < entryTfRaw.length; i += 1) {
    const row = entryTfRaw[i]
    const high = Number(row[2])
    const low = Number(row[3])
    const close = Number(row[4])
    const closeTime = Number(row[6])
    const hitTP = side === 'BUY' ? high >= takeProfit : low <= takeProfit
    const hitSL = side === 'BUY' ? low <= stopLoss : high >= stopLoss
    const hitMoneyStop = moneyStopPrice != null && (side === 'BUY' ? low <= moneyStopPrice : high >= moneyStopPrice)
    if (hitSL || hitMoneyStop) {
      const stopFill = hitSL && (!hitMoneyStop || (side === 'BUY' ? stopLoss >= moneyStopPrice : stopLoss <= moneyStopPrice))
      return { price: stopFill ? stopLoss : moneyStopPrice, time: closeTime, status: 'CLOSED_SL', bars: i - entryBarIndex }
    }
    if (hitTP) return { price: takeProfit, time: closeTime, status: 'CLOSED_TP', bars: i - entryBarIndex }
    if (closeTime - entryTime >= MAX_HOLD_MS) {
      const pnl = tradePnl({ side, entryPrice, exitPrice: close, notional })
      return { price: close, time: closeTime, status: pnl >= 0 ? 'CLOSED_TP' : 'CLOSED_SL', timedOut: true, bars: i - entryBarIndex }
    }
  }
  return null
}
const rewardFromLabel = (label) => Number(Math.tanh(Number(label.netR || 0) / 2).toFixed(6))

let marketSeries = null
async function loadMarketSeries() {
  if (marketSeries) return marketSeries
  const [b5, b15, b1h] = await Promise.all([
    getCachedKlines('BTCUSDT', '5m', startMs, endMs, { readOnly: true }),
    getCachedKlines('BTCUSDT', '15m', startMs, endMs, { readOnly: true }),
    getCachedKlines('BTCUSDT', '1h', startMs, endMs, { readOnly: true }),
  ])
  let e5 = []
  let e1h = []
  if (ETH_CONTEXT) {
    ;[e5, e1h] = await Promise.all([
      getCachedKlines('ETHUSDT', '5m', startMs, endMs, { readOnly: true }),
      getCachedKlines('ETHUSDT', '1h', startMs, endMs, { readOnly: true }),
    ])
  }
  marketSeries = {
    btc: { c5: toCandleData(b5), c15: toCandleData(b15), c1h: toCandleData(b1h) },
    eth: { c5: toCandleData(e5), c1h: toCandleData(e1h) },
  }
  return marketSeries
}
// Forward-advancing cursors into the shared BTC/ETH context arrays. The replay
// steps time strictly forward, so each cursor only ever moves right — O(1)
// amortised instead of an O(n) backward scan per call.
function makeCtxCursors() {
  return { b5: 0, b15: 0, b1h: 0, e5: 0, e1h: 0 }
}
function advanceCursors(series, cur, nowMs) {
  const adv = (arr, idx) => {
    let i = idx
    while (i + 1 < arr.length && arr[i + 1].closeTime <= nowMs) i += 1
    return i
  }
  cur.b5 = adv(series.btc.c5, cur.b5)
  cur.b15 = adv(series.btc.c15, cur.b15)
  cur.b1h = adv(series.btc.c1h, cur.b1h)
  if (ETH_CONTEXT) {
    cur.e5 = adv(series.eth.c5, cur.e5)
    cur.e1h = adv(series.eth.c1h, cur.e1h)
  }
}
function contextAt(series, cur, nowMs) {
  const win = (arr, idx) => {
    // idx is the last bar with closeTime <= nowMs; guard against the pre-first case
    const hi = arr.length && arr[idx].closeTime <= nowMs ? idx + 1 : 0
    return arr.slice(Math.max(0, hi - 260), hi)
  }
  const f = {}
  Object.assign(f, buildMarketContext('btc', {
    c5: win(series.btc.c5, cur.b5), c15: win(series.btc.c15, cur.b15), c1h: win(series.btc.c1h, cur.b1h),
  }))
  if (ETH_CONTEXT && series.eth.c1h.length) {
    Object.assign(f, buildMarketContext('eth', { c5: win(series.eth.c5, cur.e5), c1h: win(series.eth.c1h, cur.e1h) }))
  }
  return f
}

// ---- per-symbol ----------------------------------------------------

async function processSymbol(symbol) {
  const symFile = path.join(RUN_DIR, `${symbol}.ndjson`)
  // BTC/ETH context series are only needed for the feature vector.
  const series = NO_FEATURES ? { btc: { c5: [], c15: [], c1h: [] }, eth: { c5: [], c1h: [] } } : await loadMarketSeries()

  let biasTfRaw
  let setupTfRaw
  let entryTfRaw
  let funding
  try {
    ;[biasTfRaw, setupTfRaw, entryTfRaw, funding] = await Promise.all([
      getCachedKlines(symbol, BIAS_TF, startMs, endMs, { readOnly: true }),
      getCachedKlines(symbol, SETUP_TF, startMs, endMs, { readOnly: true }),
      getCachedKlines(symbol, ENTRY_TF, startMs, endMs, { readOnly: true }),
      STRICT_CONTEXT ? Promise.resolve([]) : getCachedFunding(symbol, startMs, endMs, { readOnly: true }),
    ])
  } catch (error) {
    return { symbol, rows: 0, error: String(error?.message || error) }
  }
  if (!entryTfRaw || entryTfRaw.length < WARMUP_BARS + 20) {
    return { symbol, rows: 0, skipped: `only ${entryTfRaw?.length || 0} 5m bars` }
  }

  const actualStart = Number(entryTfRaw[0][0])
  const actualEnd = Number(entryTfRaw[entryTfRaw.length - 1][0])
  const boundaries = computeSplitBoundaries(actualStart, actualEnd, SPLIT_EMBARGO_MS)
  const isExtended = isExtendedBacktestSymbol(symbol)

  const entryC = toCandleData(entryTfRaw)
  const setupC = toCandleData(setupTfRaw)
  const biasC = toCandleData(biasTfRaw)
  // Full derived 4h regime-candle series, built ONCE from the whole 1h raw array.
  // In the loop we just advance a cursor over it (never rebuild).
  const regime4hFull = deriveRegimeCandlesFromHourly(biasTfRaw)
  const ctxCur = makeCtxCursors()

  const openUntil = {}
  const reservoir = {}
  const seenCount = {}
  const HARD_SEEN = Number.MAX_SAFE_INTEGER // no early-exit: reservoir sampling keeps time coverage uniform
  let setupIdx = 0
  let biasIdx = 0
  let r4hIdx = 0
  let fundIdx = 0
  let qualifying = 0
  const symT0 = Date.now()
  let sinceYield = 0
  let sinceHb = 0
  const hbEvery = Math.max(1, Math.floor(40_000 / STRIDE))

  for (let i = WARMUP_BARS; i < entryTfRaw.length - 1; i += STRIDE) {
    if ((sinceYield += 1) >= 5000) {
      sinceYield = 0
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setImmediate(r))
    }
    if ((sinceHb += 1) >= hbEvery) {
      sinceHb = 0
      const done = i - WARMUP_BARS
      const total = entryTfRaw.length - WARMUP_BARS
      const eta = done > 0 ? Math.round(((Date.now() - symT0) / done) * (total - done) / 1000) : 0
      parentPort.postMessage({ type: 'progress', symbol, pct: Number(((done / total) * 100).toFixed(1)), qualifying, etaSeconds: eta })
    }

    const nowMs = entryC[i].closeTime
    while (setupIdx + 1 < setupC.length && setupC[setupIdx + 1].closeTime <= nowMs) setupIdx += 1
    while (biasIdx + 1 < biasC.length && biasC[biasIdx + 1].closeTime <= nowMs) biasIdx += 1
    while (r4hIdx + 1 < regime4hFull.length && regime4hFull[r4hIdx + 1].closeTime <= nowMs) r4hIdx += 1
    while (fundIdx + 1 < funding.length && funding[fundIdx + 1].fundingTime <= nowMs) fundIdx += 1
    if (setupIdx < 40 || biasIdx < 26) continue

    const split = assignSplit(nowMs, boundaries)
    if (split === 'purged') continue

    const entryCandles = entryC.slice(Math.max(0, i - ENTRY_WIN), i + 1)
    const setupCandles = setupC.slice(Math.max(0, setupIdx - SETUP_WIN), setupIdx + 1)
    const biasCandles = biasC.slice(Math.max(0, biasIdx - BIAS_WIN), biasIdx + 1)
    // 4h regime window closed by now (cursor, no rebuild)
    const regime4h = funding && regime4hFull.length
      ? regime4hFull.slice(Math.max(0, r4hIdx - 200), regime4hFull.length && regime4hFull[r4hIdx].closeTime <= nowMs ? r4hIdx + 1 : 0)
      : []

    // lightweight funding lookup for the signal engine's marketContext (cursor).
    // Percentile over a trailing 240-entry window (O(240), not O(all funding)).
    const fundAvail = funding.length > 0 && funding[fundIdx] && funding[fundIdx].fundingTime <= nowMs
    const fundNow = fundAvail ? funding[fundIdx].fundingRate : 0
    let fundPct = 0.5
    if (fundAvail) {
      const w0 = Math.max(0, fundIdx - 239)
      let below = 0
      for (let k = w0; k <= fundIdx; k += 1) if (funding[k].fundingRate <= fundNow) below += 1
      fundPct = below / (fundIdx - w0 + 1)
    }
    const marketContext = STRICT_CONTEXT
      ? { orderBookImbalance: 0, fundingRate: 0, fundingAvailable: false }
      : {
        orderBookImbalance: takerImbalanceProxy(entryCandles),
        fundingRate: fundNow,
        fundingPercentile: fundPct,
        fundingAvailable: fundAvail,
        orderFlowProxy: true,
      }
    void fundingRateAt; void sliceClosedBy; void fundingFeatures

    advanceCursors(series, ctxCur, nowMs)
    let featuresCache = null
    let featureVersionCache = 'featv1-2026-09'
    let regimeCache = null

    for (const botId of activeBots) {
      if ((seenCount[botId] || 0) >= HARD_SEEN) continue
      if (openUntil[botId] !== undefined && i < openUntil[botId]) continue

      let analysis
      try {
        analysis = analyzeSymbolStrategy(symbol, biasCandles, setupCandles, entryCandles, settings.strategy, botId, marketContext, [])
      } catch { analysis = null }
      if (!analysis || !analysis.entryPrice || !analysis.stopLoss || !analysis.takeProfit) continue

      const eff = effStrategy[botId]
      const leverage = Number(analysis.leverage || eff.leverage || 0)
      const margin = Number(analysis.margin || eff.marginPerTrade || 0)
      const side = analysis.side === 'SELL' || analysis.direction === 'SHORT' ? 'SELL' : 'BUY'
      const entryPrice = Number(analysis.entryPrice)
      const notional = Number(analysis.positionNotional) || (margin * leverage) || entryPrice
      const stopLoss = Number(analysis.stopLoss)
      const takeProfit = Number(analysis.takeProfit)
      const configuredStopLossPercent = Number(analysis.configuredStopLossPercent || 0)

      const exit = simulateExit({ side, entryPrice, stopLoss, takeProfit, notional, isBot4: botId === 'model-4', entryBarIndex: i, entryTfRaw })
      if (!exit) continue

      if (!NO_FEATURES && !featuresCache) {
        const fundingUpTo = funding.slice(0, fundIdx + 1)
        const built = buildEntryFeatures({ entryCandles, setupCandles, biasCandles, regimeCandles: regime4h, fundingHistory: fundingUpTo, tMs: nowMs })
        featuresCache = { ...built.features, ...contextAt(series, ctxCur, nowMs) }
        featureVersionCache = built.featureVersion
      }
      // regime tag is always captured (cheap, needed for report breakdowns)
      if (!regimeCache) regimeCache = classifyRegime({ biasCandles, entryCandles, regimeCandles: regime4h }).regime

      const friction = notional * ((FEE_BPS + SLIPPAGE_BPS) / 10_000) * 2
      const grossPnl = tradePnl({ side, entryPrice, exitPrice: exit.price, notional })
      const netPnl = round2(grossPnl - friction)
      const riskUsd = Math.abs(entryPrice - stopLoss) / entryPrice * notional || notional * 0.005
      const label = {
        outcome: exit.status,
        win: netPnl > 0 ? 1 : 0,
        tpBeforeSl: exit.status === 'CLOSED_TP' && !exit.timedOut ? 1 : 0,
        netR: Number((netPnl / riskUsd).toFixed(4)),
        netReturn: Number((netPnl / notional).toFixed(6)),
        pnl: netPnl,
        grossPnl: round2(grossPnl),
        frictionUsd: round2(friction),
        holdBars: exit.bars,
        holdHours: Number(((exit.time - nowMs) / 3_600_000).toFixed(2)),
        timedOut: Boolean(exit.timedOut),
      }
      const model = getSignalModel(botId)
      const rec = {
        schemaVersion: 2,
        id: `bt2-${botId}-${symbol}-${nowMs}`,
        runId: RUN_ID,
        symbol,
        isExtendedUniverse: isExtended,
        timestamp: nowMs,
        tradeDateKey: isoDay(nowMs),
        closedDateKey: isoDay(exit.time),
        closedAt: exit.time,
        signalModelId: botId,
        signalModelName: getSignalModelName(botId),
        strategyFamily: analysis.strategyFamily || model.strategyFamily || null,
        setupFamily: analysis.setupFamily || 'Unclassified',
        side,
        marketRegime: regimeCache,
        split,
        featureVersion: NO_FEATURES ? 'none' : featureVersionCache,
        features: NO_FEATURES ? null : featuresCache,
        entryPrice: round2(entryPrice),
        exitPrice: round2(exit.price),
        stopLoss: round2(stopLoss),
        takeProfit: round2(takeProfit),
        notional: round2(notional),
        margin: round2(margin),
        leverage,
        configuredStopLossPercent: Number(configuredStopLossPercent.toFixed(4)),
        signalScore: Number(analysis.score || 0),
        signalSummary: String(analysis.summary || ''),
        label,
        reward: rewardFromLabel(label),
        status: exit.status,
        result: exit.status === 'CLOSED_TP' ? 'TP' : 'SL',
        pnl: netPnl,
        grossPnl: round2(grossPnl),
        frictionUsd: round2(friction),
        transactTime: nowMs,
        timedOut: Boolean(exit.timedOut),
        mode: 'backtest',
        source: 'AUTO_BACKTEST',
        backtest: true,
        walletId: null,
        walletName: `Backtest ${getSignalModelName(botId)}`,
      }

      seenCount[botId] = (seenCount[botId] || 0) + 1
      qualifying += 1
      const buf = (reservoir[botId] ||= [])
      if (buf.length < CAP_PER_SYMBOL_BOT) buf.push(rec)
      else {
        const j = Math.floor(Math.random() * seenCount[botId])
        if (j < CAP_PER_SYMBOL_BOT) buf[j] = rec
      }

      let exitIdx = i + 1
      while (exitIdx < entryTfRaw.length && Number(entryTfRaw[exitIdx][6]) < exit.time) exitIdx += 1
      openUntil[botId] = exitIdx + 1
    }
  }

  const kept = []
  for (const botId of activeBots) for (const r of (reservoir[botId] || [])) kept.push(r)
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(symFile)
    ws.on('error', reject)
    for (const r of kept) ws.write(`${JSON.stringify(r)}\n`)
    ws.end(resolve)
  })

  const meta = await readMeta(symbol)
  const perBot = {}
  for (const r of kept) {
    const b = (perBot[r.signalModelId] ||= { rows: 0, wins: 0, byRegime: {}, bySplit: {} })
    b.rows += 1
    if (r.label.win) b.wins += 1
    b.byRegime[r.marketRegime] = (b.byRegime[r.marketRegime] || 0) + 1
    b.bySplit[r.split] = (b.bySplit[r.split] || 0) + 1
  }
  return {
    symbol,
    rows: kept.length,
    qualifying,
    historyStart: isoDay(actualStart),
    historyEnd: isoDay(actualEnd),
    candles: entryTfRaw.length,
    meta: meta?.timeframes || null,
    perBot,
    isExtended,
    seconds: Math.round((Date.now() - symT0) / 1000),
  }
}

void SIGNAL_MODELS

parentPort.on('message', async (msg) => {
  if (msg?.type === 'symbol') {
    try {
      const result = await processSymbol(msg.symbol)
      parentPort.postMessage({ type: 'done', symbol: msg.symbol, result })
    } catch (error) {
      parentPort.postMessage({ type: 'done', symbol: msg.symbol, result: { symbol: msg.symbol, rows: 0, error: String(error?.stack || error) } })
    }
  } else if (msg?.type === 'shutdown') {
    process.exit(0)
  }
})
parentPort.postMessage({ type: 'ready' })
