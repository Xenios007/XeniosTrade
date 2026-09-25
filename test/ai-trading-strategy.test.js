// The 5-point pipeline plan (docs/AI_TRADING.md, "Strategy switches"): swing timeframe, fee-aware rules, trend filter, the 3-agent
// pipeline, maker entries, and the shadow tracker's per-strategy readiness check. Every switch defaults off (legacy behaviour).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_TRADING_TIMEFRAMES, DEFAULT_AI_TRADING_CONFIG, DEFAULT_AI_TRADING_STRATEGY, activeAiTradingAgentIds, aiStrategyTag, getAiTradingTimeframe, normalizeAiTradingConfig,
} from '../src/lib/aiTrading.js'
import { buildMarketSnapshot, describeMarket, feeAwareProblems, runAiTradingPipeline, trendDirection } from '../server/ai-trading/pipeline.js'
import { buildShadowSignal, resolveShadowSignal, shadowReadiness, summarizeShadow, SHADOW_READY_DECIDED } from '../server/ai-trading/shadow.js'
import { planScanCycle } from '../server/ai-trading/scan.js'
import { isPostOnlyRejection, makerLimitPrice, runMakerEntry } from '../server/ai-trading/maker-entry.js'
import { buildRiskEvidence, describeRiskEvidence } from '../server/ai-trading/risk-evidence.js'
import { synthCandles } from './_helpers.js'

const H = 3_600_000

// ---- config ----------------------------------------------------------------------------------------------------------------------

test('strategy config: defaults to the legacy setup, booleans need an explicit true, unknown timeframe falls back', () => {
  assert.deepEqual(normalizeAiTradingConfig(null).strategy, DEFAULT_AI_TRADING_STRATEGY)
  assert.deepEqual(DEFAULT_AI_TRADING_CONFIG.strategy, { timeframe: 'scalp', feeAware: false, trendFilter: false, lean: false, makerEntry: false })
  const cfg = normalizeAiTradingConfig({ strategy: { timeframe: 'swing', lean: true, feeAware: 'true', trendFilter: 1, makerEntry: true } })
  assert.deepEqual(cfg.strategy, { timeframe: 'swing', feeAware: false, trendFilter: false, lean: true, makerEntry: true })
  assert.equal(normalizeAiTradingConfig({ strategy: { timeframe: 'weekly' } }).strategy.timeframe, 'scalp')
  assert.equal(getAiTradingTimeframe(cfg).id, 'swing')
  assert.equal(getAiTradingTimeframe(null).id, 'scalp')
  assert.equal(aiStrategyTag(cfg.strategy), 'swing+lean+maker')
  assert.equal(aiStrategyTag(undefined), 'scalp')
  assert.deepEqual(activeAiTradingAgentIds(cfg), ['analyst', 'risk', 'manager'])
  assert.deepEqual(activeAiTradingAgentIds(normalizeAiTradingConfig(null)), ['analyst', 'flow', 'critic', 'risk', 'manager'])
})

// ---- swing snapshot --------------------------------------------------------------------------------------------------------------

const swingInputs = ({ trend = 0.3, base = 100, flat = false } = {}) => ({
  entry: synthCandles(200, { base, trend: flat ? 0 : trend / 4, noise: flat ? 0.01 : 0.3, seed: 7, step: H }),
  bias: synthCandles(200, { base, trend: flat ? 0 : trend, noise: flat ? 0.01 : 0.3, seed: 9, step: 4 * H }),
  regime: synthCandles(120, { base, trend: flat ? 0 : trend * 6, noise: flat ? 0.01 : 0.5, seed: 5, step: 24 * H }),
  higher: synthCandles(120, { base, trend: flat ? 0 : trend * 6, noise: flat ? 0.01 : 0.5, seed: 5, step: 24 * H }),
  marketContext: {},
  timeframe: AI_TRADING_TIMEFRAMES.swing,
})

test('swing snapshot: 1H entries / 4H trend / 1D confirmation are labelled as such, and the classifier sees the trend', () => {
  const up = buildMarketSnapshot({ symbol: 'BTCUSDT', ...swingInputs() })
  assert.equal(up.timeframe.id, 'swing')
  assert.ok(up.indicators.trendScore >= 3)
  const text = describeMarket(up)
  assert.match(text, /Regime \(4H\/1D classifier\)/)
  assert.match(text, /1H momentum/)
  assert.match(text, /Last 8 1D closes/)
  assert.match(text, /Last 10 closed 1H candles/)
  assert.doesNotMatch(text, /5M/)

  const down = buildMarketSnapshot({ symbol: 'BTCUSDT', ...swingInputs({ trend: -0.3, base: 300 }) })
  assert.ok(down.indicators.trendScore <= -3)
  assert.equal(buildMarketSnapshot({ symbol: 'BTCUSDT', ...swingInputs({ flat: true }) }).indicators.trendScore, 0)
})

