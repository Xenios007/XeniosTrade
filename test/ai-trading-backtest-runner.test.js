import test from 'node:test'
import assert from 'node:assert/strict'
import { checkExit, positionPnl, runAiTradingBacktest } from '../server/ai-trading/backtest-runner.js'
import { sliceClosedAsOf } from '../server/ai-trading/backtest-data.js'
import { normalizeAiTradingConfig } from '../src/lib/aiTrading.js'
import { synthCandles } from './_helpers.js'

const STEP_MS = 300_000 // 5 minutes, matching the scalp entry interval used throughout these tests

// ---- checkExit / positionPnl (pure helpers) --------------------------------------------------------------------------

test('checkExit: stop wins when a single candle crosses both stop and target (the conservative assumption)', () => {
  const long = { side: 'BUY', stopLoss: 98, takeProfit: 104 }
  assert.deepEqual(checkExit(long, { low: 97, high: 105 }), { exitPrice: 98, result: 'SL' })
  assert.deepEqual(checkExit(long, { low: 99, high: 105 }), { exitPrice: 104, result: 'TP' })
  assert.equal(checkExit(long, { low: 99, high: 103 }), null)

  const short = { side: 'SELL', stopLoss: 102, takeProfit: 96 }
  assert.deepEqual(checkExit(short, { low: 95, high: 103 }), { exitPrice: 102, result: 'SL' })
  assert.deepEqual(checkExit(short, { low: 95, high: 101 }), { exitPrice: 96, result: 'TP' })
})

test('positionPnl: sign follows side, scaled by notional', () => {
  assert.equal(positionPnl({ side: 'BUY', entryPrice: 100, notionalUsdt: 1000 }, 102), 20)
  assert.equal(positionPnl({ side: 'SELL', entryPrice: 100, notionalUsdt: 1000 }, 102), -20)
  assert.equal(positionPnl({ side: 'BUY', entryPrice: 0, notionalUsdt: 1000 }, 102), 0, 'no entry price: refuses to divide by zero')
})

// ---- runAiTradingBacktest --------------------------------------------------------------------------------------------

function makeSeries({ seed = 1, bars = 700 } = {}) {
  const entry = synthCandles(bars, { base: 100, trend: 0, noise: 0.3, seed, step: STEP_MS })
  const bias = synthCandles(bars, { base: 100, trend: 0, noise: 0.5, seed: seed + 100, step: STEP_MS * 12 })
  const higher = synthCandles(bars, { base: 100, trend: 0, noise: 0.4, seed: seed + 200, step: STEP_MS * 3 })
  return {
    atMs(nowMs) {
      return {
        entry: sliceClosedAsOf(entry, nowMs, 120),
        bias: sliceClosedAsOf(bias, nowMs, 120),
        higher: sliceClosedAsOf(higher, nowMs, 120),
        marketContext: { fundingRate: 0 },
      }
    },
  }
}

/**
 * Deterministic variant of makeSeries: mostly flat (small synthCandles noise so indicators behave normally),
 * except at specific step indices where the candle's low is forced deep below base - a guaranteed stop-out for
 * any LONG with a stop inside `crashPct`, regardless of the ATR floor (reviewRiskProposal only ever widens a
 * requested stop, never narrows one, so a requested 2% stop can only end up >= 2% - comfortably cleared by crashPct).
 */
function makeCrashSeries({ seed, bars = 700, crashAtSteps, crashPct = 0.08, firstStep = 0 }) {
  const entry = synthCandles(bars, { base: 100, trend: 0, noise: 0.05, seed, step: STEP_MS })
  const bias = synthCandles(bars, { base: 100, trend: 0, noise: 0.1, seed: seed + 100, step: STEP_MS * 12 })
  const higher = synthCandles(bars, { base: 100, trend: 0, noise: 0.08, seed: seed + 200, step: STEP_MS * 3 })
  for (const stepIndex of crashAtSteps) {
    // The candle that's newly closed as of simulated step N is index (firstStep + N - 1): the entry decision
    // at step 0 is made from history ending at index (firstStep - 1), and each later step's "just closed" bar
    // is one index higher than the step before it, not level with the step number itself.
    const candle = entry[firstStep + stepIndex - 1]
    if (candle) candle.low = candle.open * (1 - crashPct)
  }
  return {
    atMs(nowMs) {
      return {
        entry: sliceClosedAsOf(entry, nowMs, 120),
        bias: sliceClosedAsOf(bias, nowMs, 120),
        higher: sliceClosedAsOf(higher, nowMs, 120),
        marketContext: { fundingRate: 0 },
      }
    },
  }
}

const baseConfig = () => normalizeAiTradingConfig({ strategy: { lean: true } })

/** Scripted analyst/risk replies by call count per symbol, falling back to HOLD. `script[symbol]` is an array
 * consumed in order; each entry is `{ analyst, risk }` (risk omitted/null => Analyst HOLD, no Risk Manager call). */
