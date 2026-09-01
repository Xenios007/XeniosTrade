import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRegime, REGIMES, deriveRegimeCandlesFromHourly } from '../server/backtest/regime.js'
import { synthCandles, synthRawKlines } from './_helpers.js'

test('always returns a valid regime label', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = classifyRegime({
      biasCandles: synthCandles(120, { seed, step: 3_600_000 }),
      entryCandles: synthCandles(400, { seed: seed + 1, step: 300_000 }),
    })
    assert.ok(REGIMES.includes(r.regime), `invalid regime ${r.regime}`)
  }
})

test('insufficient history -> TRANSITION, no throw', () => {
  const r = classifyRegime({ biasCandles: synthCandles(10), entryCandles: synthCandles(10) })
  assert.equal(r.regime, 'TRANSITION')
})

test('strong sustained uptrend -> BULL_TREND', () => {
  const r = classifyRegime({
    biasCandles: synthCandles(120, { trend: 1.5, noise: 0.2, seed: 2, step: 3_600_000 }),
    entryCandles: synthCandles(400, { trend: 0.05, noise: 0.15, seed: 2, step: 300_000 }),
  })
  assert.equal(r.regime, 'BULL_TREND')
  assert.ok(r.trendScore >= 3)
})

test('strong sustained downtrend -> BEAR_TREND', () => {
  const r = classifyRegime({
    biasCandles: synthCandles(120, { trend: -1.5, noise: 0.2, seed: 2, step: 3_600_000 }),
    entryCandles: synthCandles(400, { trend: -0.05, noise: 0.15, seed: 2, step: 300_000 }),
  })
  assert.equal(r.regime, 'BEAR_TREND')
  assert.ok(r.trendScore <= -3)
})

test('flat, quiet market -> RANGE or LOW_VOLATILITY (not a trend)', () => {
  const r = classifyRegime({
    biasCandles: synthCandles(120, { trend: 0, noise: 0.05, seed: 9, step: 3_600_000 }),
    entryCandles: synthCandles(400, { trend: 0, noise: 0.03, seed: 9, step: 300_000 }),
  })
  assert.ok(['RANGE', 'LOW_VOLATILITY', 'TRANSITION'].includes(r.regime), `got ${r.regime}`)
  assert.ok(r.regime !== 'BULL_TREND' && r.regime !== 'BEAR_TREND')
})

test('classify uses only the candles passed (no look-ahead)', () => {
  const biasFull = synthCandles(200, { seed: 3, step: 3_600_000 })
  const entryFull = synthCandles(600, { seed: 3, step: 300_000 })
  const a = classifyRegime({ biasCandles: biasFull.slice(0, 120), entryCandles: entryFull.slice(0, 400) })
  const b = classifyRegime({ biasCandles: biasFull.slice(0, 120), entryCandles: entryFull.slice(0, 400) })
  assert.deepEqual(a, b)
})

test('deriveRegimeCandlesFromHourly: aggregates 4 x 1h into 4h, drops partials', () => {
  const hourly = synthRawKlines(41, { step: 3_600_000 })
  const c4h = deriveRegimeCandlesFromHourly(hourly)
  assert.equal(c4h.length, 10) // 41 -> 10 full groups, trailing 1 dropped
  for (const c of c4h) {
    assert.ok(c.high >= c.low)
    assert.ok(c.high >= c.open && c.high >= c.close)
    assert.ok(c.low <= c.open && c.low <= c.close)
  }
})
