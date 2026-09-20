import assert from 'node:assert/strict'
import test from 'node:test'
import { AI_SCAN_COOLDOWN_MS, DEFAULT_AI_TRADING_CONFIG, normalizeAiTradingConfig } from '../src/lib/aiTrading.js'
import { planScanCycle, shouldPersistScanRun, summarizeScanResult } from '../server/ai-trading/scan.js'

const NOW = 1_800_000_000_000
const open = (symbol, mode = 'testnet') => ({ symbol, aiTradingMode: mode, status: 'OPEN', result: 'PENDING' })
const closed = (symbol, ago) => ({ symbol, aiTradingMode: 'testnet', status: 'CLOSED', result: 'WIN', closedAt: NOW - ago })

test('scan config: off by default, needs an explicit true, symbols are filtered and never empty', () => {
  assert.equal(DEFAULT_AI_TRADING_CONFIG.scan.enabled, false)
  assert.equal(normalizeAiTradingConfig({ scan: { enabled: 'true' } }).scan.enabled, false)
  assert.equal(normalizeAiTradingConfig({ scan: { enabled: 1 } }).scan.enabled, false)
  assert.equal(normalizeAiTradingConfig({ scan: { enabled: true } }).scan.enabled, true)
  assert.deepEqual(normalizeAiTradingConfig({ scan: { symbols: ['ETHUSDT', 'NOTACOINUSDT', 'x'] } }).scan.symbols, ['ETHUSDT'])
  assert.deepEqual(normalizeAiTradingConfig({ scan: { symbols: [] } }).scan.symbols, DEFAULT_AI_TRADING_CONFIG.scan.symbols)
})

test('planScanCycle: scans free symbols, skips open positions, cooldowns and in-flight runs', () => {
  const plan = planScanCycle({
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    trades: [open('BTCUSDT'), closed('ETHUSDT', 5 * 60_000), closed('BNBUSDT', AI_SCAN_COOLDOWN_MS + 60_000)],
    inFlight: new Set(['SOLUSDT']),
    now: NOW,
  })
  assert.deepEqual(plan.toRun, ['BNBUSDT'], 'an old close is out of cooldown')
  const reasons = Object.fromEntries(plan.skipped.map((item) => [item.symbol, item.reason]))
  assert.match(reasons.BTCUSDT, /open AI position/)
  assert.match(reasons.ETHUSDT, /cooldown/)
  assert.match(reasons.SOLUSDT, /in progress/)
})

test('planScanCycle: a full wallet skips everything, and real-mode positions do not count against testnet', () => {
  const full = planScanCycle({ symbols: ['SOLUSDT'], trades: ['A', 'B', 'C', 'D', 'E'].map((name) => open(`${name}USDT`)), now: NOW })
  assert.deepEqual(full.toRun, [])
  assert.match(full.skipped[0].reason, /position limit/)

  const realOnly = planScanCycle({ symbols: ['SOLUSDT'], trades: [open('BTCUSDT', 'real')], mode: 'testnet', now: NOW })
  assert.deepEqual(realOnly.toRun, ['SOLUSDT'])
  const realFull = planScanCycle({ symbols: ['SOLUSDT'], trades: [open('BTCUSDT', 'real')], mode: 'real', now: NOW })
  assert.deepEqual(realFull.toRun, [], 'real mode allows one open position')
})

const stage = (id, extra) => ({ id, ...extra })

test('summarizeScanResult + shouldPersistScanRun: HOLD and errors stay out of run history, decisions go in', () => {
  const analystHold = { id: 'r1', stages: [stage('analyst', { status: 'ok', output: { action: 'HOLD' } })], final: { action: 'HOLD', approved: false, reason: 'Range-bound.' } }
  assert.equal(summarizeScanResult(analystHold).outcome, 'hold')
  assert.equal(shouldPersistScanRun(analystHold), false)

  const analystError = { id: 'r2', stages: [stage('analyst', { status: 'error', error: 'Request timed out after 45s.' })], final: { action: 'HOLD', approved: false, reason: 'Market Analyst failed' } }
  assert.equal(summarizeScanResult(analystError).outcome, 'error')
  assert.match(summarizeScanResult(analystError).detail, /timed out/)
  assert.equal(shouldPersistScanRun(analystError), false)

  const vetoed = { id: 'r3', stages: [stage('analyst', { status: 'ok', output: { action: 'LONG' } })], final: { action: 'HOLD', approved: false, reason: 'Critic rejected.' } }
  assert.equal(summarizeScanResult(vetoed).outcome, 'hold')
  assert.equal(shouldPersistScanRun(vetoed), true, 'a directional call that a later gate blocked is worth keeping')

  const opened = { id: 'r4', stages: [stage('analyst', { status: 'ok', output: { action: 'SHORT' } })], final: { action: 'SHORT', approved: true }, execution: { status: 'opened', mode: 'testnet' } }
  assert.equal(summarizeScanResult(opened).outcome, 'opened')
  assert.equal(shouldPersistScanRun(opened), true)

  const failedOpen = { ...opened, execution: { status: 'failed', mode: 'testnet', error: 'Insufficient margin' } }
  assert.equal(summarizeScanResult(failedOpen).outcome, 'error')
})