test('trendDirection: LONG / SHORT only past the threshold, nothing in between or when unknown', () => {
  const at = (score) => ({ indicators: { trendScore: score } })
  assert.equal(trendDirection(at(4)), 'LONG')
  assert.equal(trendDirection(at(2)), 'LONG')
  assert.equal(trendDirection(at(1)), null)
  assert.equal(trendDirection(at(0)), null)
  assert.equal(trendDirection(at(-2)), 'SHORT')
  assert.equal(trendDirection(at(Number.NaN)), null)
  assert.equal(trendDirection(null), null)
})

test('feeAwareProblems: target vs fee, reward:risk after fees, stop vs ATR', () => {
  assert.deepEqual(feeAwareProblems({ stopLossPct: 1.5, takeProfitPct: 4, atrPct: 0.4 }), [])
  const tiny = feeAwareProblems({ stopLossPct: 0.4, takeProfitPct: 0.4, atrPct: 0.2 })
  assert.ok(tiny.some((line) => /under 5x/.test(line)), tiny.join(' | '))
  assert.ok(tiny.some((line) => /Reward:risk after fees/.test(line)))
  // (1.2 - 0.1) / (1 + 0.1) = 1.0 < 1.5
  assert.deepEqual(feeAwareProblems({ stopLossPct: 1, takeProfitPct: 1.2, atrPct: 0.2 }).length, 1)
  const insideNoise = feeAwareProblems({ stopLossPct: 0.3, takeProfitPct: 2, atrPct: 0.5 })
  assert.equal(insideNoise.length, 1)
  assert.match(insideNoise[0], /inside normal noise/)
  assert.deepEqual(feeAwareProblems({ stopLossPct: 0.3, takeProfitPct: 2, atrPct: null }), [], 'no ATR, no ATR rule')
})

// ---- pipeline ---------------------------------------------------------------------------------------------------------------------

const ANALYST_LONG = { action: 'LONG', confidence: 72, regime: 'TRENDING_UP', stopLossPercent: 1.5, takeProfitPercent: 4, keyFactors: ['trend'], reasoning: 'Pullback in an uptrend.' }
const FLOW_DATA = { metrics: { fundingRatePct: 0.005, oiChange1hPct: 1.8, oiPriceRegime: 'new longs opening (price up, OI up)', longShortRatio: 1.1 }, sources: { premium: true }, derivativesSources: 5 }

function fakeAgents(overrides = {}) {
  const calls = []
  const prompts = {}
  const replies = {
    analyst: ANALYST_LONG,
    flow: { verdict: 'SUPPORTS', crowding: 'LOW', flags: [], reasoning: 'Fine.' },
    critic: { verdict: 'PASS', objections: [], reasoning: 'Fine.' },
    risk: { decision: 'APPROVE', confidence: 70, stopLossPercent: 1.5, takeProfitPercent: 4, riskPercent: 1, leverage: 3, concerns: [], reasoning: 'Sized.' },
    ...overrides,
  }
  const callAgent = async ({ systemPrompt, userPrompt, providerId }) => {
    const role = /You are the Market Analyst\./.test(systemPrompt) ? 'analyst'
      : /You are the Market Flow Agent\./.test(systemPrompt) ? 'flow'
        : /You are the Critic\./.test(systemPrompt) ? 'critic' : 'risk'
    calls.push(role)
    prompts[role] = { systemPrompt, userPrompt }
    return { json: replies[role], providerId, model: 'fake' }
  }
  return { callAgent, calls, prompts }
}

async function run({ strategy = {}, agents = {}, inputs = swingInputs(), getFlowData = async () => FLOW_DATA } = {}) {
  const cfg = normalizeAiTradingConfig({ strategy: { timeframe: 'swing', ...strategy } })
  const fake = fakeAgents(agents)
  const result = await runAiTradingPipeline({ symbol: 'BTCUSDT', config: cfg, getMarketInputs: async () => inputs, getFlowData, callAgent: fake.callAgent, backtestStats: null })
  return { result, calls: fake.calls, prompts: fake.prompts }
}

