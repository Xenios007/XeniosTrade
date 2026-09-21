import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAiTradingConfig } from '../src/lib/aiTrading.js'
import {
  AiExecutionError, assertCanExecute, buildAiTradeRecord, scalePlanToWallet, settlePaperTrade, summarizeAiWallet,
} from '../server/ai-trading/execution.js'

const NOW = 1_800_000_000_000

function makeRun(overrides = {}) {
  return {
    id: 'ai-trading-BTCUSDT-1',
    symbol: 'BTCUSDT',
    startedAt: NOW - 60_000,
    finishedAt: NOW - 30_000,
    final: {
      action: 'LONG',
      approved: true,
      confidence: 72,
      reason: 'Clean breakout with supportive flow.',
      trade: {
        side: 'LONG', entryPrice: 100, stopLoss: 98, takeProfit: 104, stopLossPct: 2, takeProfitPct: 4, rewardRisk: 2,
        notionalUsdt: 500, marginUsdt: 100, leverage: 5, quantity: 5, maxLossUsdt: 10, riskPctOfEquity: 1,
      },
    },
    ...overrides,
  }
}

const config = (execution = {}) => normalizeAiTradingConfig({ execution })
const base = (over = {}) => ({
  run: makeRun(), mode: 'testnet', config: config(), trades: [], livePrice: 100.2, now: NOW, ...over,
})
const rejects = (input, pattern) => assert.throws(() => assertCanExecute(input), (error) => {
  assert.ok(error instanceof AiExecutionError, `expected AiExecutionError, got ${error}`)
  if (pattern) assert.match(error.message, pattern)
  return true
})

test('config: real arming needs real mode and an explicit true; switching to testnet disarms', () => {
  assert.equal(normalizeAiTradingConfig({}).execution.mode, 'testnet')
  assert.equal(normalizeAiTradingConfig({}).execution.realArmed, false)
  assert.equal(normalizeAiTradingConfig({ execution: { mode: 'real', realArmed: true } }).execution.realArmed, true)
  assert.equal(normalizeAiTradingConfig({ execution: { mode: 'testnet', realArmed: true } }).execution.realArmed, false)
  assert.equal(normalizeAiTradingConfig({ execution: { mode: 'real', realArmed: 'true' } }).execution.realArmed, false)
  assert.equal(normalizeAiTradingConfig({ execution: { mode: 'bogus' } }).execution.mode, 'testnet')
  assert.equal(normalizeAiTradingConfig({ execution: { realMaxMarginUsdt: 9999 } }).execution.realMaxMarginUsdt, 100)
})

test('config: real-money auto-execute is off by default and only survives while real mode is armed', () => {
  const auto = (execution) => normalizeAiTradingConfig({ execution }).execution.autoExecuteReal
  assert.equal(auto({}), false, 'off by default')
  assert.equal(auto({ mode: 'real', realArmed: true, autoExecuteReal: true }), true)
  assert.equal(auto({ mode: 'real', realArmed: true }), false, 'arming alone does not make anything automatic')
  assert.equal(auto({ mode: 'real', realArmed: false, autoExecuteReal: true }), false, 'disarming turns it off')
  assert.equal(auto({ mode: 'testnet', realArmed: true, autoExecuteReal: true }), false, 'switching mode turns it off')
  assert.equal(auto({ mode: 'real', realArmed: true, autoExecuteReal: 'true' }), false, 'needs an explicit true')
})

test('an approved, fresh testnet run can be executed', () => {
  const { plan, side } = assertCanExecute(base())
  assert.equal(side, 'BUY')
  assert.equal(plan.entryPrice, 100)
  assert.equal(assertCanExecute(base({ run: makeRun({ final: { ...makeRun().final, action: 'SHORT', trade: { ...makeRun().final.trade, side: 'SHORT', stopLoss: 102, takeProfit: 96 } } }) })).side, 'SELL')
})

