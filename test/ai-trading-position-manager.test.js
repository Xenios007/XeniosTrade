import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_STORED_REVIEWS, applyPartialClose, buildEntryContext, computeTradeMetrics, parsePositionManagerOutput, planPositionAction, positionManagerPrompts, recordReview,
} from '../server/ai-trading/position-manager.js'
import { buildAiTradeRecord, settlePaperTrade } from '../server/ai-trading/execution.js'
import { buildMarketSnapshot } from '../server/ai-trading/pipeline.js'
import { AI_POSITION_MANAGER_DECISIONS, AI_TRADING_AGENTS, AI_TRADING_ENTRY_STAGE_IDS } from '../src/lib/aiTrading.js'
import { synthCandles } from './_helpers.js'

const T0 = 1_700_000_000_000

const longTrade = (extra = {}) => ({
  id: 'ai-1', symbol: 'XRPUSDT', side: 'BUY', status: 'OPEN', aiTradingMode: 'testnet', mode: 'binance-futures-testnet',
  entryPrice: 100, quantity: 10, notional: 1000, margin: 200, leverage: 5, marginMode: 'ISOLATED', maxLossPerTrade: 30,
  stopLoss: 97, takeProfit: 106, initialStopLoss: 97, initialTakeProfit: 106, initialQuantity: 10, transactTime: T0, ...extra,
})
const shortTrade = (extra = {}) => longTrade({ side: 'SELL', stopLoss: 103, takeProfit: 94, initialStopLoss: 103, initialTakeProfit: 94, ...extra })

const review = (extra = {}) => ({
  decision: 'HOLD', thesisConfidence: 70, suggestedStop: null, suggestedTakeProfit: null, partialClosePct: null,
  reason: 'r', whatChanged: 'w', expectedNext: 'e', invalidation: 'i', ...extra,
})

// ---- roles ------------------------------------------------------------------------------------------------------------

test('the fifth role is the Position Manager, after entry; there is no Decision Agent and the entry pipeline has four stages', () => {
  assert.deepEqual(AI_TRADING_AGENTS.map((agent) => agent.id), ['analyst', 'flow', 'critic', 'risk', 'manager'])
  assert.equal(AI_TRADING_AGENTS.find((agent) => agent.id === 'manager').phase, 'after-entry')
  assert.deepEqual(AI_TRADING_ENTRY_STAGE_IDS, ['analyst', 'flow', 'critic', 'risk'])
  assert.deepEqual(AI_POSITION_MANAGER_DECISIONS, ['HOLD', 'MOVE_TO_BREAKEVEN', 'TIGHTEN_STOP', 'LET_PROFIT_RUN', 'EXTEND_TAKE_PROFIT', 'PARTIAL_TAKE_PROFIT', 'EXIT_NOW'])
})

// ---- metrics (inputs for the model, not rules) -------------------------------------------------------------------------

test('computeTradeMetrics: R multiple, distances, excursions measured from candles after entry', () => {
  const candles = [
    { closeTime: T0 - 1000, high: 120, low: 50 }, // before entry: ignored
    { closeTime: T0 + 60_000, high: 104, low: 99 },
    { closeTime: T0 + 120_000, high: 105.8, low: 102 },
  ]
  const m = computeTradeMetrics({ trade: longTrade(), price: 105.5, candles, now: T0 + 10 * 60_000 })
  assert.equal(m.side, 'LONG')
  assert.equal(m.rMultiple, 1.83) // (105.5 - 100) / 3
  assert.equal(m.priceChangePct, 5.5)
  assert.equal(m.elapsedMinutes, 10)
  assert.equal(m.maxFavorableExcursionPct, 5.8)
  assert.equal(m.maxFavorableExcursionR, 1.93)
  assert.equal(m.maxAdverseExcursionPct, -1, 'the pre-entry candle with low 50 must not count')
  assert.equal(m.maxAdverseExcursionR, -0.33)
  assert.equal(m.unrealizedPnlUsdt, 55)
  assert.equal(m.distanceToStopPct, 8.057)
  assert.equal(m.distanceToTargetPct, 0.474)
  assert.equal(m.stopVsEntryR, -1)
  assert.equal(m.remainingPositionPct, 100)
})

