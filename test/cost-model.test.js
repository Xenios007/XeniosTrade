import test from 'node:test'
import assert from 'node:assert/strict'
import { rescoreTrade, aggregateUnderRegime, COST_REGIMES } from '../server/backtest/cost-model.js'

const winRow = {
  side: 'BUY', entryPrice: 100, exitPrice: 101.5, notional: 500,
  stopLoss: 99.4, grossPnl: 7.5, configuredStopLossPercent: 0.6,
}
const lossRow = {
  side: 'SELL', entryPrice: 100, exitPrice: 100.8, notional: 500,
  stopLoss: 100.6, grossPnl: -4, configuredStopLossPercent: 0.6,
}

test('COST_REGIMES has the three brief-specified tiers', () => {
  assert.deepEqual(COST_REGIMES.NORMAL, { feeBps: 5, slippageBps: 2 })
  assert.deepEqual(COST_REGIMES.STRESS, { feeBps: 5, slippageBps: 5 })
  assert.deepEqual(COST_REGIMES.HIGH_STRESS, { feeBps: 7, slippageBps: 10 })
})

test('net pnl strictly decreases as friction rises', () => {
  const n = rescoreTrade(winRow, COST_REGIMES.NORMAL).netPnl
  const s = rescoreTrade(winRow, COST_REGIMES.STRESS).netPnl
  const h = rescoreTrade(winRow, COST_REGIMES.HIGH_STRESS).netPnl
  assert.ok(n > s, `${n} !> ${s}`)
  assert.ok(s > h, `${s} !> ${h}`)
})

test('R sign matches net pnl sign', () => {
  const w = rescoreTrade(winRow, COST_REGIMES.NORMAL)
  const l = rescoreTrade(lossRow, COST_REGIMES.NORMAL)
  assert.ok(w.netPnl > 0 && w.R > 0)
  assert.ok(l.netPnl < 0 && l.R < 0)
})

test('R uses the stop distance as the risk unit', () => {
  // risk = |100-99.4|/100 * 500 = 3 USDT ; netPnl NORMAL = 7.5 - 0.5 - 0.2 = 6.8
  const r = rescoreTrade(winRow, COST_REGIMES.NORMAL)
  assert.equal(r.feeCost, 0.5)
  assert.equal(r.slippageCost, 0.2)
  assert.equal(r.netPnl, 6.8)
  assert.equal(r.R, Number((6.8 / 3).toFixed(4)))
})

test('rescore reconstructs from grossPnl, not stored net pnl', () => {
  const withGross = rescoreTrade(winRow, COST_REGIMES.NORMAL)
  const noGross = rescoreTrade({ ...winRow, grossPnl: undefined, pnl: 6.8, frictionUsd: 0.7 }, COST_REGIMES.NORMAL)
  assert.equal(withGross.netPnl, noGross.netPnl)
})

test('aggregateUnderRegime: profit factor and expectancy math', () => {
  const rows = [winRow, winRow, lossRow]
  const agg = aggregateUnderRegime(rows, COST_REGIMES.NORMAL)
  assert.equal(agg.trades, 3)
  assert.equal(agg.wins, 2)
  assert.ok(agg.profitFactor > 1)
  assert.equal(agg.expectancy, Number((agg.netPnl / 3).toFixed(4)))
  assert.ok(agg.feeCost > 0 && agg.slippageCost > 0)
})

test('HIGH_STRESS can flip a marginal winner to a loser', () => {
  const marginal = { ...winRow, grossPnl: 0.9 } // barely covers NORMAL friction
  assert.ok(rescoreTrade(marginal, COST_REGIMES.NORMAL).netPnl > 0)
  assert.ok(rescoreTrade(marginal, COST_REGIMES.HIGH_STRESS).netPnl < 0)
})