test('pipeline: every run records its strategy tag and timeframe', async () => {
  const { result } = await run({ strategy: { trendFilter: true, feeAware: true, lean: true } })
  assert.equal(result.strategy, 'swing+trend+fee+lean')
  assert.equal(result.timeframe, 'swing')
  const legacy = await runAiTradingPipeline({ symbol: 'BTCUSDT', config: normalizeAiTradingConfig(null), getMarketInputs: async () => ({ ...swingInputs(), timeframe: undefined }), getFlowData: async () => FLOW_DATA, callAgent: fakeAgents().callAgent, backtestStats: null })
  assert.equal(legacy.strategy, 'scalp')
})

test('trend filter: no clear trend -> HOLD with no model calls at all, and a failed trend gate', async () => {
  const { result, calls } = await run({ strategy: { trendFilter: true }, inputs: swingInputs({ flat: true }) })
  assert.deepEqual(calls, [])
  assert.equal(result.final.approved, false)
  assert.match(result.final.reason, /Trend filter: No clear higher-timeframe trend/)
  assert.deepEqual(result.final.gates.map((gate) => [gate.id, gate.passed]), [['trend', false]])
  assert.deepEqual(result.stages.map((stage) => stage.status), ['skipped', 'skipped', 'skipped', 'skipped'])
})

test('trend filter: the Analyst is only offered the trend direction, and a call against it is blocked before any other agent', async () => {
  const ok = await run({ strategy: { trendFilter: true } })
  assert.match(ok.prompts.analyst.userPrompt, /TREND FILTER: the higher-timeframe trend is UP/)
  assert.match(ok.prompts.analyst.userPrompt, /"action":"LONG\|HOLD"/)
  assert.equal(ok.result.final.approved, true)
  assert.deepEqual(ok.result.final.gates.map((gate) => gate.id), ['trend', 'analyst', 'risk'])
  assert.ok(ok.result.final.gates.every((gate) => gate.passed))

  const against = await run({ strategy: { trendFilter: true }, agents: { analyst: { ...ANALYST_LONG, action: 'SHORT' } } })
  assert.deepEqual(against.calls, ['analyst'])
  assert.equal(against.result.final.approved, false)
  assert.match(against.result.final.reason, /Analyst called SHORT against the LONG trend/)

  const down = await run({ strategy: { trendFilter: true }, inputs: swingInputs({ trend: -0.3, base: 300 }), agents: { analyst: { ...ANALYST_LONG, action: 'SHORT' } } })
  assert.match(down.prompts.analyst.userPrompt, /"action":"SHORT\|HOLD"/)
  assert.equal(down.result.final.action, 'SHORT')
  assert.equal(down.result.final.approved, true)
})

test('trend filter off: the Analyst may go either way (legacy wording)', async () => {
  const { prompts } = await run()
  assert.match(prompts.analyst.userPrompt, /"action":"LONG\|SHORT\|HOLD"/)
  assert.doesNotMatch(prompts.analyst.userPrompt, /TREND FILTER/)
  assert.match(prompts.analyst.userPrompt, /the next 12-48 hours/)
})