test('computeTradeMetrics: a SHORT is mirrored, a moved stop shows locked profit, and an older trade without initial fields still works', () => {
  const m = computeTradeMetrics({ trade: shortTrade({ stopLoss: 99 }), price: 96, candles: [{ closeTime: T0 + 1, high: 101, low: 95 }], now: T0 })
  assert.equal(m.side, 'SHORT')
  assert.equal(m.rMultiple, 1.33, 'R is measured against the INITIAL stop distance (3), not the moved stop')
  assert.equal(m.maxFavorableExcursionPct, 5)
  assert.equal(m.maxAdverseExcursionPct, -1)
  assert.equal(m.stopVsEntryR, 0.33, 'a short stop below entry means profit is locked')

  const legacy = { ...longTrade(), initialStopLoss: undefined, initialTakeProfit: undefined, initialQuantity: undefined }
  assert.equal(computeTradeMetrics({ trade: legacy, price: 103 }).rMultiple, 1, 'falls back to the current stop as the initial stop')

  const openEnded = computeTradeMetrics({ trade: longTrade({ takeProfit: null }), price: 103 })
  assert.equal(openEnded.currentTakeProfit, null)
  assert.equal(openEnded.distanceToTargetPct, null)
})

// ---- prompt -----------------------------------------------------------------------------------------------------------

function promptFixture(extra = {}) {
  const candles = synthCandles(120, { base: 100, trend: 0.02, noise: 0.3, seed: 7 })
  const bias = synthCandles(120, { base: 100, trend: 0.1, noise: 0.6, seed: 9, step: 3_600_000 })
  const snapshot = buildMarketSnapshot({ symbol: 'XRPUSDT', entry: candles, bias, higher: candles, marketContext: { fundingRate: 0.0001 } })
  const entryContext = {
    testMode: false, entryConfidence: 71,
    analyst: { action: 'LONG', confidence: 68, regime: 'TRENDING_UP', keyFactors: ['reclaim of 1.37'], reasoning: 'Trend continuation after a clean reclaim.' },
    flow: { verdict: 'NEUTRAL', crowding: 'LOW', flags: [{ issue: 'OI flat', severity: 'low' }], reasoning: 'Balanced.', metrics: { fundingRatePct: 0.005, oiPriceRegime: 'flat' } },
    critic: { verdict: 'CAUTION', objections: [{ issue: 'Late entry', severity: 'medium' }], reasoning: 'Survivable.' },
    risk: { decision: 'APPROVE', confidence: 71, reasoning: 'Small probe.', concerns: ['crowded longs'], reduced: false },
    entrySnapshot: { at: T0, price: 100, regime: 'RANGE', trendScore: 0.1, adx1h: 18, rsi: 55, rsiSlope: 0.2, zscore: 0.4, atrPct: 0.4, relVol: 1.1, rangePos: 0.5, bbPosition: 0.5, fundingRatePct: 0.005 },
    ...extra,
  }
  const trade = longTrade()
  const metrics = computeTradeMetrics({ trade, price: 104, candles: [], now: T0 + 15 * 60_000 })
  return { trade, entryContext, metrics, snapshot }
}

