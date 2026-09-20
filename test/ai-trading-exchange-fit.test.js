import test from 'node:test'
import assert from 'node:assert/strict'
import { fitPlanToExchangeMinimum, marginCapFor, minOrderNotional } from '../server/ai-trading/exchange-fit.js'

// ETHUSDT futures rules at ~2,625: min notional 20, lot step / min qty 0.001.
const ETH = { minNotional: 20, minQty: 0.001, stepSize: 0.001, price: 2625 }

test('marginCapFor: 90% of available, and on real money also the configured cap', () => {
  assert.equal(marginCapFor({ mode: 'testnet', availableUsdt: 1000, realMaxMarginUsdt: 5 }), 900)
  assert.equal(marginCapFor({ mode: 'real', availableUsdt: 40, realMaxMarginUsdt: 9.99 }), 9.99)
  assert.equal(marginCapFor({ mode: 'real', availableUsdt: 40, realMaxMarginUsdt: 100 }), 36)
  assert.equal(marginCapFor({ mode: 'real', availableUsdt: 0, realMaxMarginUsdt: 9.99 }), 0)
  assert.equal(marginCapFor({ mode: 'real', availableUsdt: 'x', realMaxMarginUsdt: 9.99 }), 0)
})

test('minOrderNotional: whole lot steps at or above the notional filter (and minQty)', () => {
  // 20 / 2625 = 0.00762 ETH -> 8 steps of 0.001 = 0.008 ETH = 21 USDT
  assert.ok(Math.abs(minOrderNotional(ETH) - 21) < 1e-9)
  // a large minQty wins over the notional filter
  assert.ok(Math.abs(minOrderNotional({ minNotional: 5, minQty: 0.001, stepSize: 0.001, price: 81207.4 }) - 81.2074) < 1e-6)
  assert.equal(minOrderNotional({ ...ETH, price: 0 }), 0)
  assert.equal(minOrderNotional({ ...ETH, price: undefined }), 0)
})

test('fit: the ETH case (9.99 margin cap, 1x plan) is raised to 3x instead of failing', () => {
  const fit = fitPlanToExchangeMinimum({ planNotional: 1000, planLeverage: 1, marginCap: 9.99, minOrderUsdt: minOrderNotional(ETH), maxLeverage: 5, stopLossPct: 1 })
  assert.equal(fit.ok, true)
  assert.equal(fit.changed, true)
  assert.equal(fit.leverage, 3)
  assert.ok(fit.notional >= 21 && fit.notional <= 22, `notional ${fit.notional}`)
  assert.ok(fit.margin <= 9.99, 'never more margin than the cap')
  assert.ok(Math.abs(fit.margin * fit.leverage - fit.notional) < 1e-9)
})

test('fit: nothing changes when the position already clears the minimum, or the minimum is unknown', () => {
  const clear = fitPlanToExchangeMinimum({ planNotional: 1000, planLeverage: 3, marginCap: 40, minOrderUsdt: 21, maxLeverage: 5, stopLossPct: 1 })
  assert.equal(clear.changed, false)
  assert.equal(clear.ok, true)
  assert.equal(clear.leverage, 3)
  assert.equal(clear.notional, 120)
  for (const minOrderUsdt of [0, undefined, NaN]) {
    const unknown = fitPlanToExchangeMinimum({ planNotional: 1000, planLeverage: 2, marginCap: 9.99, minOrderUsdt, maxLeverage: 5, stopLossPct: 1 })
    assert.equal(unknown.changed, false)
    assert.equal(unknown.ok, true)
  }
})

test('fit: refuses, with the reason, when the ceiling, the plan size, the margin or the stop make it unsafe', () => {
  // BTC-sized minimum: ~83 USDT needs 9x on a 9.99 cap, above the 5x ceiling
  const ceiling = fitPlanToExchangeMinimum({ planNotional: 5000, planLeverage: 1, marginCap: 9.99, minOrderUsdt: 81.21, maxLeverage: 5, stopLossPct: 1 })
  assert.equal(ceiling.ok, false)
  assert.match(ceiling.reason, /needs 9x leverage, above the 5x ceiling/)

  // never sized above what the Risk Manager planned
  const small = fitPlanToExchangeMinimum({ planNotional: 12, planLeverage: 1, marginCap: 9.99, minOrderUsdt: 21, maxLeverage: 5, stopLossPct: 1 })
  assert.equal(small.ok, false)
  assert.match(small.reason, /smaller than the exchange minimum/)

  const noMargin = fitPlanToExchangeMinimum({ planNotional: 1000, planLeverage: 1, marginCap: 0, minOrderUsdt: 21, maxLeverage: 5, stopLossPct: 1 })
  assert.equal(noMargin.ok, false)
  assert.match(noMargin.reason, /No margin/)

  // 9x needs a liquidation distance of ~10%; an 11% stop is not safely inside it
  const liq = fitPlanToExchangeMinimum({ planNotional: 5000, planLeverage: 1, marginCap: 2.5, minOrderUsdt: 21, maxLeverage: 10, stopLossPct: 11 })
  assert.equal(liq.ok, false)
  assert.match(liq.reason, /liquidation distance/)
})

test('fit: leverage never goes below the plan own leverage and never above the ceiling', () => {
  const kept = fitPlanToExchangeMinimum({ planNotional: 1000, planLeverage: 4, marginCap: 5.1, minOrderUsdt: 21, maxLeverage: 5, stopLossPct: 1 })
  assert.equal(kept.ok, true)
  assert.ok(kept.leverage >= 4 && kept.leverage <= 5)
})