test('HOLD, unapproved or malformed plans are refused', () => {
  rejects(base({ run: makeRun({ final: { action: 'HOLD', approved: false, trade: null } }) }), /approved/)
  rejects(base({ run: makeRun({ final: { ...makeRun().final, approved: false } }) }), /approved/)
  rejects(base({ run: makeRun({ final: { ...makeRun().final, trade: { ...makeRun().final.trade, stopLoss: 101 } } }) }), /wrong side/)
  rejects(base({ run: makeRun({ final: { ...makeRun().final, trade: { ...makeRun().final.trade, quantity: 0 } } }) }), /incomplete/)
  rejects(base({ run: makeRun({ final: { ...makeRun().final, trade: { ...makeRun().final.trade, side: 'SHORT' } } }) }), /does not match/)
  rejects(base({ run: null }), /not found/)
})

test('a run is only executed once, and not on top of an open position in the same symbol', () => {
  rejects(base({ trades: [{ aiRunId: 'ai-trading-BTCUSDT-1', status: 'CLOSED_TP' }] }), /already been executed/)
  rejects(base({ trades: [{ aiRunId: 'other', status: 'OPEN', symbol: 'BTCUSDT', aiTradingMode: 'testnet' }] }), /already an open/)
  // a closed trade or another mode's trade does not block
  assertCanExecute(base({ trades: [{ aiRunId: 'o1', status: 'CLOSED_SL', symbol: 'BTCUSDT', aiTradingMode: 'testnet' }, { aiRunId: 'o2', status: 'OPEN', symbol: 'BTCUSDT', aiTradingMode: 'real' }] }))
})

test('stale plans and price drift are refused', () => {
  rejects(base({ now: NOW + 31 * 60_000 }), /min old/)
  rejects(base({ livePrice: 102 }), /moved/)
  rejects(base({ livePrice: 0 }), /live price/)
  rejects(base({ livePrice: 98.5, run: makeRun({ final: { ...makeRun().final, trade: { ...makeRun().final.trade, stopLoss: 98.6 } } }) }), /beyond/)
})

test('real money: needs real mode, the arm switch, a fresh plan, and the typed symbol unless auto-execute is on', () => {
  const armed = config({ mode: 'real', realArmed: true })
  const real = (over = {}) => base({ mode: 'real', config: armed, confirm: 'BTCUSDT', ...over })

  assertCanExecute(real())
  assertCanExecute(real({ confirm: ' btcusdt ' }))
  rejects(real({ config: config({ mode: 'real', realArmed: false }) }), /not armed/)
  rejects(real({ config: config({ mode: 'testnet' }) }), /not real|mode/)
  rejects(base({ mode: 'real', config: config() }), /mode/)
  rejects(real({ confirm: '' }), /Type BTCUSDT/)
  rejects(real({ confirm: 'ETHUSDT' }), /Type BTCUSDT/)
  rejects(real({ now: NOW + 11 * 60_000 }), /min old/)
  rejects(real({ livePrice: 100.6 }), /moved/) // 0.6% > the 0.5% real-money limit that testnet (1.5%) would accept
  assertCanExecute(base({ livePrice: 100.6 }))
})

test('real money auto-execute: needs the switch AND being armed; then no typed symbol, but every other check still applies', () => {
  const armedAuto = config({ mode: 'real', realArmed: true, autoExecuteReal: true })
  const auto = (over = {}) => base({ mode: 'real', config: armedAuto, auto: true, confirm: '', ...over })

  assertCanExecute(auto()) // no confirm typed
  rejects(auto({ config: config({ mode: 'real', realArmed: true }) }), /auto-execute is off/)
  rejects(auto({ config: config({ mode: 'real', realArmed: false, autoExecuteReal: true }) }), /not armed/)
  // the safety checks are the same as a manual real trade
  rejects(auto({ now: NOW + 11 * 60_000 }), /min old/)
  rejects(auto({ livePrice: 100.6 }), /moved/)
  rejects(auto({ livePrice: 0 }), /live price/)
  rejects(auto({ trades: [{ aiRunId: 'x', status: 'OPEN', symbol: 'ETHUSDT', aiTradingMode: 'real' }] }), /limited to 1/)
  rejects(auto({ trades: [{ aiRunId: 'ai-trading-BTCUSDT-1', status: 'CLOSED_TP' }] }), /already been executed/)
  // a manual real execute still needs the typed symbol even when auto-execute is on
  rejects(base({ mode: 'real', config: armedAuto, confirm: '' }), /Type BTCUSDT/)
})