test('prompt: carries the whole thesis, trade state, market, changes since entry and previous reviews — and no fixed trading rules', () => {
  const { trade, entryContext, metrics, snapshot } = promptFixture()
  const previousReviews = [
    { at: T0 + 10 * 60_000, decision: 'HOLD', thesisConfidence: 74, reason: 'Still valid.', expectedNext: 'Test of 105.', invalidation: 'Loses 101.', executed: null },
    { at: T0 + 5 * 60_000, decision: 'MOVE_TO_BREAKEVEN', thesisConfidence: 70, suggestedStop: 100, reason: 'Protect capital.', expectedNext: 'Chop.', invalidation: 'Below 99.', executed: false, rejectedReason: 'price not beyond entry' },
  ]
  const { systemPrompt, userPrompt } = positionManagerPrompts({ trade, entryContext, metrics, snapshot, flowMetrics: { fundingRatePct: 0.02, oiPriceRegime: 'new longs' }, previousReviews })
  const all = `${systemPrompt}\n${userPrompt}`

  assert.match(systemPrompt, /You are the Position Manager/)
  assert.match(systemPrompt, /INHERITED an already-open position/)
  assert.match(systemPrompt, /applies NO fixed trading rules/)
  for (const decision of AI_POSITION_MANAGER_DECISIONS) assert.ok(all.includes(decision), `${decision} must be offered`)
  // thesis
  assert.match(userPrompt, /Trend continuation after a clean reclaim/)
  assert.match(userPrompt, /Critic: CAUTION\. \[medium\] Late entry/)
  assert.match(userPrompt, /Risk Manager \(final entry approver\): APPROVE at 71% entry confidence/)
  // trade state
  assert.match(userPrompt, /current R multiple 1\.33R/)
  assert.match(userPrompt, /Initial stop 97\.0000, current stop 97\.0000/)
  assert.match(userPrompt, /Max favorable excursion/)
  assert.match(userPrompt, /elapsed 15\.0 min/)
  // market + flow + comparison
  assert.match(userPrompt, /CURRENT MARKET/)
  assert.match(userPrompt, /CURRENT DERIVATIVES FLOW/)
  assert.match(userPrompt, /DERIVATIVES FLOW AT ENTRY/)
  assert.match(userPrompt, /WHAT CHANGED SINCE ENTRY/)
  assert.match(userPrompt, /regime: RANGE ->/)
  // previous reviews, oldest first, including a rejected one
  assert.ok(userPrompt.indexOf('MOVE_TO_BREAKEVEN, thesis 70%') < userPrompt.indexOf('HOLD, thesis 74%'), 'oldest first')
  assert.match(userPrompt, /NOT executed: price not beyond entry/)
  // the output contract
  for (const field of ['thesisConfidence', 'suggestedStop', 'suggestedTakeProfit', 'partialClosePct', 'whatChanged', 'expectedNext', 'invalidation']) assert.ok(userPrompt.includes(field), field)

  // It must not smuggle in the fixed rules the owner ruled out.
  assert.doesNotMatch(all, /\+1R|at 1R|1\.5R|80% of (the )?TP|move to breakeven (when|after|at)|exit (when|if) .*-0\.5R/i)
  assert.doesNotMatch(all, /if profit reaches|if loss reaches|automatically/i)
})

test('prompt: the first review says so, an open-ended trade shows no target, and a missing entry snapshot is handled', () => {
  const { trade, entryContext, snapshot } = promptFixture({ entrySnapshot: null })
  const open = longTrade({ takeProfit: null })
  const metrics = computeTradeMetrics({ trade: open, price: 104, candles: [], now: T0 + 5 * 60_000 })
  const { userPrompt } = positionManagerPrompts({ trade: open, entryContext, metrics, snapshot, flowMetrics: null, previousReviews: [] })
  assert.match(userPrompt, /This is your first review of this trade/)
  assert.match(userPrompt, /current take profit NONE \(open-ended\)/)
  assert.match(userPrompt, /Entry-time market state was not recorded/)
  assert.doesNotMatch(userPrompt, /CURRENT DERIVATIVES FLOW/)
  assert.ok(trade)
})

// ---- parsing ---------------------------------------------------------------------------------------------------------