function scriptedAgent(script) {
  const cursor = {}
  const calls = []
  return {
    calls,
    callAgent: async ({ systemPrompt, userPrompt }) => {
      // describeMarket always leads the prompt with "Symbol: <SYMBOL>", so matching against the known script
      // keys is simpler and just as reliable as parsing it out.
      const symbol = Object.keys(script).find((key) => userPrompt.includes(key))
      const isAnalyst = /You are the Market Analyst\./.test(systemPrompt)
      const steps = script[symbol] || []
      cursor[symbol] = cursor[symbol] || 0
      const step = steps[Math.min(cursor[symbol], steps.length - 1)] || {}
      if (isAnalyst) {
        cursor[symbol] += 1
        calls.push({ symbol, role: 'analyst' })
        return { json: step.analyst || { action: 'HOLD', confidence: 50, regime: 'CHOP', stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'No edge.' }, providerId: 'fingpt', model: 'test' }
      }
      calls.push({ symbol, role: 'risk' })
      return {
        json: step.risk || { decision: 'APPROVE', confidence: 80, stopLossPercent: step.analyst?.stopLossPercent ?? 1, takeProfitPercent: step.analyst?.takeProfitPercent ?? 2, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Sized within limits.' },
        providerId: 'fingpt',
        model: 'test',
      }
    },
  }
}

test('runAiTradingBacktest: an approved entry opens a position that later exits on a stop-loss candle', async () => {
  const firstStep = 600
  const startMs = firstStep * STEP_MS
  // Entry at step 0; step 1's candle has a deterministic crash forced into it, well past the 2% stop requested.
  const series = makeCrashSeries({ seed: 3, crashAtSteps: [1], firstStep })
  const script = {
    BTCUSDT: [{ analyst: { action: 'LONG', confidence: 70, regime: 'UP', stopLossPercent: 2, takeProfitPercent: 10, reasoning: 'r' } }],
  }
  const { callAgent, calls } = scriptedAgent(script)
  const trades = []
  const { trades: result } = await runAiTradingBacktest({
    // Window ends exactly at step 1 (the close), so there is no step 2 for the now-free symbol to re-enter on.
    symbols: ['BTCUSDT'], startMs, endMs: startMs + 1 * STEP_MS, stepMs: STEP_MS, config: baseConfig(), callAgent,
    seriesFor: () => series, onTrade: (trade) => trades.push(trade),
  })
  assert.ok(calls.some((call) => call.role === 'risk'), 'a directional Analyst call reaches the Risk Manager')
  assert.equal(result.length, 1)
  assert.equal(result[0].symbol, 'BTCUSDT')
  assert.equal(result[0].result, 'SL')
  assert.equal(result[0].side, 'BUY')
  assert.ok(result[0].pnl < 0, 'a stop-out is a loss')
  assert.deepEqual(trades, result, 'onTrade fired with the same record')
})

test('runAiTradingBacktest: a position still open when the window ends is closed at the last known price (END_OF_BACKTEST)', async () => {
  const series = makeSeries({ seed: 3 })
  const startMs = 600 * STEP_MS
  const endMs = startMs + 3 * STEP_MS
  const script = {
    BTCUSDT: [{ analyst: { action: 'LONG', confidence: 70, regime: 'UP', stopLossPercent: 50, takeProfitPercent: 50, reasoning: 'r' } }],
  }
  const { callAgent } = scriptedAgent(script)
  const { trades: result } = await runAiTradingBacktest({
    symbols: ['BTCUSDT'], startMs, endMs, stepMs: STEP_MS, config: baseConfig(), callAgent,
    seriesFor: () => series,
  })
  assert.equal(result.length, 1, 'a 50% stop/target from a short synthetic window never triggers, so it survives to the end')
  assert.equal(result[0].result, 'END_OF_BACKTEST')
})

test('runAiTradingBacktest: HOLD opens nothing; a position cap blocks a new entry past the limit', async () => {
  const seriesA = makeSeries({ seed: 11 })
  const script = { BTCUSDT: [{ analyst: { action: 'HOLD', confidence: 40, regime: 'CHOP', stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'No edge.' } }] }
  const { callAgent, calls } = scriptedAgent(script)
  const startMs = 600 * STEP_MS
  const { trades } = await runAiTradingBacktest({
    symbols: ['BTCUSDT'], startMs, endMs: startMs + STEP_MS, stepMs: STEP_MS, config: baseConfig(), callAgent,
    seriesFor: () => seriesA,
  })
  assert.equal(trades.length, 0)
  assert.ok(!calls.some((call) => call.role === 'risk'), 'Analyst HOLD never reaches the Risk Manager')
})

test('runAiTradingBacktest: the same-side cap blocks a 3rd concurrent same-direction entry, but not the opposite side', async () => {
  const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT']
  const series = Object.fromEntries(symbols.map((symbol, index) => [symbol, makeSeries({ seed: 20 + index })]))
  const script = Object.fromEntries(symbols.map((symbol) => [symbol, [{ analyst: { action: 'LONG', confidence: 70, regime: 'UP', stopLossPercent: 50, takeProfitPercent: 50, reasoning: 'r' } }]]))
  const { callAgent } = scriptedAgent(script)
  const startMs = 600 * STEP_MS
  const { trades } = await runAiTradingBacktest({
    symbols, startMs, endMs: startMs + STEP_MS, stepMs: STEP_MS, config: baseConfig(), callAgent,
    seriesFor: (symbol) => series[symbol],
  })
  // All three close at END_OF_BACKTEST regardless of whether they opened, so count OPENED positions via openedAt === startMs.
  const opened = trades.filter((trade) => trade.openedAt === startMs)
  assert.equal(opened.length, 2, 'only 2 of the 3 same-side (LONG) signals are allowed to open at once')
})

test('runAiTradingBacktest: the direction circuit breaker pauses a side after a losing streak, and stays off the other side', async () => {
  const firstStep = 600
  const startMs = firstStep * STEP_MS
  // directionCircuitBreaker needs a FULL 6-trade lookback before it will even render a verdict (see
  // ai-trading-scan.test.js), so this seeds 6 losses, not 5. Entries land on even steps (0,2,4,6,8,10), each
  // checked for exit on the following odd step, whose candle has a deterministic crash forced into it.
  // NEXTUSDT (same side) and SHORTUSDT (opposite side) only get a real directional call at step 12, after the
  // streak is fully seeded.
  const crashAtSteps = [1, 3, 5, 7, 9, 11]
  const series = {
    LOSERUSDT: makeCrashSeries({ seed: 40, crashAtSteps, firstStep }),
    NEXTUSDT: makeSeries({ seed: 42 }),
    SHORTUSDT: makeSeries({ seed: 43 }),
  }
  const loserEntrySteps = new Set([0, 2, 4, 6, 8, 10])
  const script = {
    LOSERUSDT: Array.from({ length: 6 }, () => ({ analyst: { action: 'LONG', confidence: 70, regime: 'UP', stopLossPercent: 2, takeProfitPercent: 10, reasoning: 'r' } })),
    NEXTUSDT: [...Array(12).fill(null), { analyst: { action: 'LONG', confidence: 70, regime: 'UP', stopLossPercent: 50, takeProfitPercent: 50, reasoning: 'r' } }],
    SHORTUSDT: [...Array(12).fill(null), { analyst: { action: 'SHORT', confidence: 70, regime: 'DOWN', stopLossPercent: 50, takeProfitPercent: 50, reasoning: 'r' } }],
  }
  const cursor = {}
  const callAgent = async ({ systemPrompt, userPrompt }) => {
    const symbol = Object.keys(script).find((key) => userPrompt.includes(key))
    const isAnalyst = /You are the Market Analyst\./.test(systemPrompt)
    cursor[symbol] = cursor[symbol] ?? 0
    const step = script[symbol][Math.min(cursor[symbol], script[symbol].length - 1)]
    if (isAnalyst) {
      cursor[symbol] += 1
      return { json: step?.analyst || { action: 'HOLD', confidence: 40, regime: 'CHOP', stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'r' }, providerId: 'fingpt', model: 'test' }
    }
    return { json: { decision: 'APPROVE', confidence: 80, stopLossPercent: step.analyst.stopLossPercent, takeProfitPercent: step.analyst.takeProfitPercent, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'r' }, providerId: 'fingpt', model: 'test' }
  }

  const { trades } = await runAiTradingBacktest({
    symbols: ['LOSERUSDT', 'NEXTUSDT', 'SHORTUSDT'], startMs, endMs: startMs + 12 * STEP_MS, stepMs: STEP_MS, config: baseConfig(), callAgent,
    seriesFor: (symbol) => series[symbol],
  })

  const loserLosses = trades.filter((trade) => trade.symbol === 'LOSERUSDT' && trade.result === 'SL')
  assert.equal(loserLosses.length, loserEntrySteps.size, `expected ${loserEntrySteps.size} deterministic stop-outs, got ${loserLosses.length}`)

  const nextOpened = trades.some((trade) => trade.symbol === 'NEXTUSDT' && trade.openedAt != null)
  const shortOpened = trades.some((trade) => trade.symbol === 'SHORTUSDT' && trade.openedAt != null)
  assert.equal(nextOpened, false, 'LONG is paused by the circuit breaker once the LOSERUSDT streak seeds 5/6 losses')
  assert.equal(shortOpened, true, 'SHORT is untouched by a LONG-side breaker')
})

test('runAiTradingBacktest: shouldStop halts the walk early, closing nothing beyond what already happened', async () => {
  const series = makeSeries({ seed: 50 })
  const script = { BTCUSDT: [{ analyst: { action: 'HOLD', confidence: 40, regime: 'CHOP', stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'r' } }] }
  const { callAgent } = scriptedAgent(script)
  const startMs = 600 * STEP_MS
  let steps = 0
  const { trades } = await runAiTradingBacktest({
    symbols: ['BTCUSDT'], startMs, endMs: startMs + 50 * STEP_MS, stepMs: STEP_MS, config: baseConfig(), callAgent,
    seriesFor: () => series,
    onProgress: () => { steps += 1 },
    shouldStop: () => steps >= 3,
  })
  assert.ok(steps <= 4, `expected the walk to stop promptly after shouldStop flips true, got ${steps} steps`)
  assert.equal(trades.length, 0)
})