test('real money is limited to one open AI position; testnet to five', () => {
  const armed = config({ mode: 'real', realArmed: true })
  rejects(base({ mode: 'real', config: armed, confirm: 'BTCUSDT', trades: [{ aiRunId: 'x', status: 'OPEN', symbol: 'ETHUSDT', aiTradingMode: 'real' }] }), /limited to 1/)
  const five = Array.from({ length: 5 }, (_, index) => ({ aiRunId: `r${index}`, status: 'OPEN', symbol: `S${index}USDT`, aiTradingMode: 'testnet' }))
  rejects(base({ trades: five }), /limited to 5/)
})

test('scalePlanToWallet caps real margin and never scales up', () => {
  const plan = makeRun().final.trade
  const real = scalePlanToWallet({ plan, mode: 'real', config: config({ realMaxMarginUsdt: 5 }), availableUsdt: 10.25 })
  assert.equal(real.margin, 5)
  assert.equal(real.notional, 25)
  assert.equal(real.maxLoss, 0.5)
  assert.equal(real.scale, 0.05)
  assert.match(real.notes[0], /scaled/)

  const tight = scalePlanToWallet({ plan, mode: 'real', config: config({ realMaxMarginUsdt: 50 }), availableUsdt: 10 })
  assert.equal(tight.margin, 9) // 90% of the available balance beats the 50 USDT cap

  const roomy = scalePlanToWallet({ plan, mode: 'testnet', config: config(), availableUsdt: 10_000 })
  assert.equal(roomy.scale, 1)
  assert.equal(roomy.margin, 100)
  assert.deepEqual(roomy.notes, [])

  assert.throws(() => scalePlanToWallet({ plan, mode: 'real', config: config(), availableUsdt: 0 }), AiExecutionError)
})

test('buildAiTradeRecord matches the bot trade shape and tags the AI wallet', () => {
  const run = makeRun()
  const plan = run.final.trade
  const scaled = scalePlanToWallet({ plan, mode: 'testnet', config: config(), availableUsdt: 1000 })
  const trade = buildAiTradeRecord({
    run, plan, mode: 'testnet', scaled, marginMode: 'ISOLATED', leverage: 5, now: NOW, dateKey: '2027-01-15',
    execution: { mode: 'local-paper', validationStatus: 'SIMULATED', quantity: 5, entryPrice: 100, notional: 500 },
  })
  assert.equal(trade.id, 'ai-ai-trading-BTCUSDT-1')
  assert.equal(trade.side, 'BUY')
  assert.equal(trade.status, 'OPEN')
  assert.equal(trade.walletId, 'wallet-ai-testnet')
  assert.equal(trade.aiTradingMode, 'testnet')
  assert.equal(trade.source, 'AI_TRADING')
  assert.equal(trade.journalDateKey, '2027-01-15')
  assert.equal(trade.stopLoss, 98)
})

