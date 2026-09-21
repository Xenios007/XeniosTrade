import test from 'node:test'
import assert from 'node:assert/strict'
import { dailyStatus, manilaDay, tradeNetPnl } from '../server/ai-trading/daily-limits.js'
import { planScanCycle } from '../server/ai-trading/scan.js'
import { normalizeAiTradingConfig } from '../src/lib/aiTrading.js'

// 2026-09-21 12:00 in Manila (UTC+8) is 04:00 UTC.
const NOW = Date.parse('2026-09-21T04:00:00Z')
const TODAY = '2026-09-21'
const YESTERDAY = '2026-09-20'

// A closed real AI trade: price P&L and notional as the trade record stores them.
const closed = (pnl, { notional = 360, day = TODAY, mode = 'real', symbol = 'ETHUSDT' } = {}) => ({
  symbol, aiTradingMode: mode, status: pnl >= 0 ? 'CLOSED_TP' : 'CLOSED_SL', pnl, notional, closedDateKey: day, tradeDateKey: day, closedAt: NOW - 60_000,
})
const open = (day = TODAY, mode = 'real') => ({ symbol: 'SOLUSDT', aiTradingMode: mode, status: 'OPEN', notional: 100, tradeDateKey: day, transactTime: NOW - 120_000 })
const limits = (over = {}) => ({ dailyProfitTargetUsdt: 2, dailyMaxLossUsdt: 3.6, dailyMaxTrades: 6, ...over })

test('manilaDay: the trading day rolls over at midnight Manila time (16:00 UTC)', () => {
  assert.equal(manilaDay(Date.parse('2026-09-20T15:59:59Z')), '2026-09-20')
  assert.equal(manilaDay(Date.parse('2026-09-20T16:00:00Z')), '2026-09-21')
})

test('tradeNetPnl: price P&L minus the estimated round-trip fee on the notional', () => {
  assert.ok(Math.abs(tradeNetPnl({ pnl: 2.16, notional: 360 }) - 1.8) < 1e-9)
  assert.ok(Math.abs(tradeNetPnl({ pnl: -1.44, notional: 360 }) - -1.8) < 1e-9)
  assert.equal(tradeNetPnl({ pnl: null, notional: 360 }), 0)
  assert.equal(tradeNetPnl({}), 0)
})

test('dailyStatus: realized result counts only today, only this mode, only closed trades', () => {
  const trades = [closed(2.16), closed(-1.44), closed(5, { day: YESTERDAY }), closed(9, { mode: 'testnet' }), open()]
  const status = dailyStatus({ trades, mode: 'real', now: NOW, execution: limits() })
  assert.equal(status.dateKey, TODAY)
  assert.equal(status.realizedUsdt, 0) // +1.80 and -1.80 after fees
  assert.equal(status.tradesClosed, 2)
  assert.equal(status.wins, 1)
  assert.equal(status.losses, 1)
  assert.equal(status.tradesOpened, 3, 'the two closed today plus the one open')
  assert.equal(status.blocked, null)
})

test('dailyStatus: the profit target locks new automatic trades once reached (after fees)', () => {
  const one = dailyStatus({ trades: [closed(2.16)], mode: 'real', now: NOW, execution: limits() })
  assert.equal(one.realizedUsdt, 1.8)
  assert.equal(one.blocked, null, '+1.80 is below the +2 target')
  const two = dailyStatus({ trades: [closed(2.16), closed(2.16)], mode: 'real', now: NOW, execution: limits() })
  assert.equal(two.realizedUsdt, 3.6)
  assert.equal(two.blocked.code, 'profit')
  assert.match(two.blocked.reason, /Daily profit target reached: \+3\.60 of \+2 USDT/)
  assert.match(two.blocked.reason, /until tomorrow \(Manila time\)/)
})

test('dailyStatus: the loss stop and the trade cap lock new automatic trades', () => {
  const lost = dailyStatus({ trades: [closed(-1.44), closed(-1.44)], mode: 'real', now: NOW, execution: limits() })
  assert.equal(lost.realizedUsdt, -3.6)
  assert.equal(lost.blocked.code, 'loss')
  assert.match(lost.blocked.reason, /Daily loss limit reached: -3\.60 USDT realized today \(limit -3\.6\)/)

  const busy = dailyStatus({ trades: Array.from({ length: 6 }, () => closed(0.5, { notional: 10 })), mode: 'real', now: NOW, execution: limits({ dailyProfitTargetUsdt: 0 }) })
  assert.equal(busy.blocked.code, 'trades')
  assert.match(busy.blocked.reason, /6 of 6 real-money trades opened today/)
  // an open trade counts toward the cap too
  const withOpen = dailyStatus({ trades: [...Array.from({ length: 5 }, () => closed(0.5, { notional: 10 })), open()], mode: 'real', now: NOW, execution: limits({ dailyProfitTargetUsdt: 0 }) })
  assert.equal(withOpen.blocked.code, 'trades')
})

test('dailyStatus: 0 = off, yesterday does not count, and testnet is never limited', () => {
  const winning = [closed(2.16), closed(2.16), closed(2.16)]
  assert.equal(dailyStatus({ trades: winning, mode: 'real', now: NOW, execution: limits({ dailyProfitTargetUsdt: 0 }) }).blocked, null)
  assert.equal(dailyStatus({ trades: [closed(-9, { day: YESTERDAY })], mode: 'real', now: NOW, execution: limits() }).blocked, null)
  const testnet = dailyStatus({ trades: [closed(50, { mode: 'testnet' })], mode: 'testnet', now: NOW, execution: limits() })
  assert.equal(testnet.realizedUsdt, 50 - 0.36)
  assert.equal(testnet.blocked, null)
  // the next Manila day starts fresh
  assert.equal(dailyStatus({ trades: winning, mode: 'real', now: NOW + 24 * 3_600_000, execution: limits() }).blocked, null)
})

test('config: the daily limits are normalized (0 = off, bounded, rounded)', () => {
  const read = (execution) => normalizeAiTradingConfig({ execution }).execution
  const defaults = read({})
  assert.deepEqual([defaults.dailyProfitTargetUsdt, defaults.dailyMaxLossUsdt, defaults.dailyMaxTrades], [0, 0, 0])
  const set = read({ dailyProfitTargetUsdt: 2, dailyMaxLossUsdt: '3.6', dailyMaxTrades: 6.4 })
  assert.deepEqual([set.dailyProfitTargetUsdt, set.dailyMaxLossUsdt, set.dailyMaxTrades], [2, 3.6, 6])
  const bad = read({ dailyProfitTargetUsdt: -5, dailyMaxLossUsdt: 'x', dailyMaxTrades: 999 })
  assert.deepEqual([bad.dailyProfitTargetUsdt, bad.dailyMaxLossUsdt, bad.dailyMaxTrades], [0, 0, 50])
})

test('planScanCycle: a daily limit skips every symbol with the reason, so no model calls are spent', () => {
  const status = dailyStatus({ trades: [closed(2.16), closed(2.16)], mode: 'real', now: NOW, execution: limits() })
  const plan = planScanCycle({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], trades: [], mode: 'real', now: NOW, dailyBlock: status.blocked })
  assert.deepEqual(plan.toRun, [])
  assert.equal(plan.skipped.length, 3)
  assert.match(plan.skipped[0].reason, /Daily profit target reached/)
  // without a block the same symbols run
  assert.deepEqual(planScanCycle({ symbols: ['BTCUSDT', 'ETHUSDT'], trades: [], mode: 'real', now: NOW }).toRun, ['BTCUSDT', 'ETHUSDT'])
})