test('fee-aware: the rules are stated to the Analyst and the Risk Manager, and a plan that breaks them is vetoed with the reason', async () => {
  const good = await run({ strategy: { feeAware: true } })
  assert.equal(good.result.final.approved, true)
  assert.match(good.prompts.analyst.userPrompt, /round trip costs about 0\.10%/)
  assert.match(good.prompts.risk.userPrompt, /HARD RULES checked in code/)

  const scalpy = await run({ strategy: { feeAware: true }, agents: { risk: { decision: 'APPROVE', confidence: 80, stopLossPercent: 0.3, takeProfitPercent: 0.45, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Quick scalp.' } } })
  assert.equal(scalpy.result.final.approved, false)
  assert.match(scalpy.result.final.reason, /^Fee-aware rules:/)
  const risk = scalpy.result.stages.find((stage) => stage.id === 'risk').output
  assert.equal(risk.feeRuleVeto, true)

  const off = await run({ agents: { risk: { decision: 'APPROVE', confidence: 80, stopLossPercent: 0.3, takeProfitPercent: 0.45, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Quick scalp.' } } })
  assert.equal(off.result.final.approved, true, 'without the switch the Risk Manager\'s numbers stand, as before')
  assert.doesNotMatch(off.prompts.risk.userPrompt, /HARD RULES/)
})

test('3-agent pipeline: only Analyst and Risk Manager are called; the Analyst reads flow data and the Risk Manager plays Critic', async () => {
  const { result, calls, prompts } = await run({ strategy: { lean: true } })
  assert.deepEqual(calls, ['analyst', 'risk'])
  assert.deepEqual(result.stages.map((stage) => [stage.id, stage.status]), [['analyst', 'ok'], ['flow', 'skipped'], ['critic', 'skipped'], ['risk', 'ok']])
  assert.match(result.stages[1].summary, /Not used in the 3-agent pipeline/)
  assert.equal(result.final.approved, true)
  assert.match(prompts.analyst.userPrompt, /there is no separate flow agent/)
  assert.match(prompts.analyst.userPrompt, /new longs opening/)
  assert.match(prompts.risk.userPrompt, /You are also the Critic in this pipeline/)
  assert.match(prompts.risk.userPrompt, /new longs opening/)
  assert.doesNotMatch(prompts.risk.userPrompt, /^Critic: /m)
  assert.doesNotMatch(prompts.risk.userPrompt, /^Market Flow Agent: /m)
})

test('3-agent pipeline: missing flow data is not fatal (the prompts say so); an Analyst HOLD skips only the Risk Manager call', async () => {
  const noFlow = await run({ strategy: { lean: true }, getFlowData: async () => { throw new Error('down') } })
  assert.deepEqual(noFlow.calls, ['analyst', 'risk'])
  assert.match(noFlow.prompts.analyst.userPrompt, /Flow data unavailable/)
  assert.equal(noFlow.result.final.approved, true)

  const hold = await run({ strategy: { lean: true }, agents: { analyst: { ...ANALYST_LONG, action: 'HOLD' } } })
  assert.deepEqual(hold.calls, ['analyst'])
  assert.deepEqual(hold.result.stages.map((stage) => stage.id), ['analyst', 'flow', 'critic', 'risk'])
})

// ---- shadow tracker -----------------------------------------------------------------------------------------------------------------

const shadowRun = ({ timeframe = 'swing', strategy = 'swing+trend', approved = false, startedAt = 1_000_000 } = {}) => ({
  id: `run-${startedAt}-${approved}`,
  symbol: 'BTCUSDT',
  price: 100,
  startedAt,
  timeframe,
  strategy,
  stages: [{ id: 'analyst', output: { action: 'LONG', confidence: 70, stopLossPercent: 1, takeProfitPercent: 2 } }],
  final: approved
    ? { approved: true, gates: [], trade: { stopLossPct: 2, takeProfitPct: 5 } }
    : { approved: false, gates: [{ id: 'trend', passed: false }] },
})

test('shadow: swing signals carry their own horizon / resolution / strategy; approved ones use the Risk Manager\'s bracket', () => {
  const blocked = buildShadowSignal(shadowRun())
  assert.equal(blocked.horizonMs, 48 * H)
  assert.equal(blocked.resolution, '5m')
  assert.equal(blocked.strategy, 'swing+trend')
  assert.equal(blocked.group, 'trend')
  assert.equal(blocked.bracket, 'analyst')
  assert.equal(blocked.stopPct, 1)

  const approved = buildShadowSignal(shadowRun({ approved: true }))
  assert.equal(approved.bracket, 'risk')
  assert.equal(approved.stopPct, 2)
  assert.equal(approved.targetPct, 5)

  const legacy = buildShadowSignal({ ...shadowRun(), timeframe: undefined, strategy: undefined })
  assert.equal(legacy.horizonMs, 2 * H)
  assert.equal(legacy.resolution, '1m')
  assert.equal(legacy.strategy, 'scalp')
})

test('shadow: a swing signal is still pending after 2h and expires only at its 48h horizon', () => {
  const signal = buildShadowSignal(shadowRun())
  const flat = Array.from({ length: 600 }, (_, index) => ({ time: signal.startedAt + index * 5 * 60_000, open: 100, high: 100.2, low: 99.8, close: 100 }))
  assert.equal(resolveShadowSignal(signal, flat, signal.startedAt + 3 * H), null)
  const expired = resolveShadowSignal(signal, flat, signal.startedAt + 49 * H)
  assert.equal(expired.result, 'expired')
  assert.equal(expired.minutes, 48 * 60)
})

const decided = (count, hits, { strategy = 'swing+trend', stopPct = 1, targetPct = 2 } = {}) => Array.from({ length: count }, (_, index) => ({
  id: `s${strategy}${index}`,
  testMode: false,
  strategy,
  group: 'executed',
  stopPct,
  targetPct,
  startedAt: index,
  outcome: { result: index < hits ? 'target' : 'stop', netPct: index < hits ? targetPct - 0.1 : -stopPct - 0.1 },
}))

test('shadow readiness: needs 200 decided taken trades and a hit rate clearly above break-even', () => {
  // break-even for 1% stop / 2% target / 0.1% fee = 1.1 / 3 = 36.7%
  const few = shadowReadiness(decided(50, 40))
  assert.equal(few.ready, false)
  assert.match(few.message, /50\/200/)

  const coinFlip = shadowReadiness(decided(SHADOW_READY_DECIDED, 80)) // 40%: above break-even, but not clearly
  assert.equal(coinFlip.ready, false)
  assert.match(coinFlip.message, /no proven edge/)

  const edge = shadowReadiness(decided(SHADOW_READY_DECIDED, 100)) // 50%, 95% low ~43%
  assert.equal(edge.ready, true)
  assert.match(edge.message, /^Ready/)

  const blockedOnly = shadowReadiness(decided(300, 200).map((signal) => ({ ...signal, group: 'risk' })))
  assert.equal(blockedOnly.decided, 0, 'signals that were never taken do not count')
})

test('shadow summary: filters by strategy (older signals count as scalp) and includes readiness', () => {
  const older = decided(4, 1, { strategy: 'old' }).map(({ strategy, ...signal }) => signal) // recorded before strategies existed
  const pool = [...decided(10, 5), ...older]
  assert.equal(summarizeShadow(pool, { strategy: 'swing+trend' }).groups[0].signals, 10)
  assert.equal(summarizeShadow(pool, { strategy: 'scalp' }).groups[0].signals, 4)
  assert.equal(summarizeShadow(pool).groups[0].signals, 14)
  assert.equal(summarizeShadow(pool, { strategy: 'swing+trend' }).readiness.decided, 10)
})

// ---- scan --------------------------------------------------------------------------------------------------------------------------

test('scan: the swing timeframe waits for a new entry candle before re-running a symbol', () => {
  const now = 10 * H
  const plan = planScanCycle({ symbols: ['BTCUSDT', 'ETHUSDT'], now, minRunGapMs: 55 * 60_000, lastRunAt: { BTCUSDT: now - 20 * 60_000, ETHUSDT: now - 60 * 60_000 } })
  assert.deepEqual(plan.toRun, ['ETHUSDT'])
  assert.match(plan.skipped[0].reason, /waiting for a new entry candle/)
  assert.deepEqual(planScanCycle({ symbols: ['BTCUSDT'], now, lastRunAt: { BTCUSDT: now - 60_000 } }).toRun, ['BTCUSDT'], 'no gap configured = legacy behaviour')
})

// ---- maker entry -------------------------------------------------------------------------------------------------------------------

function stubExchange({ limitStatuses = [], placeLimitError = null, marketError = null, minQty = 0.001 } = {}) {
  const log = []
  let statusIndex = 0
  return {
    log,
    exchange: {
      placeLimit: async () => {
        log.push('limit')
        if (placeLimitError) throw placeLimitError
        return { orderId: '111111111111111111', clientOrderId: 'x_mk', status: 'NEW', price: '100', executedQty: '0' }
      },
      fetchStatus: async (orderId) => {
        log.push(`status:${orderId}`)
        if (orderId === 'M') return { orderId: 'M', status: 'FILLED', executedQty: log.marketQty, avgPrice: '100.05' }
        const status = limitStatuses[Math.min(statusIndex, limitStatuses.length - 1)]
        statusIndex += 1
        return status
      },
      cancel: async (orderId) => { log.push(`cancel:${orderId}`); return null },
      placeMarket: async (quantity) => {
        log.push(`market:${quantity}`)
        if (marketError) throw marketError
        log.marketQty = String(quantity)
        return { orderId: 'M', clientOrderId: 'x_entry', status: 'FILLED', executedQty: '0' }
      },
      tradableQuantity: (quantity) => (quantity >= minQty ? Math.round(quantity * 1000) / 1000 : 0),
    },
  }
}

const fastClock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

test('maker entry: a full maker fill needs no market order', async () => {
  const { exchange, log } = stubExchange({ limitStatuses: [{ status: 'FILLED', executedQty: '1', avgPrice: '100' }] })
  const fill = await runMakerEntry({ quantity: 1, exchange, ...fastClock() })
  assert.equal(fill.makerQty, 1)
  assert.equal(fill.takerQty, 0)
  assert.equal(fill.avgPrice, 100)
  assert.deepEqual(fill.orderIds, ['111111111111111111'], 'order ids stay strings')
  assert.ok(!log.some((entry) => entry.startsWith('market')))
})

test('maker entry: unfilled after the wait -> cancelled, the remainder goes at market, the average price is weighted', async () => {
  const partial = { status: 'PARTIALLY_FILLED', executedQty: '0.4', avgPrice: '100' }
  const { exchange, log } = stubExchange({ limitStatuses: [partial, partial, partial, partial, partial, partial, partial, partial, { status: 'CANCELED', executedQty: '0.4', avgPrice: '100' }] })
  const fill = await runMakerEntry({ quantity: 1, exchange, waitMs: 15_000, pollMs: 2_000, ...fastClock() })
  assert.ok(log.includes('cancel:111111111111111111'))
  assert.ok(log.includes('market:0.6'))
  assert.equal(fill.makerQty, 0.4)
  assert.equal(fill.takerQty, 0.6)
  assert.ok(Math.abs(fill.avgPrice - 100.03) < 1e-9)
  assert.deepEqual(fill.orderIds, ['111111111111111111', 'M'])
  assert.equal(fill.orderId, 'M')
})

test('maker entry: a post-only rejection falls back to a market order; any other placement error is a failure', async () => {
  const rejected = stubExchange({ placeLimitError: new Error('Binance -5022: Due to the order could not be executed as maker, the Post Only order will be rejected.') })
  const fill = await runMakerEntry({ quantity: 1, exchange: rejected.exchange, ...fastClock() })
  assert.equal(fill.makerQty, 0)
  assert.equal(fill.takerQty, 1)
  assert.match(fill.notes[0], /would have crossed/)

  const broken = stubExchange({ placeLimitError: new Error('Timestamp for this request is outside of the recvWindow') })
  await assert.rejects(runMakerEntry({ quantity: 1, exchange: broken.exchange, ...fastClock() }), /recvWindow/)
  assert.equal(isPostOnlyRejection(new Error('post only')), true)
  assert.equal(isPostOnlyRejection(new Error('insufficient margin')), false)
})

test('maker entry: a failed market remainder keeps a partial maker fill, but fails when nothing filled', async () => {
  const partial = { status: 'CANCELED', executedQty: '0.5', avgPrice: '100' }
  const kept = stubExchange({ limitStatuses: [partial], marketError: new Error('min notional') })
  const fill = await runMakerEntry({ quantity: 1, exchange: kept.exchange, ...fastClock() })
  assert.equal(fill.executedQty, 0.5)
  assert.ok(fill.notes.some((note) => /kept the 0.5 filled as maker/.test(note)))

  const none = stubExchange({ limitStatuses: [{ status: 'EXPIRED', executedQty: '0' }], marketError: new Error('margin is insufficient') })
  await assert.rejects(runMakerEntry({ quantity: 1, exchange: none.exchange, ...fastClock() }), /insufficient/)
})

test('maker entry: rests on the book without crossing (bid for BUY, ask for SELL)', () => {
  assert.equal(makerLimitPrice({ side: 'BUY', bidPrice: '99.9', askPrice: '100.1' }), 99.9)
  assert.equal(makerLimitPrice({ side: 'SELL', bidPrice: '99.9', askPrice: '100.1' }), 100.1)
  assert.throws(() => makerLimitPrice({ side: 'BUY', bidPrice: '0', askPrice: '1' }), /No usable bid/)
})

// ---- risk evidence -----------------------------------------------------------------------------------------------------------------

test('risk evidence: swing labels the fast/slow series 1H/4H and the excursion horizon in hours', () => {
  const evidence = buildRiskEvidence({
    candles5m: synthCandles(500, { noise: 0.5, seed: 3, step: H }),
    candles1h: synthCandles(300, { noise: 0.8, seed: 4, step: 4 * H }),
    timeframe: AI_TRADING_TIMEFRAMES.swing.evidence,
  })
  const text = describeRiskEvidence({ evidence, side: 'LONG', stopPct: 1.5, targetPct: 4 }).join('\n')
  assert.match(text, /1H ATR is/)
  assert.match(text, /4H ATR is/)
  assert.match(text, /in the 24 hours after ANY 1H close/)
  assert.doesNotMatch(text, /5M/)
})