test('local paper trades settle at the stop or target, never before', () => {
  const long = { status: 'OPEN', side: 'BUY', stopLoss: 98, takeProfit: 104 }
  assert.equal(settlePaperTrade(long, 100), null)
  assert.deepEqual(settlePaperTrade(long, 97.5), { exitPrice: 98, status: 'CLOSED_SL', result: 'SL' })
  assert.deepEqual(settlePaperTrade(long, 105), { exitPrice: 104, status: 'CLOSED_TP', result: 'TP' })
  const short = { status: 'OPEN', side: 'SELL', stopLoss: 102, takeProfit: 96 }
  assert.deepEqual(settlePaperTrade(short, 102.4), { exitPrice: 102, status: 'CLOSED_SL', result: 'SL' })
  assert.deepEqual(settlePaperTrade(short, 95), { exitPrice: 96, status: 'CLOSED_TP', result: 'TP' })
  assert.equal(settlePaperTrade({ ...long, status: 'CLOSED_SL' }, 90), null)
  assert.equal(settlePaperTrade(long, NaN), null)
})

test('wallet summaries: testnet uses the configured start; real derives its baseline from the exchange', () => {
  const trades = [
    { aiTradingMode: 'testnet', status: 'CLOSED_TP', pnl: 20, margin: 100, notional: 500 },
    { aiTradingMode: 'testnet', status: 'CLOSED_SL', pnl: -10, margin: 100, notional: 500 },
    { aiTradingMode: 'real', status: 'CLOSED_TP', pnl: 0.5, margin: 5, notional: 25 },
  ]
  const testnet = summarizeAiWallet({ mode: 'testnet', trades, config: config({ testnetStartingBalance: 1000 }) })
  assert.equal(testnet.startingBalance, 1000)
  assert.equal(testnet.ledger.realizedPnl, 10)
  assert.equal(testnet.ledger.runningBalance, 1010)
  assert.equal(testnet.ledger.wins, 1)
  assert.equal(testnet.ledger.losses, 1)

  const real = summarizeAiWallet({ mode: 'real', trades, config: config(), exchange: { walletBalance: 10.75 } })
  assert.equal(real.startingBalance, 10.25)
  assert.equal(real.ledger.runningBalance, 10.75)
  assert.equal(summarizeAiWallet({ mode: 'real', trades: [], config: config(), exchange: null }).startingBalance, 0)
})

// ---- Daily limits at the executor -------------------------------------------------------------------------------------------

test('daily limits: an automatic real entry is refused once a limit is reached; manual execution and testnet are not', async () => {
  const { manilaDay } = await import('../server/ai-trading/daily-limits.js')
  const today = manilaDay(NOW)
  const wins = [
    { symbol: 'ETHUSDT', aiTradingMode: 'real', status: 'CLOSED_TP', pnl: 2.16, notional: 360, closedDateKey: today, tradeDateKey: today },
    { symbol: 'SOLUSDT', aiTradingMode: 'real', status: 'CLOSED_TP', pnl: 2.16, notional: 360, closedDateKey: today, tradeDateKey: today },
  ]
  const limited = config({ mode: 'real', realArmed: true, autoExecuteReal: true, dailyProfitTargetUsdt: 2 })
  const auto = (over = {}) => base({ mode: 'real', config: limited, auto: true, confirm: '', trades: wins, ...over })

  rejects(auto(), /Daily profit target reached/)
  // the same trades with no target set: allowed
  assertCanExecute(auto({ config: config({ mode: 'real', realArmed: true, autoExecuteReal: true }) }))
  // loss stop
  const losses = wins.map((trade) => ({ ...trade, status: 'CLOSED_SL', pnl: -1.44 }))
  rejects(
    auto({ trades: losses, config: config({ mode: 'real', realArmed: true, autoExecuteReal: true, dailyMaxLossUsdt: 3.6 }) }),
    /Daily loss limit reached/,
  )
  // manual real execution (typed symbol) is the operator's call and is not limited
  assertCanExecute(base({ mode: 'real', config: limited, confirm: 'BTCUSDT', trades: wins }))
  // testnet auto-execution is never limited
  assertCanExecute(base({ config: config({ autoExecuteTestnet: true, dailyProfitTargetUsdt: 2 }), auto: true, trades: wins.map((trade) => ({ ...trade, aiTradingMode: 'testnet' })) }))
})
