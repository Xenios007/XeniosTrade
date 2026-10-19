import test from 'node:test'
import assert from 'node:assert/strict'
import { runBotBacktest } from '../server/strategy/bot-backtest-runner.js'

const STEP_MS = 300_000 // 5 minutes

/** entryRows as raw Binance kline rows: [openTime, open, high, low, close, volume, closeTime, ...] */
function makeEntryRows(n, { base = 100 } = {}) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    const open = base
    const close = base
    rows.push([i * STEP_MS, open, base + 0.1, base - 0.1, close, 1000, (i + 1) * STEP_MS - 1])
  }
  return rows
}

function fakeSeries(entryRows) {
  return {
    entryRows,
    atIndex: () => ({ entryCandles: [{}, {}], setupCandles: Array.from({ length: 20 }), biasCandles: Array.from({ length: 20 }), marketContext: {} }),
  }
}

const SIGNAL = { entryPrice: 100, stopLoss: 98, takeProfit: 104, side: 'BUY', positionNotional: 1000, leverage: 5, confidence: 70 }

test('runBotBacktest: a valid signal that resolves via exit simulation produces a trade with correct pnl sign', async () => {
  const entryRows = makeEntryRows(300)
  const analyze = () => SIGNAL
  const simulateExit = ({ entryBarIndex, entryTfRaw }) => ({ price: 104, time: entryTfRaw[entryBarIndex + 1][6], status: 'CLOSED_TP' })
  const { trades } = await runBotBacktest({
    bots: ['model-1'], symbols: ['BTCUSDT'], seriesFor: () => fakeSeries(entryRows), analyze, simulateExit, warmupBars: 220,
  })
  assert.ok(trades.length > 0)
  assert.equal(trades[0].symbol, 'BTCUSDT')
  assert.equal(trades[0].signalModelId, 'model-1')
  assert.equal(trades[0].side, 'BUY')
  assert.equal(trades[0].result, 'TP')
  assert.ok(trades[0].pnl > 0, 'a LONG that exits above entry is a win')
})

test('runBotBacktest: no signal produces no trades; a signal missing required fields is skipped', async () => {
  const entryRows = makeEntryRows(260)
  const noSignal = await runBotBacktest({ bots: ['model-1'], symbols: ['BTCUSDT'], seriesFor: () => fakeSeries(entryRows), analyze: () => null, simulateExit: () => ({ price: 104, time: 0, status: 'CLOSED_TP' }), warmupBars: 220 })
  assert.equal(noSignal.trades.length, 0)

  const incomplete = await runBotBacktest({ bots: ['model-1'], symbols: ['BTCUSDT'], seriesFor: () => fakeSeries(entryRows), analyze: () => ({ entryPrice: 100 }), simulateExit: () => ({ price: 104, time: 0, status: 'CLOSED_TP' }), warmupBars: 220 })
  assert.equal(incomplete.trades.length, 0, 'missing stopLoss/takeProfit: not a usable signal')
})

test('runBotBacktest: simulateExit returning null (ran out of history) is skipped, not crashed', async () => {
  const entryRows = makeEntryRows(260)
  const { trades } = await runBotBacktest({
    bots: ['model-1'], symbols: ['BTCUSDT'], seriesFor: () => fakeSeries(entryRows), analyze: () => SIGNAL, simulateExit: () => null, warmupBars: 220,
  })
  assert.equal(trades.length, 0)
})

test('runBotBacktest: a bot stays "busy" until its simulated position closes, but a different bot on the same symbol is unaffected', async () => {
  const entryRows = makeEntryRows(400)
  let analyzeCalls = { 'model-1': 0, 'model-2': 0 }
  const analyze = ({ botId }) => { analyzeCalls[botId] += 1; return SIGNAL }
  // Exit 50 bars later, every time - model-1 should only get a handful of entries across 400 bars, not one per bar.
  const simulateExit = ({ entryBarIndex, entryTfRaw }) => {
    const exitIdx = Math.min(entryBarIndex + 50, entryTfRaw.length - 1)
    return { price: 104, time: entryTfRaw[exitIdx][6], status: 'CLOSED_TP' }
  }
  const { trades } = await runBotBacktest({ bots: ['model-1', 'model-2'], symbols: ['BTCUSDT'], seriesFor: () => fakeSeries(entryRows), analyze, simulateExit, warmupBars: 220 })
  const model1Trades = trades.filter((t) => t.signalModelId === 'model-1')
  const model2Trades = trades.filter((t) => t.signalModelId === 'model-2')
  assert.ok(model1Trades.length >= 2 && model1Trades.length < 10, `expected a handful of model-1 trades (busy-gated), got ${model1Trades.length}`)
  assert.equal(model1Trades.length, model2Trades.length, 'both bots see the same opportunities independently')
})

test('runBotBacktest: processes symbols independently, and shouldStop halts the walk', async () => {
  const entryRows = makeEntryRows(260)
  const series = { AAAUSDT: fakeSeries(entryRows), BBBUSDT: fakeSeries(entryRows) }
  const simulateExit = ({ entryBarIndex, entryTfRaw }) => ({ price: 104, time: entryTfRaw[Math.min(entryBarIndex + 5, entryTfRaw.length - 1)][6], status: 'CLOSED_TP' })
  const both = await runBotBacktest({ bots: ['model-1'], symbols: ['AAAUSDT', 'BBBUSDT'], seriesFor: (symbol) => series[symbol], analyze: () => SIGNAL, simulateExit, warmupBars: 220 })
  const symbolsSeen = new Set(both.trades.map((t) => t.symbol))
  assert.deepEqual([...symbolsSeen].sort(), ['AAAUSDT', 'BBBUSDT'])

  const stopped = await runBotBacktest({
    bots: ['model-1'], symbols: ['AAAUSDT', 'BBBUSDT'], seriesFor: (symbol) => series[symbol], analyze: () => SIGNAL, simulateExit, warmupBars: 220,
    shouldStop: () => true,
  })
  assert.equal(stopped.trades.length, 0, 'stops before even the first symbol starts')
})