test('parsePositionManagerOutput: strict about decision and confidence, lenient about optional fields', () => {
  const ok = parsePositionManagerOutput({ decision: 'extend take profit', thesisConfidence: 82.4, suggestedStop: '103.8', suggestedTakeProfit: 111, partialClosePct: null, reason: ' strong ', whatChanged: 'w', expectedNext: 'e', invalidation: 'i' })
  assert.equal(ok.decision, 'EXTEND_TAKE_PROFIT')
  assert.equal(ok.thesisConfidence, 82)
  assert.equal(ok.suggestedStop, 103.8)
  assert.equal(ok.suggestedTakeProfit, 111)
  assert.equal(ok.reason, 'strong')

  assert.equal(parsePositionManagerOutput({ decision: 'LET_PROFIT_RUN', thesisConfidence: 90, suggestedTakeProfit: 'OPEN_ENDED' }).suggestedTakeProfit, 'OPEN_ENDED')
  assert.equal(parsePositionManagerOutput({ decision: 'HOLD', thesisConfidence: 60, suggestedStop: 'unchanged', suggestedTakeProfit: 'unchanged' }).suggestedStop, null)
  assert.equal(parsePositionManagerOutput({ decision: 'HOLD', thesisConfidence: 500 }).thesisConfidence, 100)
  assert.throws(() => parsePositionManagerOutput({ decision: 'SCALE_IN', thesisConfidence: 70 }), /invalid decision/)
  assert.throws(() => parsePositionManagerOutput({ decision: 'HOLD' }), /thesis confidence/)
  assert.throws(() => parsePositionManagerOutput({ decision: 'HOLD', thesisConfidence: 'high' }), /thesis confidence/)
})

// ---- the plan: valid orders that never add risk -------------------------------------------------------------------------

const plan = (trade, r, price) => planPositionAction({ trade, review: review(r), price })

test('plan: HOLD does nothing and EXIT_NOW closes everything', () => {
  const hold = plan(longTrade(), { decision: 'HOLD' }, 102)
  assert.equal(hold.ok, true)
  assert.deepEqual([hold.closeAll, hold.partialPct, hold.newStop, hold.newTakeProfit], [false, null, null, null])
  assert.equal(plan(longTrade(), { decision: 'EXIT_NOW' }, 98).closeAll, true, 'the AI may leave before the stop')
  assert.equal(plan(shortTrade(), { decision: 'EXIT_NOW' }, 104).closeAll, true)
})

test('plan: MOVE_TO_BREAKEVEN moves the stop to entry only when price is beyond it and it helps', () => {
  assert.equal(plan(longTrade(), { decision: 'MOVE_TO_BREAKEVEN' }, 103).newStop, 100)
  assert.equal(plan(shortTrade(), { decision: 'MOVE_TO_BREAKEVEN' }, 97).newStop, 100)
  assert.equal(plan(longTrade(), { decision: 'MOVE_TO_BREAKEVEN' }, 99).ok, false, 'price below entry: a stop at entry would trigger at once')
  const already = plan(longTrade({ stopLoss: 100.5 }), { decision: 'MOVE_TO_BREAKEVEN' }, 103)
  assert.equal(already.ok, true)
  assert.equal(already.newStop, null, 'a stop already beyond breakeven is left alone')
})

test('plan: TIGHTEN_STOP accepts only a stop that moves toward profit and sits on the protective side of the price', () => {
  assert.equal(plan(longTrade(), { decision: 'TIGHTEN_STOP', suggestedStop: 99 }, 103).newStop, 99)
  assert.equal(plan(shortTrade(), { decision: 'TIGHTEN_STOP', suggestedStop: 101 }, 97).newStop, 101)
  const wider = plan(longTrade(), { decision: 'TIGHTEN_STOP', suggestedStop: 95 }, 103)
  assert.equal(wider.ok, false)
  assert.match(wider.reason, /only be tightened/)
  assert.equal(plan(longTrade(), { decision: 'TIGHTEN_STOP', suggestedStop: 97 }, 103).ok, false, 'the same stop is not a tightening')
  assert.match(plan(longTrade(), { decision: 'TIGHTEN_STOP', suggestedStop: 103.5 }, 103).reason, /trigger immediately/)
  assert.match(plan(longTrade(), { decision: 'TIGHTEN_STOP', suggestedStop: 103 }, 103).reason, /trigger immediately/)
  assert.equal(plan(longTrade(), { decision: 'TIGHTEN_STOP' }, 103).ok, false, 'no stop given')
  assert.equal(plan(shortTrade(), { decision: 'TIGHTEN_STOP', suggestedStop: 105 }, 97).ok, false, 'a short stop moving up is wider')
})

test('plan: LET_PROFIT_RUN removes the target (optionally raising the stop); EXTEND_TAKE_PROFIT only moves a target further out', () => {
  const run = plan(longTrade(), { decision: 'LET_PROFIT_RUN', suggestedStop: 103.8 }, 105.5)
  assert.deepEqual([run.ok, run.newTakeProfit, run.newStop], [true, 'REMOVE', 103.8])
  assert.equal(plan(longTrade(), { decision: 'LET_PROFIT_RUN' }, 105.5).newTakeProfit, 'REMOVE', 'the stop is simply kept')
  assert.equal(plan(longTrade(), { decision: 'LET_PROFIT_RUN', suggestedStop: 96 }, 105.5).ok, false, 'a wider stop rejects the whole action')
  const already = plan(longTrade({ takeProfit: null }), { decision: 'LET_PROFIT_RUN' }, 105.5)
  assert.equal(already.newTakeProfit, null)

  const extend = plan(longTrade(), { decision: 'EXTEND_TAKE_PROFIT', suggestedTakeProfit: 111, suggestedStop: 103.8 }, 105.5)
  assert.deepEqual([extend.ok, extend.newTakeProfit, extend.newStop], [true, 111, 103.8])
  assert.match(plan(longTrade(), { decision: 'EXTEND_TAKE_PROFIT', suggestedTakeProfit: 104 }, 105.5).reason, /not beyond the current price/)
  assert.match(plan(longTrade(), { decision: 'EXTEND_TAKE_PROFIT', suggestedTakeProfit: 105.9 }, 105.5).reason, /further out/, 'closer than the current 106 target is not an extension')
  assert.equal(plan(longTrade(), { decision: 'EXTEND_TAKE_PROFIT' }, 105.5).ok, false)
  assert.equal(plan(longTrade(), { decision: 'EXTEND_TAKE_PROFIT', suggestedTakeProfit: 'OPEN_ENDED' }, 105.5).ok, false, 'removing the target is LET_PROFIT_RUN')
  assert.equal(plan(shortTrade(), { decision: 'EXTEND_TAKE_PROFIT', suggestedTakeProfit: 88 }, 94.5).newTakeProfit, 88)
  assert.equal(plan(longTrade({ takeProfit: null }), { decision: 'EXTEND_TAKE_PROFIT', suggestedTakeProfit: 108 }, 105.5).newTakeProfit, 108, 'an open-ended trade can get a target back')
})

test('plan: PARTIAL_TAKE_PROFIT needs a real fraction and can raise the stop on the remainder', () => {
  const partial = plan(longTrade(), { decision: 'PARTIAL_TAKE_PROFIT', partialClosePct: 30, suggestedStop: 100 }, 104)
  assert.deepEqual([partial.ok, partial.partialPct, partial.newStop], [true, 30, 100])
  for (const pct of [0, 0.5, 100, 150, null, -20]) assert.equal(plan(longTrade(), { decision: 'PARTIAL_TAKE_PROFIT', partialClosePct: pct }, 104).ok, false, `${pct}% must be rejected`)
  assert.equal(plan(longTrade(), { decision: 'PARTIAL_TAKE_PROFIT', partialClosePct: 30, suggestedStop: 90 }, 104).ok, false, 'a wider stop rejects the whole action')
})

test('plan invariant: whatever the model says, an executable plan never widens the stop, pulls a target in, or adds size', () => {
  let seed = 12345
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  let executable = 0
  for (let index = 0; index < 4000; index += 1) {
    const trade = random() < 0.5 ? longTrade() : shortTrade()
    const sign = trade.side === 'BUY' ? 1 : -1
    const price = 90 + random() * 25
    const r = review({
      decision: AI_POSITION_MANAGER_DECISIONS[Math.floor(random() * AI_POSITION_MANAGER_DECISIONS.length)],
      suggestedStop: random() < 0.7 ? 85 + random() * 30 : null,
      suggestedTakeProfit: random() < 0.15 ? 'OPEN_ENDED' : random() < 0.7 ? 85 + random() * 40 : null,
      partialClosePct: random() < 0.6 ? Math.round(random() * 130 - 10) : null,
    })
    const result = planPositionAction({ trade, review: r, price })
    if (!result.ok) continue
    executable += 1
    if (result.newStop != null) {
      assert.ok(sign * (result.newStop - trade.stopLoss) > 0, `stop ${result.newStop} must be tighter than ${trade.stopLoss} (${trade.side})`)
      assert.ok(sign * (price - result.newStop) > 0, `stop ${result.newStop} must be on the protective side of ${price}`)
    }
    if (typeof result.newTakeProfit === 'number') {
      assert.ok(sign * (result.newTakeProfit - trade.takeProfit) > 0, `target ${result.newTakeProfit} must be further out than ${trade.takeProfit}`)
      assert.ok(sign * (result.newTakeProfit - price) > 0)
    }
    if (result.partialPct != null) assert.ok(result.partialPct >= 1 && result.partialPct <= 99)
  }
  assert.ok(executable > 500, 'the property test must actually exercise executable plans')
})

// ---- bookkeeping ------------------------------------------------------------------------------------------------------

test('applyPartialClose: shrinks the position, banks the closed leg, and accumulates across partials', () => {
  const first = applyPartialClose(longTrade(), { quantity: 4, price: 105, at: T0 + 1, orderId: 111 })
  assert.equal(first.quantity, 6)
  assert.equal(first.notional, 600)
  assert.equal(first.margin, 120)
  assert.equal(first.maxLossPerTrade, 18)
  assert.equal(first.partialRealizedPnl, 20) // 5% of the 400 closed
  assert.equal(first.initialQuantity, 10)
  assert.deepEqual(first.partialCloseOrderIds, [111])
  assert.equal(first.partialCloses.length, 1)

  const second = applyPartialClose(first, { quantity: 3, price: 102, at: T0 + 2, orderId: 222 })
  assert.equal(second.quantity, 3)
  assert.equal(second.notional, 300)
  assert.equal(second.partialRealizedPnl, 26) // 20 + 2% of the 300 closed
  assert.deepEqual(second.partialCloseOrderIds, [111, 222])
  assert.equal(second.initialQuantity, 10, 'the original size is kept for the "% still open" input')

  const short = applyPartialClose(shortTrade(), { quantity: 5, price: 96 })
  assert.equal(short.partialRealizedPnl, 20, 'a short profits when price falls')
  assert.equal(applyPartialClose(longTrade(), { quantity: 0, price: 105 }).quantity, 10, 'a zero close changes nothing')
})

test('recordReview: newest first, capped, stamps the time, and records rejected / advisory outcomes', () => {
  let trade = longTrade()
  for (let index = 0; index < MAX_STORED_REVIEWS + 5; index += 1) trade = recordReview(trade, review({ reason: `r${index}` }), { at: T0 + index })
  assert.equal(trade.managerReviews.length, MAX_STORED_REVIEWS)
  assert.equal(trade.managerReviews[0].reason, `r${MAX_STORED_REVIEWS + 4}`)
  assert.equal(trade.managerLastReviewAt, T0 + MAX_STORED_REVIEWS + 4)

  const rejected = recordReview(longTrade(), review({ decision: 'TIGHTEN_STOP' }), { at: 1, executed: false, rejectedReason: 'wider', metrics: { rMultiple: 0.4, price: 101, currentStop: 97, currentTakeProfit: 106 } })
  assert.deepEqual([rejected.managerReviews[0].executed, rejected.managerReviews[0].rejectedReason, rejected.managerReviews[0].rMultiple], [false, 'wider', 0.4])
  assert.equal(recordReview(longTrade(), review(), { advisoryOnly: true }).managerReviews[0].advisoryOnly, true)
})

// ---- record + paper settlement -----------------------------------------------------------------------------------------

test('a new AI trade record keeps the initial stop / target / size and the thesis for the Position Manager', () => {
  const run = {
    id: 'ai-trading-XRPUSDT-1', symbol: 'XRPUSDT', testMode: true, entrySnapshot: { price: 1.38, regime: 'RANGE' }, final: { confidence: 66, reason: 'ok' },
    stages: [
      { id: 'analyst', output: { action: 'LONG', confidence: 61, regime: 'RANGE', keyFactors: ['a'], reasoning: 'why' } },
      { id: 'flow', output: { verdict: 'NEUTRAL', crowding: 'LOW', flags: [], reasoning: 'f', metrics: { fundingRatePct: 0.01 } } },
      { id: 'critic', output: { verdict: 'CAUTION', objections: [], reasoning: 'c' } },
      { id: 'risk', output: { reduced: true, ai: { decision: 'REDUCE', confidence: 66, reasoning: 'small', concerns: ['x'] }, plan: { side: 'LONG' } } },
    ],
  }
  const plan = { side: 'LONG', entryPrice: 1.3806, stopLoss: 1.3734, takeProfit: 1.3916, stopLossPct: 0.52, takeProfitPct: 0.8 }
  const record = buildAiTradeRecord({
    run, plan, mode: 'testnet', scaled: { margin: 100, maxLoss: 2.5, notional: 480, quantityHint: 348, notes: [] },
    execution: { quantity: 348.2, entryPrice: 1.3793, stopLoss: 1.3735, takeProfit: 1.3916, validationStatus: 'EXECUTED', mode: 'binance-futures-testnet' },
    marginMode: 'ISOLATED', leverage: 1, now: T0, dateKey: '2026-09-20',
  })
  assert.equal(record.initialStopLoss, 1.3735)
  assert.equal(record.initialTakeProfit, 1.3916)
  assert.equal(record.initialQuantity, 348.2)
  assert.deepEqual(record.managerReviews, [])
  assert.equal(record.entryContext.testMode, true)
  assert.equal(record.entryContext.entryConfidence, 66)
  assert.equal(record.entryContext.risk.decision, 'REDUCE')
  assert.equal(record.entryContext.risk.reduced, true)
  assert.equal(record.entryContext.analyst.reasoning, 'why')
  assert.equal(record.entryContext.flow.metrics.fundingRatePct, 0.01)
  assert.equal(record.entryContext.entrySnapshot.regime, 'RANGE')
  assert.equal(buildEntryContext(undefined).analyst, null, 'a run that is gone still yields a usable (empty) context')
})

test('settlePaperTrade: an open-ended trade (no target) can still be stopped out but never "hits" a missing target', () => {
  const open = longTrade({ takeProfit: null })
  assert.equal(settlePaperTrade(open, 500), null, 'price far above entry must not settle a trade that has no target')
  assert.equal(settlePaperTrade(open, 96).result, 'SL', 'the stop still works')
  assert.equal(settlePaperTrade(longTrade(), 107).result, 'TP', 'a normal target still settles')
  assert.equal(settlePaperTrade(shortTrade({ takeProfit: null }), 1), null)
})
