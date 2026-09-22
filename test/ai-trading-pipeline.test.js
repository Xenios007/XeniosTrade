import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AI_TRADING_CONFIG, normalizeAiTradingConfig } from '../src/lib/aiTrading.js'
import {
  buildMarketSnapshot, evaluateGates, parseAnalystOutput, parseCriticOutput, parseFlowOutput, parseRiskProposal, runAiTradingPipeline, runRiskManager,
} from '../server/ai-trading/pipeline.js'
import { classifyOiPriceRegime, collectFlowData, describeFlow, summarizeFlow } from '../server/ai-trading/flow-data.js'
import { createQuantStatsAccumulator, lookupQuantEdge, stopLossBucket } from '../server/ai-trading/quant-stats.js'
import { describeProviderError, extractJsonObject, resolveProviderCall } from '../server/ai-trading/llm.js'
import { getCodexAgentStatus, runCodexAgent } from '../server/ai-trading/codex-agent.js'
import { getClaudeAgentStatus, runClaudeAgent } from '../server/ai-trading/claude-agent.js'
import { getAiProvider, isLocalLoginReady } from '../src/lib/aiProviders.js'
import { synthCandles } from './_helpers.js'

const LIMITS = DEFAULT_AI_TRADING_CONFIG.risk
const config = normalizeAiTradingConfig(null)

// ---- config ---------------------------------------------------------------

test('normalizeAiTradingConfig: defaults, unknown providers, risk is not user-configurable', () => {
  assert.deepEqual(normalizeAiTradingConfig(null), DEFAULT_AI_TRADING_CONFIG)

  const cleaned = normalizeAiTradingConfig({
    agents: { analyst: { providerId: 'not-real', model: ' m ' }, critic: { providerId: 'openai' } },
    risk: { riskPerTradePct: 50, maxLeverage: 99.6, maxStopLossPct: 'x' },
  })
  assert.equal(cleaned.agents.analyst.providerId, '', 'unknown provider becomes unassigned')
  assert.equal(cleaned.agents.analyst.model, 'm')
  assert.equal(cleaned.agents.critic.providerId, 'openai')
  assert.equal(cleaned.agents.manager.providerId, 'anthropic', 'missing entry falls back to the default')
  assert.equal(cleaned.agents.decision, undefined, 'the Decision Agent no longer exists')
  assert.equal(normalizeAiTradingConfig({ agents: { decision: { providerId: 'claude', model: 'm' } } }).agents.manager.providerId, 'claude', 'a saved Decision assignment is inherited by the Position Manager')
  assert.equal(normalizeAiTradingConfig({ agents: { decision: { providerId: 'claude' }, manager: { providerId: 'openai' } } }).agents.manager.providerId, 'openai', 'an explicit manager entry wins')
  assert.deepEqual(cleaned.risk, DEFAULT_AI_TRADING_CONFIG.risk, 'a client-supplied risk block is ignored: the ceilings are fixed in code')
  assert.equal(cleaned.risk.vetoOnNegativeEv, undefined, 'the backtest veto setting no longer exists')
  assert.deepEqual(normalizeAiTradingConfig({ risk: { riskPerTradePct: 50, maxLeverage: 99 } }).risk, DEFAULT_AI_TRADING_CONFIG.risk)
})

// ---- backtest context (formerly the Quant Agent) ----------------------------------------------------------------

function statsWith(rows) {
  const acc = createQuantStatsAccumulator()
  for (const row of rows) acc.add(row)
  return acc.finalize('test')
}

const tradesOf = (symbol, side, wins, losses, winPnl, lossPnl, stopPct = 0.5) => [
  ...Array.from({ length: wins }, () => ({ symbol, side, pnl: winPnl, configuredStopLossPercent: stopPct })),
  ...Array.from({ length: losses }, () => ({ symbol, side, pnl: lossPnl, configuredStopLossPercent: stopPct })),
]

test('stopLossBucket edges', () => {
  assert.equal(stopLossBucket(0.2), 'lt0.4')
  assert.equal(stopLossBucket(0.4), '0.4-0.8')
  assert.equal(stopLossBucket(0.8), '0.8-1.5')
  assert.equal(stopLossBucket(3), 'gte1.5')
})

test('lookupQuantEdge: positive edge on a big sample is SUPPORTS; a losing history is AGAINST', () => {
  const good = statsWith(tradesOf('BTCUSDT', 'BUY', 600, 400, 30, -20))
  const supports = lookupQuantEdge(good, { symbol: 'BTCUSDT', side: 'LONG', stopLossPct: 0.5, takeProfitPct: 1 })
  assert.equal(supports.available, true)
  assert.equal(supports.level, 'symbol+side+stop')
  assert.equal(supports.sampleSize, 1000)
  assert.equal(supports.winRate, 0.6)
  assert.equal(supports.payoffRatio, 1.5)
  assert.equal(supports.expectedValueR, 0.5) // 0.6*1.5 - 0.4
  assert.equal(supports.verdict, 'SUPPORTS')

  const bad = statsWith(tradesOf('BTCUSDT', 'BUY', 300, 700, 20, -20))
  assert.equal(lookupQuantEdge(bad, { symbol: 'BTCUSDT', side: 'LONG', stopLossPct: 0.5, takeProfitPct: 1 }).verdict, 'AGAINST')
})

test('lookupQuantEdge: a thin edge that luck could explain is NEUTRAL, not SUPPORTS', () => {
  const thin = statsWith(tradesOf('ETHUSDT', 'SELL', 34, 66, 40, -20)) // EV +0.02R on n=100
  const result = lookupQuantEdge(thin, { symbol: 'ETHUSDT', side: 'SHORT', stopLossPct: 0.5, takeProfitPct: 1 })
  assert.ok(result.expectedValueR > 0)
  assert.ok(result.conservativeEvR <= 0)
  assert.equal(result.verdict, 'NEUTRAL')
})

test('lookupQuantEdge: falls back to broader buckets, and reports no data rather than guessing', () => {
  const stats = statsWith([
    ...tradesOf('BTCUSDT', 'BUY', 10, 10, 10, -10, 0.5), // 20 trades: too few for the exact bucket
    ...tradesOf('BTCUSDT', 'BUY', 10, 10, 10, -10, 2.0), // 40 in total for symbol+side
    ...tradesOf('SOLUSDT', 'BUY', 100, 100, 10, -10, 2.0),
  ])
  const broad = lookupQuantEdge(stats, { symbol: 'BTCUSDT', side: 'LONG', stopLossPct: 0.5, takeProfitPct: 1 })
  assert.equal(broad.level, 'symbol+side', 'BTC has 40 trades across buckets, enough at the symbol+side level but not in the 0.4-0.8 bucket')

  const none = lookupQuantEdge(stats, { symbol: 'BTCUSDT', side: 'SHORT', stopLossPct: 0.5, takeProfitPct: 1 })
  assert.equal(none.available, false)
  assert.equal(none.verdict, 'NEUTRAL')
  assert.equal(lookupQuantEdge(null, { symbol: 'BTCUSDT', side: 'LONG', stopLossPct: 1, takeProfitPct: 2 }).available, false)
})

// ---- risk manager ---------------------------------------------------------

test('runRiskManager: sizes to the risk budget and places stop/target on the right side', () => {
  const long = runRiskManager({ side: 'LONG', price: 100, atrPct: 0.3, stopLossPct: 1, takeProfitPct: 2, limits: LIMITS })
  assert.equal(long.approved, true)
  assert.equal(long.plan.maxLossUsdt, 10) // 1% of 1000
  assert.equal(long.plan.notionalUsdt, 1000) // 10 / 1%
  assert.equal(long.plan.leverage, 1)
  assert.equal(long.plan.stopLoss, 99)
  assert.equal(long.plan.takeProfit, 102)
  assert.equal(long.plan.rewardRisk, 2)

  const short = runRiskManager({ side: 'SHORT', price: 100, atrPct: 0.3, stopLossPct: 1, takeProfitPct: 2, limits: LIMITS })
  assert.equal(short.plan.stopLoss, 101)
  assert.equal(short.plan.takeProfit, 98)
})

test('runRiskManager: widens a stop inside the ATR floor and re-checks reward:risk', () => {
  const widened = runRiskManager({ side: 'LONG', price: 100, atrPct: 1, stopLossPct: 0.3, takeProfitPct: 2, limits: LIMITS })
  assert.equal(widened.approved, true)
  assert.equal(widened.plan.stopLossPct, 1)
  assert.ok(widened.adjustments.some((note) => note.includes('widened')))

  const tooTight = runRiskManager({ side: 'LONG', price: 100, atrPct: 1, stopLossPct: 0.3, takeProfitPct: 1, limits: LIMITS })
  assert.equal(tooTight.approved, false, 'after widening to 1%, a 1% target is only 1:1')
  assert.match(tooTight.vetoReasons[0], /Reward:risk/)
})

test('runRiskManager: caps leverage, and vetoes when volatility forces a stop past the max', () => {
  const capped = runRiskManager({ side: 'LONG', price: 100, atrPct: 0.05, stopLossPct: 0.1, takeProfitPct: 0.3, limits: LIMITS })
  assert.equal(capped.approved, true)
  assert.equal(capped.plan.leverage, LIMITS.maxLeverage)
  assert.equal(capped.plan.notionalUsdt, LIMITS.accountEquityUsdt * LIMITS.maxLeverage)
  assert.ok(capped.plan.maxLossUsdt < 10, 'risk shrinks when the leverage cap binds')
  assert.ok(capped.adjustments.some((note) => note.includes('capped')))

  const volatile = runRiskManager({ side: 'LONG', price: 100, atrPct: 4, stopLossPct: 2, takeProfitPct: 6, limits: LIMITS })
  assert.equal(volatile.approved, false)
  assert.match(volatile.vetoReasons[0], /Volatility too high/)
  assert.equal(volatile.plan, null)
})

test('runRiskManager: vetoes on missing inputs instead of guessing', () => {
  const result = runRiskManager({ side: 'LONG', price: 0, atrPct: 1, stopLossPct: 1, takeProfitPct: 2, limits: LIMITS })
  assert.equal(result.approved, false)
})

// ---- parsing --------------------------------------------------------------

test('extractJsonObject tolerates fences and prose', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('Sure! {"a":{"b":2}} hope that helps'), { a: { b: 2 } })
  assert.throws(() => extractJsonObject('no json here'))
  assert.throws(() => extractJsonObject(''))
})

test('parsers reject malformed agent output', () => {
  assert.equal(parseAnalystOutput({ action: 'wait', confidence: 40 }).action, 'HOLD')
  assert.throws(() => parseAnalystOutput({ action: 'BUY', confidence: 80 }), /invalid action/)
  assert.throws(() => parseAnalystOutput({ action: 'LONG', confidence: 80 }), /stop-loss/)
  assert.throws(() => parseAnalystOutput({ action: 'LONG', confidence: 'high', stopLossPercent: 1, takeProfitPercent: 2 }), /confidence/)
  assert.throws(() => parseCriticOutput({ verdict: 'MAYBE' }), /invalid verdict/)
  assert.equal(parseCriticOutput({ verdict: 'reject', objections: [{ issue: 'x', severity: 'HIGH' }, { issue: '' }] }).objections.length, 1)
})

test('resolveProviderCall: reports a missing key rather than throwing', () => {
  const previous = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  const result = resolveProviderCall('openai')
  assert.equal(result.configured, false)
  assert.match(result.reason, /API key/)
  assert.equal(resolveProviderCall('').configured, false)
  assert.equal(resolveProviderCall('ollama').configured, true, 'keyless local providers need no key')
  if (previous !== undefined) process.env.OPENAI_API_KEY = previous
})

// ---- pipeline -------------------------------------------------------------

const marketInputs = () => ({
  entry: synthCandles(120, { base: 100, trend: 0.02, noise: 0.3, seed: 7 }),
  bias: synthCandles(120, { base: 100, trend: 0.1, noise: 0.6, seed: 9, step: 3_600_000 }),
  higher: synthCandles(120, { base: 100, trend: 0.05, noise: 0.4, seed: 11, step: 900_000 }),
  marketContext: { fundingRate: 0.0001 },
})

// Wide, deliberately generous stop/target so the ATR floor never interferes with the scripted scenarios.
const ANALYST_LONG = { action: 'LONG', confidence: 72, regime: 'TRENDING_UP', stopLossPercent: 1.5, takeProfitPercent: 4, keyFactors: ['trend'], reasoning: 'Trend continuation.' }
const CRITIC_PASS = { verdict: 'PASS', objections: [], reasoning: 'Nothing material.' }
const FLOW_SUPPORTS = { verdict: 'SUPPORTS', crowding: 'LOW', flags: [{ issue: 'OI rising with price (+1.8%)', severity: 'low' }], reasoning: 'New longs opening without crowding.' }
const FLOW_DATA = { metrics: { fundingRatePct: 0.005, oiChange1hPct: 1.8, oiPriceRegime: 'new longs opening (price up, OI up)', longShortRatio: 1.1 }, sources: { premium: true, openInterest: true }, derivativesSources: 5 }

function fakeAgents(overrides = {}) {
  const calls = []
  const prompts = {}
  const analystReply = overrides.analyst || ANALYST_LONG
  // By default the Risk Manager approves exactly the Analyst's stop/target at the configured risk and leverage caps.
  const defaultRisk = { decision: 'APPROVE', confidence: 75, stopLossPercent: analystReply.stopLossPercent, takeProfitPercent: analystReply.takeProfitPercent, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Sized within limits.' }
  const replies = { analyst: ANALYST_LONG, flow: FLOW_SUPPORTS, critic: CRITIC_PASS, risk: defaultRisk, ...overrides }
  const callAgent = async ({ systemPrompt, userPrompt, providerId }) => {
    const role = /You are the Market Analyst\./.test(systemPrompt)
      ? 'analyst'
      : /You are the Market Flow Agent\./.test(systemPrompt)
        ? 'flow'
        : /You are the Critic\./.test(systemPrompt) ? 'critic' : 'risk'
    calls.push(role)
    prompts[role] = userPrompt
    const reply = replies[role]
    if (reply instanceof Error) throw reply
    return { json: reply, providerId, model: 'fake-model' }
  }
  return { callAgent, calls, prompts }
}

// A backtest history where LONG trades carry a positive edge.
const positiveStats = statsWith(tradesOf('BTCUSDT', 'BUY', 600, 400, 30, -20, 1.5))
const negativeStats = statsWith(tradesOf('BTCUSDT', 'BUY', 300, 700, 20, -20, 1.5))

async function run({
  agents = {}, stats = positiveStats, cfg = config, symbol = 'BTCUSDT', getMarketInputs = async () => marketInputs(), getFlowData = async () => FLOW_DATA,
} = {}) {
  const fake = fakeAgents(agents)
  const result = await runAiTradingPipeline({ symbol, config: cfg, getMarketInputs, getFlowData, callAgent: fake.callAgent, backtestStats: stats })
  return { result, calls: fake.calls, prompts: fake.prompts }
}

test('pipeline: all four entry stages agree -> approved trade with a Risk Manager plan and the Risk Manager\'s confidence', async () => {
  const { result, calls } = await run()
  assert.deepEqual(result.stages.map((stage) => stage.id), ['analyst', 'flow', 'critic', 'risk'])
  assert.ok(result.stages.every((stage) => stage.status === 'ok'), JSON.stringify(result.stages.map((s) => [s.id, s.status, s.error])))
  assert.deepEqual(calls, ['analyst', 'flow', 'critic', 'risk'])
  assert.equal(result.final.approved, true)
  assert.equal(result.final.action, 'LONG')
  assert.equal(result.final.confidence, 75, 'the final confidence is the Risk Manager\'s')
  assert.ok(!result.stages.some((stage) => stage.id === 'decision'), 'there is no Decision stage any more')
  assert.ok(result.entrySnapshot && result.entrySnapshot.price > 0, 'the entry market state is recorded for the Position Manager')
  assert.equal(result.final.trade.side, 'LONG')
  assert.ok(result.final.trade.stopLoss < result.price)
  assert.equal(result.advisoryOnly, true)
  assert.ok(result.final.gates.every((gate) => gate.passed))
})

test('pipeline: Analyst HOLD ends the run without spending on later agents', async () => {
  const { result, calls } = await run({ agents: { analyst: { action: 'HOLD', confidence: 30, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'Chop.' } } })
  assert.deepEqual(calls, ['analyst'])
  assert.equal(result.final.action, 'HOLD')
  assert.deepEqual(result.stages.slice(1).map((stage) => stage.status), ['skipped', 'skipped', 'skipped'])
})

test('pipeline: Critic REJECT blocks the trade and the Risk Manager is never consulted', async () => {
  const { result, calls } = await run({ agents: { critic: { verdict: 'REJECT', objections: [{ issue: 'Chasing an extended move', severity: 'high' }], reasoning: 'No.' } } })
  assert.deepEqual(calls, ['analyst', 'flow', 'critic'])
  assert.equal(result.final.action, 'HOLD')
  assert.equal(result.stages.find((stage) => stage.id === 'risk').status, 'skipped')
  assert.equal(result.final.gates.find((gate) => gate.id === 'critic').passed, false)
})

test('pipeline: Market Flow AGAINST blocks the trade and no later paid stage is consulted', async () => {
  const { result, calls } = await run({ agents: { flow: { verdict: 'AGAINST', crowding: 'HIGH', flags: [{ issue: 'Longs crowded: 2.9 ratio, funding 0.09%', severity: 'high' }], reasoning: 'Squeeze risk.' } } })
  assert.deepEqual(calls, ['analyst', 'flow'])
  assert.equal(result.final.action, 'HOLD')
  assert.equal(result.final.gates.find((gate) => gate.id === 'flow').passed, false)
  assert.deepEqual(result.stages.slice(2).map((stage) => stage.status), ['skipped', 'skipped'])
  assert.match(result.final.reason, /Market Flow Agent|Critic Agent/)
  assert.match(result.final.reason, /Blocked before the Critic Agent/)
})

test('pipeline: the Market Flow stage records the evidence next to its verdict, and the agent is shown the numbers', async () => {
  const { result, prompts } = await run()
  const flow = result.stages.find((stage) => stage.id === 'flow')
  assert.equal(flow.output.verdict, 'SUPPORTS')
  assert.equal(flow.output.metrics.oiPriceRegime, 'new longs opening (price up, OI up)')
  assert.match(prompts.flow, /Open interest/)
  assert.match(prompts.critic, /Market Flow Agent: SUPPORTS/)
  assert.match(prompts.risk, /Market Flow Agent: SUPPORTS/)
})

test('pipeline: fails closed when flow data is unavailable or the flow agent has no provider — and spends nothing after', async () => {
  const noData = await run({ getFlowData: async () => { throw new Error('Flow data unavailable for BTCUSDT: only 0 of 5 derivatives sources responded.') } })
  assert.equal(noData.result.final.action, 'HOLD')
  assert.equal(noData.result.stages.find((stage) => stage.id === 'flow').status, 'error')
  assert.deepEqual(noData.calls, ['analyst'])

  const noSource = await run({ getFlowData: null })
  assert.equal(noSource.result.final.action, 'HOLD')

  const notConfigured = Object.assign(new Error('Google (Gemini) has no API key.'), { code: 'NOT_CONFIGURED' })
  const noKey = await run({ agents: { flow: notConfigured } })
  assert.equal(noKey.result.stages.find((stage) => stage.id === 'flow').status, 'unconfigured')
  assert.equal(noKey.result.final.action, 'HOLD')
  assert.deepEqual(noKey.calls, ['analyst', 'flow'])
})

test('backtest stats are background only: a negative history no longer blocks, and is shown to the Risk Manager', async () => {
  const { result, prompts, calls } = await run({ stats: negativeStats })
  assert.equal(result.final.approved, true, 'negative backtest EV must not veto on its own any more')
  assert.deepEqual(calls, ['analyst', 'flow', 'critic', 'risk'])
  assert.match(prompts.risk, /Backtest background/)
  assert.match(prompts.risk, /EV -/)
  assert.ok(!/Backtest background/.test(prompts.flow), 'the Flow Agent judges positioning only')
  assert.equal(result.stages.find((stage) => stage.id === 'risk').output.backtest.verdict, 'AGAINST')
  assert.ok(!result.stages.some((stage) => stage.id === 'quant'))

  const none = await run({ stats: null })
  assert.match(none.prompts.risk, /No backtest statistics/)
  assert.equal(none.result.final.approved, true)
})

test('pipeline: a Risk Manager veto blocks the trade even with every agent in favour', async () => {
  const { result } = await run({ agents: { analyst: { ...ANALYST_LONG, stopLossPercent: 1, takeProfitPercent: 1.1 } } })
  assert.equal(result.final.action, 'HOLD')
  assert.equal(result.final.trade, null)
  assert.match(result.stages.find((stage) => stage.id === 'risk').summary, /Veto/)
})

test('pipeline: the Risk Manager confidence is the entry gate; REDUCE opens a smaller trade; there is no second AI after it', async () => {
  const timid = await run({ agents: { risk: { decision: 'APPROVE', confidence: 40, stopLossPercent: 1.5, takeProfitPercent: 4, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Meh.' } } })
  assert.equal(timid.result.final.approved, false, 'approved sizing is not enough: the confidence must reach the minimum')
  assert.equal(timid.result.final.trade, null)
  assert.equal(timid.result.final.gates.find((gate) => gate.id === 'risk').passed, false)
  assert.match(timid.result.final.reason, /confidence/i)

  const atMinimum = await run({ agents: { risk: { decision: 'APPROVE', confidence: config.risk.minConfidence, stopLossPercent: 1.5, takeProfitPercent: 4, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Just enough.' } } })
  assert.equal(atMinimum.result.final.approved, true, 'a confidence exactly at the minimum passes')

  const reduce = await run({ agents: { risk: { decision: 'REDUCE', confidence: 68, stopLossPercent: 1.5, takeProfitPercent: 4, riskPercent: 0.3, leverage: 2, concerns: ['Crowded'], reasoning: 'Real but weaker.' } } })
  assert.equal(reduce.result.final.approved, true)
  assert.equal(reduce.result.final.trade.maxLossUsdt, 3, '0.3% of 1000')
  const reduced = reduce.result.stages.find((stage) => stage.id === 'risk').output
  assert.equal(reduced.reduced, true)
  assert.equal(reduced.ai.decision, 'REDUCE')
  assert.match(reduce.result.stages.find((stage) => stage.id === 'risk').summary, /Approved/)
  assert.deepEqual(reduce.calls, ['analyst', 'flow', 'critic', 'risk'])
})

test('pipeline: fails closed when a provider is unconfigured, errors, or market data is missing', async () => {
  const notConfigured = Object.assign(new Error('Anthropic (Claude) has no API key.'), { code: 'NOT_CONFIGURED' })
  const missingKey = await run({ agents: { analyst: notConfigured } })
  assert.equal(missingKey.result.final.action, 'HOLD')
  assert.equal(missingKey.result.stages[0].status, 'unconfigured')

  const criticDown = await run({ agents: { critic: new Error('HTTP 500') } })
  assert.equal(criticDown.result.final.action, 'HOLD', 'no Critic verdict must never count as a pass')
  assert.equal(criticDown.result.stages.find((stage) => stage.id === 'critic').status, 'error')

  const noData = await run({ getMarketInputs: async () => { throw new Error('exchange down') } })
  assert.equal(noData.result.final.action, 'HOLD')
  assert.match(noData.result.final.reason, /Market data unavailable/)
  assert.equal(noData.calls.length, 0)

  const thin = await run({ getMarketInputs: async () => ({ ...marketInputs(), entry: synthCandles(20) }) })
  assert.equal(thin.result.final.action, 'HOLD')
  assert.equal(thin.calls.length, 0)
})

test('AI Risk Manager: a VETO blocks the trade (and needs no confidence)', async () => {
  const { result, calls } = await run({ agents: { risk: { decision: 'VETO', concerns: ['Thin book'], reasoning: 'Liquidity is too poor to size this safely.' } } })
  assert.deepEqual(calls, ['analyst', 'flow', 'critic', 'risk'])
  assert.equal(result.final.action, 'HOLD')
  assert.equal(result.final.trade, null)
  const risk = result.stages.find((stage) => stage.id === 'risk')
  assert.match(risk.summary, /Veto/)
  assert.equal(risk.output.ai.decision, 'VETO')
})

test('AI Risk Manager: asking for more risk or leverage than the limits allow is clamped, never honoured', async () => {
  const { result } = await run({ agents: { risk: { decision: 'APPROVE', confidence: 75, stopLossPercent: 1.5, takeProfitPercent: 4, riskPercent: 25, leverage: 100, concerns: [], reasoning: 'YOLO.' } } })
  const risk = result.stages.find((stage) => stage.id === 'risk').output
  assert.equal(risk.approved, true)
  assert.ok(risk.plan.maxLossUsdt <= config.risk.accountEquityUsdt * config.risk.riskPerTradePct / 100 + 0.01, `max loss ${risk.plan.maxLossUsdt} exceeds the risk cap`)
  assert.ok(risk.plan.leverage <= config.risk.maxLeverage)
  assert.ok(risk.adjustments.some((note) => note.includes('capped at the')), 'the clamp is reported')
  assert.equal(risk.ai.riskPercent, 25, 'what the model actually asked for is kept for the audit trail')
})

test('AI Risk Manager: it can size below the cap, and a plan that still breaks a limit is rejected', async () => {
  const cautious = await run({ agents: { risk: { decision: 'APPROVE', confidence: 75, stopLossPercent: 1.5, takeProfitPercent: 4, riskPercent: 0.25, leverage: 2, concerns: [], reasoning: 'Weak conviction.' } } })
  assert.equal(cautious.result.final.approved, true)
  assert.equal(cautious.result.final.trade.maxLossUsdt, 2.5) // 0.25% of 1000
  assert.ok(cautious.result.final.trade.leverage <= 2)

  const tooTight = await run({ agents: { risk: { decision: 'APPROVE', confidence: 75, stopLossPercent: 1.5, takeProfitPercent: 1.6, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Tiny target.' } } })
  assert.equal(tooTight.result.final.action, 'HOLD', 'reward:risk below the minimum is vetoed by code even though the model approved')
  assert.match(tooTight.result.stages.find((stage) => stage.id === 'risk').output.vetoReasons[0], /Reward:risk/)
})

test('AI Risk Manager: no usable answer is a veto, never unchecked sizing', async () => {
  const down = await run({ agents: { risk: new Error('HTTP 500') } })
  assert.equal(down.result.final.action, 'HOLD')
  assert.equal(down.result.stages.find((stage) => stage.id === 'risk').status, 'error')

  const malformed = await run({ agents: { risk: { decision: 'APPROVE', confidence: 75, stopLossPercent: 1 } } })
  assert.equal(malformed.result.final.action, 'HOLD')
  assert.match(malformed.result.stages.find((stage) => stage.id === 'risk').error, /positive/)
})

test('AI Risk Manager: is not called (and not paid for) once an earlier gate has blocked the trade', async () => {
  const { calls } = await run({ agents: { critic: { verdict: 'REJECT', objections: [], reasoning: 'No.' } } })
  assert.ok(!calls.includes('risk'))
  const flowAgainst = await run({ agents: { flow: { verdict: 'AGAINST', crowding: 'HIGH', flags: [], reasoning: 'Crowded.' } } })
  assert.ok(!flowAgainst.calls.includes('risk') && !flowAgainst.calls.includes('critic'))
})

test('parseRiskProposal + legacy config', () => {
  assert.equal(parseRiskProposal({ decision: 'reject' }).decision, 'VETO')
  assert.throws(() => parseRiskProposal({ decision: 'MAYBE' }), /invalid decision/)
  assert.equal(parseRiskProposal({ decision: 'REDUCE', confidence: 64, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 0.3, leverage: 2 }).decision, 'REDUCE')
  assert.throws(() => parseRiskProposal({ decision: 'APPROVE', stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage: 2 }), /confidence/, 'an approval without a confidence is an error, not a silent pass')
  assert.equal(parseRiskProposal({ decision: 'VETO' }).confidence, null)
  assert.throws(() => parseRiskProposal({ decision: 'APPROVE', confidence: 75, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage: null }), /leverage/)

  const legacy = normalizeAiTradingConfig({ agents: { analyst: { providerId: 'google' }, critic: { providerId: 'openai' }, decision: { providerId: 'openai' } } })
  assert.equal(legacy.agents.manager.providerId, 'openai')
  assert.equal(legacy.agents.risk.providerId, 'google', 'a config saved before the Risk Manager became an AI agent reuses the Analyst provider')
  assert.equal(normalizeAiTradingConfig({ agents: { risk: { providerId: 'xai' } } }).agents.risk.providerId, 'xai')
})

test('evaluateGates: an absent stage never passes its gate by default', () => {
  const gates = evaluateGates({ analyst: { action: 'LONG', confidence: 70 }, config })
  assert.equal(gates.find((gate) => gate.id === 'critic').passed, false)
  assert.equal(gates.find((gate) => gate.id === 'risk').passed, false)
  assert.equal(gates.find((gate) => gate.id === 'decision'), undefined, 'the Decision gate no longer exists')
})

// ---- provider caller (against local fake servers, no real network) --------

async function withFakeProvider(handler, run) {
  const { createServer } = await import('node:http')
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      requests.push({ url: request.url, headers: request.headers, body: parsed })
      const { status = 200, payload } = handler(parsed, requests.length)
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('callAgentJson: OpenAI-compatible providers get JSON mode, a bearer key, and retry once without JSON mode on HTTP 400', async () => {
  const { setAiProviderCredentialsStore } = await import('../server/strategy/ai-provider-credentials-store.js')
  const { callAgentJson } = await import('../server/ai-trading/llm.js')

  await withFakeProvider((body, count) => (
    count === 1
      ? { status: 400, payload: { error: { message: 'response_format is not supported' } } }
      : { payload: { choices: [{ message: { content: '```json\n{"verdict":"PASS"}\n```' } }] } }
  ), async (baseUrl, requests) => {
    setAiProviderCredentialsStore({ custom: { apiKey: 'test-key', baseUrl, model: 'fake-model' } })
    const result = await callAgentJson({ providerId: 'custom', systemPrompt: 'sys', userPrompt: 'user' })
    assert.deepEqual(result.json, { verdict: 'PASS' })
    assert.equal(result.model, 'fake-model')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, '/chat/completions')
    assert.equal(requests[0].headers.authorization, 'Bearer test-key')
    assert.deepEqual(requests[0].body.response_format, { type: 'json_object' })
    assert.equal(requests[1].body.response_format, undefined, 'retry drops JSON mode')
    assert.equal(requests[0].body.messages[0].role, 'system')
  })

  await withFakeProvider(() => ({ status: 401, payload: { error: { message: 'bad key' } } }), async (baseUrl) => {
    setAiProviderCredentialsStore({ custom: { apiKey: 'test-key', baseUrl, model: 'fake-model' } })
    await assert.rejects(() => callAgentJson({ providerId: 'custom', systemPrompt: 's', userPrompt: 'u' }), /bad key/)
  })

  setAiProviderCredentialsStore({})
  await assert.rejects(
    () => callAgentJson({ providerId: 'custom', systemPrompt: 's', userPrompt: 'u' }),
    (error) => error.code === 'NOT_CONFIGURED',
  )
})

test('callAgentJson: Anthropic goes through the SDK and honours the per-agent model override', async () => {
  const { setAiProviderCredentialsStore } = await import('../server/strategy/ai-provider-credentials-store.js')
  const { callAgentJson } = await import('../server/ai-trading/llm.js')

  await withFakeProvider(() => ({
    payload: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Here you go: {"action":"HOLD","confidence":20}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }), async (baseUrl, requests) => {
    setAiProviderCredentialsStore({ anthropic: { apiKey: 'sk-ant-test', baseUrl, model: 'claude-sonnet-5' } })
    const result = await callAgentJson({ providerId: 'anthropic', model: 'claude-haiku-4-5', systemPrompt: 'sys', userPrompt: 'user' })
    assert.deepEqual(result.json, { action: 'HOLD', confidence: 20 })
    assert.equal(result.model, 'claude-haiku-4-5')
    assert.equal(requests[0].url, '/v1/messages')
    assert.equal(requests[0].body.model, 'claude-haiku-4-5')
    assert.equal(requests[0].body.system, 'sys')
    assert.equal(requests[0].headers['x-api-key'], 'sk-ant-test')
  })
  setAiProviderCredentialsStore({})
})

test('callAgentJson: surfaces Google-style array error bodies and retries once on a transient 503', async () => {
  const { setAiProviderCredentialsStore } = await import('../server/strategy/ai-provider-credentials-store.js')
  const { callAgentJson } = await import('../server/ai-trading/llm.js')

  await withFakeProvider(() => ({
    status: 404,
    payload: [{ error: { code: 404, message: 'This model models/gemini-2.0-flash is no longer available.', status: 'NOT_FOUND' } }],
  }), async (baseUrl) => {
    setAiProviderCredentialsStore({ custom: { apiKey: 'k', baseUrl, model: 'm' } })
    await assert.rejects(() => callAgentJson({ providerId: 'custom', systemPrompt: 's', userPrompt: 'u' }), /no longer available/)
  })

  await withFakeProvider((body, count) => (
    count === 1
      ? { status: 503, payload: { error: { message: 'high demand' } } }
      : { payload: { choices: [{ message: { content: '{"ok":true}' } }] } }
  ), async (baseUrl, requests) => {
    setAiProviderCredentialsStore({ custom: { apiKey: 'k', baseUrl, model: 'm' } })
    const result = await callAgentJson({ providerId: 'custom', systemPrompt: 's', userPrompt: 'u' })
    assert.deepEqual(result.json, { ok: true })
    assert.equal(requests.length, 2)
  })
  setAiProviderCredentialsStore({})
})

test('callAgentJson: a reply truncated by the token limit is a clear error, not a JSON parse failure', async () => {
  const { setAiProviderCredentialsStore } = await import('../server/strategy/ai-provider-credentials-store.js')
  const { callAgentJson } = await import('../server/ai-trading/llm.js')

  await withFakeProvider((body) => {
    assert.equal(body.max_tokens, 4096)
    return { payload: { choices: [{ finish_reason: 'length', message: { content: '{\n  "action": "HOLD",\n' } }] } }
  }, async (baseUrl) => {
    setAiProviderCredentialsStore({ custom: { apiKey: 'k', baseUrl, model: 'm' } })
    await assert.rejects(() => callAgentJson({ providerId: 'custom', systemPrompt: 's', userPrompt: 'u' }), /cut off/)
  })
  setAiProviderCredentialsStore({})
})

test('buildMarketSnapshot: drops the still-forming candle so agents only ever see closed bars', () => {
  // Higher-timeframe bars on a compatible (earlier) timeline so only the forming 5M bar is in play.
  const inputs = { ...marketInputs(), bias: synthCandles(120, { base: 100, trend: 0.1, noise: 0.6, seed: 9, step: 1000 }), higher: [] }
  const entry = inputs.entry
  const forming = { ...entry.at(-1), time: entry.at(-1).closeTime + 1, closeTime: entry.at(-1).closeTime + 300_000, volume: 0.01 }
  const nowMs = entry.at(-1).closeTime + 60_000 // one minute into the forming candle

  const withForming = buildMarketSnapshot({ symbol: 'BTCUSDT', ...inputs, entry: [...entry, forming], nowMs })
  const closedOnly = buildMarketSnapshot({ symbol: 'BTCUSDT', ...inputs, entry, nowMs })
  assert.equal(withForming.candleCloseTime, entry.at(-1).closeTime)
  assert.equal(withForming.price, closedOnly.price)
  assert.equal(withForming.indicators.relVol, closedOnly.indicators.relVol)
  assert.ok(withForming.indicators.relVol > 0.3, 'volume must not collapse to ~0x from a forming bar')
})

// ---- Market Flow Agent ----------------------------------------------------

test('parseFlowOutput validates the verdict and tolerates a missing crowding label', () => {
  assert.equal(parseFlowOutput({ verdict: 'against', crowding: 'high', flags: [{ issue: 'x', severity: 'HIGH' }, { issue: '' }] }).crowding, 'HIGH')
  assert.equal(parseFlowOutput({ verdict: 'supports' }).crowding, null)
  assert.equal(parseFlowOutput({ verdict: 'NEUTRAL', flags: [{ issue: 'y' }] }).flags[0].severity, 'medium')
  assert.throws(() => parseFlowOutput({ verdict: 'BULLISH' }), /invalid verdict/)
})

test('classifyOiPriceRegime: the four price-vs-open-interest quadrants, and flat markets', () => {
  assert.match(classifyOiPriceRegime(1, 2), /new longs/)
  assert.match(classifyOiPriceRegime(1, -2), /short covering/)
  assert.match(classifyOiPriceRegime(-1, 2), /new shorts/)
  assert.match(classifyOiPriceRegime(-1, -2), /long liquidation/)
  assert.match(classifyOiPriceRegime(0.02, 2), /no clear signal/)
  assert.match(classifyOiPriceRegime(1, 0.05), /no clear signal/)
  assert.equal(classifyOiPriceRegime(null, 2), null)
})

// 5m rows oldest-first, price and OI both rising steadily over ~4h.
const flowFixture = () => {
  const entry = synthCandles(120, { base: 100, trend: 0.03, noise: 0.05, seed: 3 }).map((candle) => ({ ...candle, takerBuyBaseVolume: candle.volume * 0.6 }))
  const oiHist = Array.from({ length: 48 }, (_, i) => ({ timestamp: i * 300_000, sumOpenInterestValue: String(1_000_000_000 * (1 + i * 0.001)) }))
  return {
    entry,
    premium: { lastFundingRate: '0.0001', markPrice: '100.20', indexPrice: '100.00' },
    oiHist,
    globalLs: [{ longShortRatio: '1.0', timestamp: 1 }, { longShortRatio: '2.0', timestamp: 2 }],
    topLs: [{ longShortRatio: '1.5', timestamp: 1 }],
    taker: Array.from({ length: 12 }, (_, i) => ({ buySellRatio: '1.2', timestamp: i })),
    orderBook: { bids: [['100', '30'], ['99.9', '30']], asks: [['100.1', '20'], ['100.2', '20']] },
    btcCandles: synthCandles(60, { base: 80000, trend: -20, noise: 5, seed: 5 }),
  }
}

test('summarizeFlow: derives funding, OI change, regime, positioning, taker flow, book and BTC metrics', () => {
  const { metrics, derivativesSources } = summarizeFlow(flowFixture())
  assert.equal(derivativesSources, 5)
  assert.equal(metrics.fundingRatePct, 0.01)
  assert.equal(metrics.fundingAnnualizedPct, 10.9)
  assert.equal(metrics.markIndexBasisPct, 0.2)
  assert.equal(metrics.oiChange4hPct, 4.7) // 47 steps of +0.1% on the base
  assert.ok(metrics.oiChange1hPct > 1)
  assert.equal(metrics.longShortRatio, 2)
  assert.equal(metrics.longAccountPct, 66.7)
  assert.equal(metrics.longShortRatioChange, 1)
  assert.equal(metrics.topTraderLongShortRatio, 1.5)
  assert.equal(metrics.takerBuySellRatio1h, 1.2)
  assert.equal(metrics.candleTakerBuySharePct, 60)
  assert.equal(metrics.bookImbalance, 1.5)
  assert.ok(metrics.btcChange1hPct < 0, 'BTC was falling in the fixture')
  assert.match(metrics.oiPriceRegime, /new longs/)
  assert.match(describeFlow(metrics).join('\n'), /new longs opening/)
})

test('summarizeFlow: missing sources leave nulls (and "unavailable" in the prompt) rather than invented numbers', () => {
  const { metrics, derivativesSources } = summarizeFlow({ entry: flowFixture().entry, premium: { lastFundingRate: '0.0002' } })
  assert.equal(derivativesSources, 1)
  assert.equal(metrics.openInterestUsd, null)
  assert.equal(metrics.longShortRatio, null)
  assert.equal(metrics.btcChange1hPct, null)
  assert.match(describeFlow(metrics).join('\n'), /Open interest: unavailable/)
})

test('collectFlowData: tolerates individual endpoint failures but refuses to run on too little data', async () => {
  const fx = flowFixture()
  const responses = {
    '/fapi/v1/premiumIndex': fx.premium,
    '/futures/data/openInterestHist': fx.oiHist,
    '/futures/data/globalLongShortAccountRatio': fx.globalLs,
    '/futures/data/topLongShortPositionRatio': fx.topLs,
    '/futures/data/takerlongshortRatio': fx.taker,
  }
  const makeFetch = (failing = []) => async (url) => {
    const path = new URL(url).pathname
    if (failing.includes(path)) throw new Error('HTTP 418')
    return responses[path]
  }

  const partial = await collectFlowData({ symbol: 'ETHUSDT', baseUrl: 'https://fapi.example', fetchJson: makeFetch(['/futures/data/topLongShortPositionRatio', '/futures/data/takerlongshortRatio']), entry: fx.entry })
  assert.equal(partial.derivativesSources, 3)
  assert.equal(partial.metrics.topTraderLongShortRatio, null)
  assert.equal(partial.metrics.longShortRatio, 2)

  await assert.rejects(
    () => collectFlowData({ symbol: 'ETHUSDT', baseUrl: 'https://fapi.example', fetchJson: makeFetch(Object.keys(responses).slice(1)), entry: fx.entry }),
    /only 1 of 5 derivatives sources/,
  )
})

test('summarizeFlow: taker buy/sell ratio is volume-weighted, not an average of per-candle ratios', () => {
  // One huge sell candle and several tiny buy candles: the plain mean of ratios says "buying", the volume says "selling".
  const taker = [
    { buySellRatio: '0.5', buyVol: '500', sellVol: '1000', timestamp: 1 },
    ...Array.from({ length: 5 }, (_, i) => ({ buySellRatio: '2.0', buyVol: '20', sellVol: '10', timestamp: 2 + i })),
  ]
  const { metrics } = summarizeFlow({ entry: flowFixture().entry, taker })
  assert.equal(metrics.takerBuySellRatio1h, 0.57) // 600 / 1050
})

// ---- Browse Models catalog ------------------------------------------------

test('normalizeOpenRouterModels: free detection, pricing per million, chat vs non-chat, capability flags', async () => {
  const { normalizeOpenRouterModels } = await import('../server/ai-models/catalog.js')
  const rows = normalizeOpenRouterModels({ data: [
    { id: 'acme/free-model:free', name: 'Acme Free', context_length: 131072, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['response_format', 'reasoning'], created: 1700000000, description: '  A   free\nmodel ' },
    { id: 'acme/paid', name: 'Acme Paid', context_length: 8192, pricing: { prompt: '0.0000005', completion: '0.0000015' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] },
    { id: 'openrouter/free', name: 'Free Router', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [] },
    { id: 'google/lyria', name: 'Lyria', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] }, supported_parameters: [] },
    { id: 'acme/painter', name: 'Painter', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text'], output_modalities: ['image', 'text'] }, supported_parameters: [] },
    { name: 'no id' },
  ] })
  assert.equal(rows.length, 5, 'a row without an id is dropped')
  const [free, paid, router, lyria, painter] = rows
  assert.equal(free.free, true)
  assert.deepEqual(paid.pricePerMillion, { input: 0.5, output: 1.5 })
  assert.equal(paid.free, false)
  assert.equal(paid.vision, true)
  assert.equal(paid.jsonMode, true, 'structured_outputs counts as JSON support')
  assert.equal(free.jsonMode, true)
  assert.equal(free.reasoning, true)
  assert.equal(free.description, 'A free model')
  assert.equal(router.free, true)
  assert.equal(router.jsonMode, false)
  assert.equal(lyria.kind, 'other', 'audio generation is not a chat model even when free')
  assert.equal(painter.kind, 'other', 'image generation is not a chat model')
  assert.equal(free.kind, 'chat')
  assert.equal(free.created, 1700000000000)
})

test('normalizeOpenAiCompatibleModels / Anthropic: Google "models/" prefix stripped, non-chat models flagged', async () => {
  const { normalizeAnthropicModels, normalizeOpenAiCompatibleModels } = await import('../server/ai-models/catalog.js')
  const rows = normalizeOpenAiCompatibleModels({ data: [{ id: 'models/gemini-3.5-flash' }, { id: 'models/gemini-3.1-flash-tts-preview' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4.1', created: 1700000000 }] }, 'google')
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [['gemini-3.5-flash', 'chat'], ['gemini-3.1-flash-tts-preview', 'other'], ['text-embedding-3-small', 'other'], ['gpt-4.1', 'chat']])
  assert.equal(rows.every((row) => row.providerId === 'google'), true)
  const claude = normalizeAnthropicModels({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-01-01T00:00:00Z' }] })
  assert.deepEqual([claude[0].id, claude[0].name, claude[0].kind], ['claude-sonnet-5', 'Claude Sonnet 5', 'chat'])
})

test('listProviderModels: live list with the key server-side, caching, key-change invalidation, and honest fallbacks', async () => {
  const { clearCatalogCache, listProviderModels } = await import('../server/ai-models/catalog.js')
  clearCatalogCache()

  await withFakeProvider((body, count) => ({ payload: { data: [{ id: 'models/live-model' }] } }), async (baseUrl, requests) => {
    const first = await listProviderModels('google', { apiKey: 'key-1', baseUrl })
    assert.equal(first.source, 'live')
    assert.equal(first.connected, true)
    assert.deepEqual(first.models.map((model) => model.id), ['live-model'])
    assert.equal(requests[0].url, '/models')
    assert.equal(requests[0].headers.authorization, 'Bearer key-1')
    assert.ok(!JSON.stringify(first).includes('key-1'), 'the key must never appear in what is returned')

    await listProviderModels('google', { apiKey: 'key-1', baseUrl })
    assert.equal(requests.length, 1, 'second call is served from cache')
    await listProviderModels('google', { apiKey: 'key-2', baseUrl })
    assert.equal(requests.length, 2, 'a different key must not reuse the cached list')
    await listProviderModels('google', { apiKey: 'key-2', baseUrl }, { force: true })
    assert.equal(requests.length, 3, 'refresh bypasses the cache')
  })

  clearCatalogCache()
  const unconnected = await listProviderModels('openai', null)
  assert.equal(unconnected.source, 'catalog')
  assert.equal(unconnected.connected, false)
  assert.ok(unconnected.models.length > 0 && unconnected.models.every((model) => model.providerId === 'openai'))

  const azure = await listProviderModels('azure-openai', { apiKey: 'k', baseUrl: 'https://x' })
  assert.equal(azure.source, 'catalog')
  assert.match(azure.error, /no model-list endpoint/)

  await withFakeProvider(() => ({ status: 401, payload: { error: { message: 'bad key' } } }), async (baseUrl) => {
    const failed = await listProviderModels('groq', { apiKey: 'nope', baseUrl })
    assert.equal(failed.source, 'catalog', 'a failing list falls back to suggestions instead of an empty page')
    assert.match(failed.error, /bad key/)
    assert.ok(failed.models.length > 0)
  })
  clearCatalogCache()
})

test('listProviderModels: keyless local providers are only "connected" once a URL is saved; misplaced keys get a hint', async () => {
  const { clearCatalogCache, listProviderModels, misplacedKeyHint } = await import('../server/ai-models/catalog.js')
  clearCatalogCache()
  const unsaved = await listProviderModels('ollama', null)
  assert.equal(unsaved.connected, false, 'the default localhost URL alone must not count as connected')
  assert.equal(unsaved.source, 'catalog')

  assert.match(misplacedKeyHint('openai', 'sk-or-v1-abc'), /OpenRouter key.*save it under OpenRouter/)
  assert.match(misplacedKeyHint('openai', 'sk-ant-abc'), /Anthropic/)
  assert.match(misplacedKeyHint('openai', 'AIzaSy123'), /Google/)
  assert.equal(misplacedKeyHint('openrouter', 'sk-or-v1-abc'), '', 'a correctly placed key gets no hint')
  assert.equal(misplacedKeyHint('openai', 'sk-proj-abc'), '')

  await withFakeProvider(() => ({ status: 401, payload: { error: { message: 'Incorrect API key provided' } } }), async (baseUrl) => {
    const wrongSlot = await listProviderModels('openai', { apiKey: 'sk-or-v1-abc', baseUrl })
    assert.match(wrongSlot.error, /Incorrect API key.*OpenRouter key/)
  })
  clearCatalogCache()
})

test('redactSecrets strips key-shaped tokens from provider error messages, and leaves ordinary text alone', async () => {
  const { redactSecrets } = await import('../server/ai-trading/llm.js')
  const echoed = 'Incorrect API key provided: sk-or-v1*************************e47a. You can find your API key at https://platform.openai.com/account/api-keys.'
  const cleaned = redactSecrets(echoed)
  assert.ok(!cleaned.includes('e47a') && !cleaned.includes('sk-or-v1'))
  assert.match(cleaned, /\[redacted key\]\. You can find your API key at https:\/\/platform\.openai\.com/)
  assert.equal(redactSecrets('invalid x-api-key sk-ant-api03-abcdefghijklmnop'), 'invalid x-api-key [redacted key]')
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer [redacted]')
  assert.equal(redactSecrets('API key AIzaSyABCDEFGH12345 expired'), 'API key [redacted key] expired')
  assert.equal(redactSecrets('This model is currently experiencing high demand.'), 'This model is currently experiencing high demand.')
  assert.equal(redactSecrets('Model gemini-3.5-flash is no longer available'), 'Model gemini-3.5-flash is no longer available')
  assert.equal(redactSecrets(undefined), '')

  // End to end: a provider that echoes the key in a 401 must not leak it through the catalog or the caller.
  const { callAgentJson } = await import('../server/ai-trading/llm.js')
  const { setAiProviderCredentialsStore } = await import('../server/strategy/ai-provider-credentials-store.js')
  const { clearCatalogCache, listProviderModels } = await import('../server/ai-models/catalog.js')
  clearCatalogCache()
  await withFakeProvider(() => ({ status: 401, payload: { error: { message: 'Incorrect API key provided: sk-or-v1****e47a.' } } }), async (baseUrl) => {
    const listed = await listProviderModels('openai', { apiKey: 'sk-or-v1-secret', baseUrl })
    assert.ok(!listed.error.includes('e47a'), listed.error)
    setAiProviderCredentialsStore({ custom: { apiKey: 'k', baseUrl, model: 'm' } })
    await assert.rejects(() => callAgentJson({ providerId: 'custom', systemPrompt: 's', userPrompt: 'u' }), (error) => !error.message.includes('e47a'))
  })
  setAiProviderCredentialsStore({})
  clearCatalogCache()
})

test('describeProviderError: surfaces the upstream reason OpenRouter hides in metadata', () => {
  assert.equal(describeProviderError({ error: { message: 'Bad key' } }, 401), 'Bad key')
  assert.equal(describeProviderError([{ error: { message: 'Quota exceeded' } }], 429), 'Quota exceeded')
  assert.equal(describeProviderError({}, 502), 'HTTP 502')
  assert.equal(
    describeProviderError({ error: { message: 'Provider returned error', metadata: { provider_name: 'Z.AI', raw: 'rate limit exceeded: free-models-per-min' } } }, 429),
    'Provider returned error (Z.AI: rate limit exceeded: free-models-per-min)',
  )
  assert.match(describeProviderError({ error: { message: 'Provider returned error', metadata: { raw: { error: { message: 'model overloaded' } } } } }, 502), /model overloaded/)
})

// ---- Codex as an agent provider ----------------------------------------------------------------------------------

test('codex provider: agent-only, needs no key, and can be assigned to an agent', () => {
  const provider = getAiProvider('codex')
  assert.equal(provider.agentOnly, true)
  assert.equal(provider.localLogin, true)
  assert.equal(resolveProviderCall('codex').configured, true, 'no key / base URL / model is required for the machine login')
  assert.equal(resolveProviderCall('codex', ' gpt-x ').model, 'gpt-x')
  assert.equal(normalizeAiTradingConfig({ agents: { analyst: { providerId: 'codex', model: '' } } }).agents.analyst.providerId, 'codex')
})

function fakeCodex({ reply = '{"ok":true}', hang = false } = {}) {
  const seen = {}
  class Codex {
    constructor(options) { seen.constructorOptions = options }
    startThread(options) {
      seen.threadOptions = options
      return {
        run: (prompt, turnOptions) => {
          seen.prompt = prompt
          return new Promise((resolve, reject) => {
            if (!hang) return resolve({ finalResponse: reply })
            turnOptions.signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
        },
      }
    }
  }
  return { seen, loadModule: async () => ({ Codex }) }
}

test('runCodexAgent: read-only, no approvals/network, scratch dir instead of the project, no-tools note, optional model', async () => {
  const { seen, loadModule } = fakeCodex({ reply: '{"action":"HOLD"}' })
  const text = await runCodexAgent({ systemPrompt: 'SYS', userPrompt: 'USER', model: '' }, { loadModule, hasLogin: async () => true })
  assert.equal(text, '{"action":"HOLD"}')
  assert.equal(seen.threadOptions.sandboxMode, 'read-only')
  assert.equal(seen.threadOptions.approvalPolicy, 'never')
  assert.equal(seen.threadOptions.networkAccessEnabled, false)
  assert.equal(seen.threadOptions.webSearchMode, 'disabled')
  assert.ok(!('model' in seen.threadOptions), 'a blank model uses Codex\'s own default')
  assert.ok(!seen.threadOptions.workingDirectory.includes('xenios/app'), 'must not be pointed at the project (it holds .env)')
  assert.match(seen.prompt, /SYS[\s\S]*USER[\s\S]*Do not run commands/)

  const named = fakeCodex()
  await runCodexAgent({ systemPrompt: 's', userPrompt: 'u', model: 'gpt-x' }, { loadModule: named.loadModule, hasLogin: async () => true })
  assert.equal(named.seen.threadOptions.model, 'gpt-x')
})

test('runCodexAgent: not logged in / SDK missing are NOT_CONFIGURED, and a hung turn is aborted at the timeout', async () => {
  await assert.rejects(
    runCodexAgent({ systemPrompt: 's', userPrompt: 'u' }, { loadModule: fakeCodex().loadModule, hasLogin: async () => false }),
    (error) => error.code === 'NOT_CONFIGURED' && /codex login/.test(error.message),
  )
  await assert.rejects(
    runCodexAgent({ systemPrompt: 's', userPrompt: 'u' }, { loadModule: async () => null, hasLogin: async () => true }),
    (error) => error.code === 'NOT_CONFIGURED' && /not installed/.test(error.message),
  )
  await assert.rejects(
    runCodexAgent({ systemPrompt: 's', userPrompt: 'u', timeoutMs: 30 }, { loadModule: fakeCodex({ hang: true }).loadModule, hasLogin: async () => true }),
    /Codex timed out after 0s/,
  )
  const status = await getCodexAgentStatus({ loadModule: fakeCodex().loadModule, hasLogin: async () => true })
  assert.deepEqual(status, { available: true, loggedIn: true })
})

// ---- Claude (Agent SDK) as an agent provider ---------------------------------------------------------------------

test('claude provider: agent-only, needs no key, is separate from the API-key Anthropic provider, and can be assigned', () => {
  const provider = getAiProvider('claude')
  assert.equal(provider.agentOnly, true)
  assert.equal(provider.localLogin, true)
  assert.equal(getAiProvider('anthropic').localLogin, undefined)
  assert.equal(resolveProviderCall('claude').configured, true)
  assert.equal(resolveProviderCall('claude', ' claude-x ').model, 'claude-x')
  assert.equal(normalizeAiTradingConfig({ agents: { manager: { providerId: 'claude', model: '' } } }).agents.manager.providerId, 'claude')
  assert.equal(isLocalLoginReady({ claude: { available: true, loggedIn: true } }, 'claude'), true)
  assert.equal(isLocalLoginReady({ claude: { available: true, loggedIn: false } }, 'claude'), false)
  assert.equal(isLocalLoginReady(null, 'claude'), false)
})

function fakeClaude({ reply = '{"ok":true}', hang = false, subtype = 'success' } = {}) {
  const seen = {}
  return {
    seen,
    loadModule: async () => ({
      query: ({ prompt, options }) => {
        seen.prompt = prompt
        seen.options = options
        return (async function* () {
          yield { type: 'system', subtype: 'init' }
          if (hang) await new Promise((_resolve, reject) => options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted'))))
          yield { type: 'result', subtype, is_error: subtype !== 'success', result: reply }
        })()
      },
    }),
  }
}

test('runClaudeAgent: no tools/settings/MCP, scratch dir instead of the project, no API key in the env, optional model', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-should-not-leak'
  try {
    const { seen, loadModule } = fakeClaude({ reply: '{"action":"HOLD"}' })
    const text = await runClaudeAgent({ systemPrompt: 'SYS', userPrompt: 'USER', model: '' }, { loadModule, hasLogin: async () => true })
    assert.equal(text, '{"action":"HOLD"}')
    assert.deepEqual(seen.options.tools, [])
    assert.deepEqual(seen.options.settingSources, [])
    assert.equal(seen.options.strictMcpConfig, true)
    assert.equal(seen.options.persistSession, false)
    assert.equal(seen.options.systemPrompt, 'SYS')
    assert.ok(!('model' in seen.options), 'a blank model uses Claude\'s own default')
    assert.ok(!seen.options.cwd.includes('xenios/app'), 'must not be pointed at the project (it holds .env)')
    assert.ok(!('ANTHROPIC_API_KEY' in seen.options.env), 'this provider is the login, never a pay-per-token key')
    assert.match(seen.prompt, /USER[\s\S]*Do not run commands/)

    const named = fakeClaude()
    await runClaudeAgent({ systemPrompt: 's', userPrompt: 'u', model: 'claude-x' }, { loadModule: named.loadModule, hasLogin: async () => true })
    assert.equal(named.seen.options.model, 'claude-x')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
  }
})

test('runClaudeAgent: not logged in / SDK missing are NOT_CONFIGURED, failures surface, and a hung run is aborted at the timeout', async () => {
  await assert.rejects(
    runClaudeAgent({ systemPrompt: 's', userPrompt: 'u' }, { loadModule: fakeClaude().loadModule, hasLogin: async () => false }),
    (error) => error.code === 'NOT_CONFIGURED' && /claude login/.test(error.message),
  )
  await assert.rejects(
    runClaudeAgent({ systemPrompt: 's', userPrompt: 'u' }, { loadModule: async () => null, hasLogin: async () => true }),
    (error) => error.code === 'NOT_CONFIGURED' && /not installed/.test(error.message),
  )
  await assert.rejects(
    runClaudeAgent({ systemPrompt: 's', userPrompt: 'u' }, { loadModule: fakeClaude({ subtype: 'error_max_turns', reply: 'too many turns' }).loadModule, hasLogin: async () => true }),
    /too many turns/,
  )
  await assert.rejects(
    runClaudeAgent({ systemPrompt: 's', userPrompt: 'u', timeoutMs: 30 }, { loadModule: fakeClaude({ hang: true }).loadModule, hasLogin: async () => true }),
    /Claude timed out after 0s/,
  )
  assert.deepEqual(await getClaudeAgentStatus({ loadModule: fakeClaude().loadModule, hasLogin: async () => true }), { available: true, loggedIn: true })
})

// ---- Test mode (testnet-only pipeline check) ----------------------------------------------------------------------

test('test mode: off by default, needs an explicit true, and honoured in either mode (the server resets it on a mode switch)', () => {
  assert.equal(normalizeAiTradingConfig(null).scan.testMode, false)
  assert.equal(normalizeAiTradingConfig({ scan: { testMode: true } }).scan.testMode, true, 'default mode is testnet')
  assert.equal(normalizeAiTradingConfig({ scan: { testMode: 'true' } }).scan.testMode, false, 'needs an explicit true')
  assert.equal(normalizeAiTradingConfig({ execution: { mode: 'real' }, scan: { testMode: true } }).scan.testMode, true, 'real money is allowed, on purpose')
})

test('test mode: changes the Analyst, Critic and Risk prompts; Flow wording and the code gates are untouched', async () => {
  const testCfg = normalizeAiTradingConfig({ scan: { testMode: true } })
  const seen = { normal: {}, test: {} }
  for (const [key, cfg] of [['normal', config], ['test', testCfg]]) {
    const fake = fakeAgents()
    const spy = async (call) => {
      const role = /You are the Market Analyst\./.test(call.systemPrompt) ? 'analyst' : /Market Flow Agent\./.test(call.systemPrompt) ? 'flow' : /You are the Critic\./.test(call.systemPrompt) ? 'critic' : 'risk'
      seen[key][role] = `${call.systemPrompt}\n${call.userPrompt}`
      return fake.callAgent(call)
    }
    const result = await runAiTradingPipeline({ symbol: 'BTCUSDT', config: cfg, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA, callAgent: spy, backtestStats: positiveStats })
    assert.equal(result.testMode, key === 'test')
  }
  assert.doesNotMatch(seen.normal.analyst, /TEST MODE/)
  assert.match(seen.normal.analyst, /genuine edge/)
  assert.match(seen.test.analyst, /TEST MODE/)
  assert.doesNotMatch(seen.test.analyst, /HOLD \/ rejecting is a good outcome/)
  assert.equal(seen.test.flow, seen.normal.flow, 'the Flow prompt must not change in test mode')
  assert.doesNotMatch(seen.test.flow, /TEST MODE/)
  assert.match(seen.test.risk, /TEST MODE[\s\S]*VETO only if the trade is clearly unacceptable[\s\S]*size SMALL/)
  assert.doesNotMatch(seen.test.risk, /rejecting is a good outcome/, 'the skeptical preamble is replaced, not stacked')
  assert.doesNotMatch(seen.normal.risk, /TEST MODE/)
  assert.match(seen.test.risk, /Fixed ceilings and gates are enforced in code/)
  assert.match(seen.test.risk, /Fixed ceilings \(enforced in code/, 'the ceilings are still listed to the Risk Manager')
  assert.match(seen.test.critic, /TEST MODE[\s\S]*REJECT only for a serious flaw/)
  assert.doesNotMatch(seen.test.critic, /rejecting is a good outcome/, 'the skeptical preamble is replaced, not stacked')
  assert.doesNotMatch(seen.normal.critic, /TEST MODE/)
  // The normal Critic is still adversarial (it must attack the setup and cite evidence) but it is no longer told its only job is to reject
  assert.match(seen.normal.critic, /adversarial reviewer, not a veto machine/)
  assert.match(seen.normal.critic, /find what could make this trade wrong/)
  assert.match(seen.normal.critic, /Attack the setup/)
  assert.match(seen.normal.critic, /cite a specific number or level/)
  assert.doesNotMatch(seen.normal.critic, /Your only job is to find reasons|Do not argue in its favour|rejecting is a good outcome/)
})

test('critic prompt: the Analyst\'s stop/target are provisional (the Risk Manager resizes them), in normal mode too', async () => {
  const { prompts } = await run()
  assert.match(prompts.critic, /provisional proposal[\s\S]*do not REJECT because the proposed stop or target/)
  assert.doesNotMatch(prompts.critic, /stops that sit inside normal noise/)
})

test('test mode: a Critic REJECT still blocks the trade (only the Analyst is relaxed)', async () => {
  const cfg = normalizeAiTradingConfig({ scan: { testMode: true } })
  const { result } = await run({ cfg, agents: { critic: { verdict: 'REJECT', objections: [{ issue: 'x', severity: 'high' }], reasoning: 'No.' } } })
  assert.equal(result.final.approved, false)
})

test('test mode: the code ceilings still cap a permissive Risk Manager (leverage/risk clamped, weak reward:risk rejected)', async () => {
  const cfg = normalizeAiTradingConfig({ scan: { testMode: true } })
  const greedy = { decision: 'APPROVE', confidence: 75, stopLossPercent: 1.5, takeProfitPercent: 4, riskPercent: 50, leverage: 100, concerns: [], reasoning: 'Go big.' }
  const { result } = await run({ cfg, agents: { risk: greedy } })
  const plan = result.stages.find((stage) => stage.id === 'risk').output.plan
  // Test mode raises the leverage ceiling to 10x (and floors leverage at it), so 100x is clamped to that, not to the normal 5x.
  const { riskLimitsFor } = await import('../server/ai-trading/pipeline.js')
  const testCeiling = riskLimitsFor(cfg).maxLeverage
  assert.equal(testCeiling, 10)
  assert.equal(plan.leverage, testCeiling, `leverage ${plan.leverage} must be clamped to the ${testCeiling}x test-mode ceiling`)
  assert.ok(plan.riskPctOfEquity <= LIMITS.riskPerTradePct + 1e-9, `risk ${plan.riskPctOfEquity}% must be clamped to ${LIMITS.riskPerTradePct}%`)

  const poorRr = { decision: 'APPROVE', confidence: 75, stopLossPercent: 1.5, takeProfitPercent: 1.6, riskPercent: 1, leverage: 2, concerns: [], reasoning: 'Tiny target.' }
  const rejected = await run({ cfg, agents: { risk: poorRr } })
  assert.equal(rejected.result.stages.find((stage) => stage.id === 'risk').output.approved, false, 'reward:risk below the ceiling is still rejected in test mode')
  assert.equal(rejected.result.final.approved, false)
})

// ---- Custom OpenAI-compatible slots ---------------------------------------------------------------------------------

test('custom slots: the API key is optional, no Authorization header is sent without one, and each slot is separate', async () => {
  const { setAiProviderCredentialsStore } = await import('../server/strategy/ai-provider-credentials-store.js')
  const { callAgentJson, resolveProviderCall } = await import('../server/ai-trading/llm.js')

  await withFakeProvider((body) => ({ payload: { choices: [{ message: { content: JSON.stringify({ model: body.model }) } }] } }), async (baseUrl, requests) => {
    setAiProviderCredentialsStore({
      custom: { apiKey: '', baseUrl, model: 'local-a' },
      'custom-2': { apiKey: 'second-key', baseUrl, model: 'local-b', label: 'Second' },
    })

    const first = await callAgentJson({ providerId: 'custom', systemPrompt: 's', userPrompt: 'u' })
    assert.deepEqual(first.json, { model: 'local-a' })
    assert.equal(requests[0].headers.authorization, undefined)

    const second = await callAgentJson({ providerId: 'custom-2', systemPrompt: 's', userPrompt: 'u' })
    assert.deepEqual(second.json, { model: 'local-b' })
    assert.equal(requests[1].headers.authorization, 'Bearer second-key')
  })

  setAiProviderCredentialsStore({})
  assert.match(resolveProviderCall('custom').reason, /base URL/)
  // A hosted provider still needs its key.
  assert.match(resolveProviderCall('openai').reason, /API key/)
})

// ---- Test-mode minimum leverage ---------------------------------------------------------------------------------------

test('test mode: leverage is floored at 10x on testnet only, with the same risk and a smaller margin', async () => {
  const { riskLimitsFor, reviewRiskProposal } = await import('../server/ai-trading/pipeline.js')

  const off = normalizeAiTradingConfig(null)
  const on = normalizeAiTradingConfig({ scan: { testMode: true } })
  const real = normalizeAiTradingConfig({ execution: { mode: 'real' }, scan: { testMode: true } })
  assert.equal(riskLimitsFor(off).minLeverage, undefined)
  assert.equal(riskLimitsFor(off).maxLeverage, LIMITS.maxLeverage)
  assert.equal(riskLimitsFor(real).minLeverage, undefined, 'never in real-money mode')
  assert.equal(riskLimitsFor(on).minLeverage, 10)
  assert.equal(riskLimitsFor(on).maxLeverage, 10)

  const base = { side: 'LONG', price: 100, atrPct: 0.3, stopLossPct: 1, takeProfitPct: 2 }
  const normal = runRiskManager({ ...base, limits: riskLimitsFor(off) })
  const floored = runRiskManager({ ...base, limits: riskLimitsFor(on) })
  assert.equal(normal.plan.leverage, 1)
  assert.equal(floored.plan.leverage, 10)
  assert.equal(floored.plan.notionalUsdt, normal.plan.notionalUsdt, 'position size unchanged')
  assert.equal(floored.plan.maxLossUsdt, normal.plan.maxLossUsdt, 'risk unchanged')
  assert.equal(floored.plan.marginUsdt, normal.plan.marginUsdt / 10)
  assert.ok(floored.adjustments.some((note) => /minimum/.test(note)))

  // A model that answers leverage 0 (or asks for less) still ends up at the floor; one that asks for more is capped at the ceiling.
  const proposal = (leverage) => ({ decision: 'APPROVE', stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage, concerns: [], reasoning: 'x' })
  for (const [asked, expected] of [[0, 10], [3, 10], [10, 10], [50, 10]]) {
    const result = reviewRiskProposal({ proposal: proposal(asked), side: 'LONG', price: 100, atrPct: 0.3, limits: riskLimitsFor(on) })
    assert.equal(result.plan.leverage, expected, `asked ${asked}x`)
  }
  // Off: the model's number is only a ceiling and the plan stays at the sized 1x.
  assert.equal(reviewRiskProposal({ proposal: proposal(0), side: 'LONG', price: 100, atrPct: 0.3, limits: riskLimitsFor(off) }).plan.leverage, 1)
})

// ---- Exchange minimum order: what the Risk Manager is told, and the early veto ----------------------------------------

test('exchange minimum: the Risk Manager is told the minimum order and margin, and a reachable trade stays approved with a note', async () => {
  const { reviewRiskProposal } = await import('../server/ai-trading/pipeline.js')
  const fake = fakeAgents()
  const constraints = { mode: 'real', minOrderUsdt: 21, marginCapUsdt: 9.99, availableUsdt: 40 }
  const result = await runAiTradingPipeline({
    symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA,
    getTradeConstraints: async () => constraints, callAgent: fake.callAgent, backtestStats: positiveStats,
  })
  assert.match(fake.prompts.risk, /Exchange minimum order for BTCUSDT: 21\.00 USDT/)
  assert.match(fake.prompts.risk, /Margin you may use on this trade: 9\.99 USDT/)
  assert.match(fake.prompts.risk, /the code raises leverage to reach it/)
  assert.equal(result.constraints.minOrderUsdt, 21)

  // review level: an approved plan below the minimum gets a leverage-raise note and stays approved
  const proposal = { decision: 'APPROVE', confidence: 75, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'x' }
  const reviewed = reviewRiskProposal({ proposal, side: 'LONG', price: 100, atrPct: 0.3, limits: LIMITS, constraints })
  assert.equal(reviewed.approved, true)
  assert.equal(reviewed.exchangeFit.changed, true)
  assert.ok(reviewed.adjustments.some((note) => /leverage raised to \dx/.test(note)))
})

test('exchange minimum: an unreachable trade is vetoed by the Risk Manager stage, with the reason, before any order', async () => {
  const { reviewRiskProposal } = await import('../server/ai-trading/pipeline.js')
  const proposal = { decision: 'APPROVE', confidence: 75, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'x' }
  // an 83 USDT minimum on a 9.99 margin cap needs 9x; the ceiling is 5x
  const constraints = { mode: 'real', minOrderUsdt: 83, marginCapUsdt: 9.99, availableUsdt: 40 }
  const reviewed = reviewRiskProposal({ proposal, side: 'LONG', price: 100, atrPct: 0.3, limits: LIMITS, constraints })
  assert.equal(reviewed.approved, false)
  assert.equal(reviewed.plan, null)
  assert.match(reviewed.vetoReasons[0], /needs \d+x leverage, above the 5x ceiling/)

  // and through the whole pipeline the run is not approved, with that reason on the Risk Manager stage
  const fake = fakeAgents()
  const result = await runAiTradingPipeline({
    symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA,
    getTradeConstraints: async () => constraints, callAgent: fake.callAgent, backtestStats: positiveStats,
  })
  assert.equal(result.final.approved, false)
  assert.match(JSON.stringify(result.stages.find((stage) => stage.id === 'risk')), /ceiling/)
  assert.match(fake.prompts.risk, /could NOT be placed/)
})

test('exchange minimum: without constraints (lookup missing or failing) nothing changes for the Risk Manager', async () => {
  const baseline = fakeAgents()
  await runAiTradingPipeline({ symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA, callAgent: baseline.callAgent, backtestStats: positiveStats })
  const failing = fakeAgents()
  const result = await runAiTradingPipeline({
    symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA,
    getTradeConstraints: async () => { throw new Error('exchange unreachable') }, callAgent: failing.callAgent, backtestStats: positiveStats,
  })
  assert.equal(failing.prompts.risk, baseline.prompts.risk)
  assert.equal(result.constraints, undefined)
  assert.doesNotMatch(baseline.prompts.risk, /Exchange minimum order/)
})

// ---- Risk Manager role prompt ------------------------------------------------------------------------------------------

async function captureCalls(cfg, constraints) {
  const fake = fakeAgents()
  const seen = {}
  const spy = async (call) => {
    const role = /You are the Market Analyst\./.test(call.systemPrompt) ? 'analyst' : /Market Flow Agent\./.test(call.systemPrompt) ? 'flow' : /You are the Critic\./.test(call.systemPrompt) ? 'critic' : 'risk'
    seen[role] = call
    return fake.callAgent(call)
  }
  const result = await runAiTradingPipeline({
    symbol: 'BTCUSDT', config: cfg, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA,
    ...(constraints ? { getTradeConstraints: async () => constraints } : {}), callAgent: spy, backtestStats: positiveStats,
  })
  return { seen, result }
}

test('risk manager: gets the full role prompt plus the pipeline notes; the other agents do not', async () => {
  const { RISK_MANAGER_SYSTEM_PROMPT } = await import('../server/ai-trading/risk-manager-prompt.js')
  const { seen } = await captureCalls(config)
  const system = seen.risk.systemPrompt
  assert.ok(system.includes(RISK_MANAGER_SYSTEM_PROMPT.trim()), 'the owner-written role text is included verbatim')
  assert.match(system, /You are the Risk Manager AI for XeniosTrade/)
  assert.match(system, /You are NOT a deterministic risk calculator/)
  assert.match(system, /Return STRICT JSON only/)
  // the notes reconcile the role text with what the code really does
  assert.match(system, /HOW THIS PIPELINE USES YOUR ANSWER/)
  assert.match(system, /finalConfidence is the `confidence` field/)
  assert.match(system, /There is no quantity field/)
  assert.doesNotMatch(system, /TEST MODE/, 'no test-mode wording in a normal run')
  // it is still the requested reply shape, and the ceilings/evidence stay in the user message
  assert.match(seen.risk.userPrompt, /Reply with exactly: \{"decision":"APPROVE\|REDUCE\|VETO"/)
  assert.match(seen.risk.userPrompt, /Fixed ceilings/)
  for (const role of ['analyst', 'flow', 'critic']) {
    assert.doesNotMatch(seen[role].systemPrompt, /Risk Manager AI for XeniosTrade/, `${role} must not get the Risk Manager role text`)
  }
})

test('risk manager: in test mode the test-mode preamble leads and the notes say the test-mode instruction wins over VETO conditions', async () => {
  const { seen } = await captureCalls(normalizeAiTradingConfig({ scan: { testMode: true } }))
  const system = seen.risk.systemPrompt
  assert.match(system, /^You are one agent in a four-stage[\s\S]*TEST MODE/)
  assert.match(system, /You are the Risk Manager AI for XeniosTrade/)
  assert.match(system, /the TEST MODE instruction wins/)
  assert.match(seen.risk.userPrompt, /TEST MODE: VETO only if the trade is clearly unacceptable/)
})

test('risk manager: is shown the wallet balance and the open positions (portfolio exposure), or that there are none', async () => {
  const base = { mode: 'real', minOrderUsdt: 5, marginCapUsdt: 9.99, availableUsdt: 40 }
  const withPositions = await captureCalls(config, {
    ...base,
    openPositions: [{ symbol: 'ETHUSDT', side: 'LONG', notionalUsdt: 21.42, leverage: 3, maxLossUsdt: 0.2 }, { symbol: 'SOLUSDT', side: 'LONG', notionalUsdt: 10, leverage: 1, maxLossUsdt: 0.1 }],
  })
  assert.match(withPositions.seen.risk.userPrompt, /Wallet available balance: 40\.00 USDT/)
  assert.match(withPositions.seen.risk.userPrompt, /Open AI positions in this wallet \(portfolio exposure to weigh, including correlation\): ETHUSDT LONG 21\.42 USDT notional at 3x, max loss 0\.20 USDT; SOLUSDT LONG 10\.00 USDT notional at 1x/)

  const none = await captureCalls(config, { ...base, openPositions: [] })
  assert.match(none.seen.risk.userPrompt, /Open AI positions in this wallet: none\./)

  // no constraints at all (lookup unavailable) adds nothing
  const missing = await captureCalls(config)
  assert.doesNotMatch(missing.seen.risk.userPrompt, /Open AI positions|Wallet available balance/)
})

// ---- Measured evidence reaches the Risk Manager -------------------------------------------------------------------------

test('risk evidence: the Risk Manager gets funding from the flow data and the measured evidence handed in by the server', async () => {
  const { buildRiskEvidence } = await import('../server/ai-trading/risk-evidence.js')
  const candles = Array.from({ length: 500 }, (_unused, index) => {
    const close = 100 * (1 + 0.0004) ** index
    return { open: close, high: close * 1.001, low: close * 0.999, close, volume: 1, closeTime: 0 }
  })
  const evidence = buildRiskEvidence({ candles5m: candles, candles1h: candles.slice(0, 300), depth: { bids: [['99.9', '900']], asks: [['100.1', '900']] }, notionalsUsdt: [30] })
  const fake = fakeAgents()
  const result = await runAiTradingPipeline({
    symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA,
    getTradeConstraints: async () => ({ mode: 'real', minOrderUsdt: 5, marginCapUsdt: 9.99, availableUsdt: 40, openPositions: [], evidence }),
    callAgent: fake.callAgent, backtestStats: positiveStats,
  })
  const prompt = fake.prompts.risk
  assert.match(prompt, /Measured evidence \(computed from recent market data/)
  assert.match(prompt, /Volatility context: 5M ATR/)
  assert.match(prompt, /Typical excursion in the 60 minutes after ANY 5M close, for a LONG/)
  assert.match(prompt, /Live futures order book/)
  assert.match(prompt, /Not measured, so unavailable to you: exchange fees/)
  assert.ok(result.constraints.evidence.excursion.long.mfe.length === 21, 'the quantile tables are kept on the run, not the raw candles')

  // and the evidence block is optional: no evidence and no funding -> no block at all
  const bare = fakeAgents()
  await runAiTradingPipeline({
    symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(),
    getFlowData: async () => ({ ...FLOW_DATA, metrics: { ...FLOW_DATA.metrics, fundingRatePct: null } }),
    callAgent: bare.callAgent, backtestStats: positiveStats,
  })
  assert.doesNotMatch(bare.prompts.risk, /Measured evidence/)
})

// ---- Critic: adversarial reviewer, REJECT only for a fatal flaw ---------------------------------------------------------------

test('critic: CAUTION is the default for ordinary weaknesses and REJECT is reserved for a clearly fatal flaw', async () => {
  const fake = fakeAgents()
  const seen = {}
  const spy = async (call) => {
    if (/You are the Critic\./.test(call.systemPrompt)) seen.critic = call
    return fake.callAgent(call)
  }
  await runAiTradingPipeline({ symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA, callAgent: spy, backtestStats: positiveStats })
  const { systemPrompt, userPrompt } = seen.critic
  assert.match(userPrompt, /CAUTION = real but ordinary concerns the trade can survive; this is the default whenever your objections are the usual kind/)
  assert.match(userPrompt, /a late or extended entry, nearby resistance or support, modest volume, chop, timeframe disagreement, crowded positioning/)
  assert.match(userPrompt, /however many of them there are/)
  assert.match(userPrompt, /REJECT = only a clearly fatal flaw/)
  assert.match(userPrompt, /Expect most reasonable setups to end in PASS or CAUTION/)
  assert.match(userPrompt, /Severity: high = potentially fatal/)
  assert.match(systemPrompt, /not the last line of defence/)
  assert.match(systemPrompt, /reserve REJECT for problems that are clearly fatal/)
  // the shared skeptical preamble ("rejecting is a good outcome") is not used for the Critic
  assert.doesNotMatch(systemPrompt, /rejecting is a good outcome|Be rigorous and skeptical/)
  // the other stages keep it
  const analyst = fakeAgents()
  let analystSystem = ''
  await runAiTradingPipeline({ symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA, callAgent: async (call) => { if (/You are the Market Analyst\./.test(call.systemPrompt)) analystSystem = call.systemPrompt; return analyst.callAgent(call) }, backtestStats: positiveStats })
  assert.match(analystSystem, /rejecting is a good outcome/)
})

test('critic: a CAUTION verdict passes the gate (only REJECT blocks), and the Risk Manager is told about it', async () => {
  const cautious = { verdict: 'CAUTION', objections: [{ issue: 'late entry at 0.7 of the range', severity: 'medium' }], reasoning: 'Ordinary concerns.' }
  const fake = fakeAgents({ critic: cautious })
  const result = await runAiTradingPipeline({ symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA, callAgent: fake.callAgent, backtestStats: positiveStats })
  assert.equal(result.final.gates.find((gate) => gate.id === 'critic').passed, true)
  assert.ok(fake.calls.includes('risk'), 'the Risk Manager was reached')
  assert.match(fake.prompts.risk, /Critic: CAUTION\./)
})

// ---- Active profile ---------------------------------------------------------------------------------------------------------

test('active profile: off by default, needs an explicit true, and honoured in either mode', () => {
  assert.equal(normalizeAiTradingConfig(null).scan.activeMode, false)
  assert.equal(normalizeAiTradingConfig({ scan: { activeMode: true } }).scan.activeMode, true)
  assert.equal(normalizeAiTradingConfig({ scan: { activeMode: 'true' } }).scan.activeMode, false)
  assert.equal(normalizeAiTradingConfig({ execution: { mode: 'real' }, scan: { activeMode: true } }).scan.activeMode, true)
})

test('active profile: relaxes the Analyst, Flow and Risk Manager wording only; the Critic and the code gates are unchanged', async () => {
  const capture = async (cfg) => {
    const fake = fakeAgents()
    const seen = {}
    const spy = async (call) => {
      const role = /You are the Market Analyst\./.test(call.systemPrompt) ? 'analyst' : /Market Flow Agent\./.test(call.systemPrompt) ? 'flow' : /You are the Critic\./.test(call.systemPrompt) ? 'critic' : 'risk'
      seen[role] = call
      return fake.callAgent(call)
    }
    const result = await runAiTradingPipeline({ symbol: 'BTCUSDT', config: cfg, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA, callAgent: spy, backtestStats: positiveStats })
    return { seen, result }
  }
  const normal = await capture(config)
  const active = await capture(normalizeAiTradingConfig({ scan: { activeMode: true } }))

  assert.equal(active.result.activeMode, true)
  assert.equal(normal.result.activeMode, false)

  // Analyst: leans instead of defaulting to HOLD, honest confidence, no skeptical preamble
  assert.match(active.seen.analyst.systemPrompt, /ACTIVE MODE: the account owner wants this pipeline to find tradable setups/)
  assert.match(active.seen.analyst.userPrompt, /choose the direction the data leans toward even if the edge is modest/)
  assert.doesNotMatch(active.seen.analyst.systemPrompt, /rejecting is a good outcome/)
  assert.doesNotMatch(active.seen.analyst.userPrompt, /genuine edge/)
  assert.doesNotMatch(normal.seen.analyst.userPrompt, /ACTIVE MODE/)

  // Flow: two independent adverse signals before AGAINST; a lopsided ratio alone is not enough
  assert.match(active.seen.flow.userPrompt, /AGAINST needs at least two independent adverse signals/)
  assert.match(active.seen.flow.userPrompt, /persistently lopsided long\/short account ratio on its own is NOT enough/)
  assert.doesNotMatch(normal.seen.flow.userPrompt, /ACTIVE MODE/)

  // Risk Manager: REDUCE an extended-but-valid entry instead of vetoing; the notes say the instruction wins
  assert.match(active.seen.risk.userPrompt, /an extended or late entry in a valid trend is a reason to REDUCE/)
  assert.match(active.seen.risk.systemPrompt, /ACTIVE MODE is on for this run/)
  assert.match(active.seen.risk.systemPrompt, /the ACTIVE MODE instruction wins: REDUCE rather than VETO/)
  assert.doesNotMatch(normal.seen.risk.userPrompt, /ACTIVE MODE/)
  assert.doesNotMatch(normal.seen.risk.systemPrompt, /ACTIVE MODE is on/)

  // Critic: already reserves REJECT for fatal flaws, so its prompt is identical in both profiles
  assert.equal(active.seen.critic.systemPrompt, normal.seen.critic.systemPrompt)
  assert.equal(active.seen.critic.userPrompt, normal.seen.critic.userPrompt)

  // the code gates are untouched: the same fake agents produce the same gates
  assert.deepEqual(active.result.final.gates.map((gate) => [gate.id, gate.passed]), normal.result.final.gates.map((gate) => [gate.id, gate.passed]))
})

test('active profile: test mode keeps its own wording when both are on (the one-shot check wins)', async () => {
  const fake = fakeAgents()
  let analystSystem = ''
  let riskSystem = ''
  await runAiTradingPipeline({
    symbol: 'BTCUSDT', config: normalizeAiTradingConfig({ scan: { testMode: true, activeMode: true } }), getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA,
    callAgent: async (call) => {
      if (/You are the Market Analyst\./.test(call.systemPrompt)) analystSystem = call.systemPrompt
      if (/Risk Manager AI for XeniosTrade/.test(call.systemPrompt)) riskSystem = call.systemPrompt
      return fake.callAgent(call)
    },
    backtestStats: positiveStats,
  })
  assert.match(analystSystem, /TEST MODE \(testnet, fake money\)/)
  assert.doesNotMatch(analystSystem, /ACTIVE MODE/)
  assert.match(riskSystem, /the TEST MODE instruction wins/)
  assert.doesNotMatch(riskSystem, /ACTIVE MODE is on/)
})

// ---- Risk Manager: risk level (LOW/MEDIUM/HIGH), driven by its own confidence, replaces fixed leverage ---------------------

test('parseRiskProposal: riskLevel is parsed and normalized, but never required (an older/omitted value does not block)', () => {
  assert.equal(parseRiskProposal({ decision: 'APPROVE', riskLevel: 'high', confidence: 75, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage: 3 }).riskLevel, 'HIGH')
  assert.equal(parseRiskProposal({ decision: 'REDUCE', riskLevel: 'Low', confidence: 60, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 0.3, leverage: 1 }).riskLevel, 'LOW')
  assert.equal(parseRiskProposal({ decision: 'APPROVE', confidence: 75, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage: 3 }).riskLevel, null, 'missing is fine, not fatal')
  assert.equal(parseRiskProposal({ decision: 'APPROVE', riskLevel: 'extreme', confidence: 75, stopLossPercent: 1, takeProfitPercent: 2, riskPercent: 1, leverage: 3 }).riskLevel, null, 'an invalid value is dropped, not thrown on')
  assert.equal(parseRiskProposal({ decision: 'VETO', reasoning: 'no' }).riskLevel, null)
})

test('risk manager: the leverage the model returns is a ceiling again, not fixed - it can size low OR high confidence appropriately', async () => {
  const { reviewRiskProposal } = await import('../server/ai-trading/pipeline.js')

  // Low confidence: a wide stop and a small riskPercent/leverage is honoured as-is, never pushed up.
  const low = reviewRiskProposal({
    proposal: { decision: 'APPROVE', riskLevel: 'LOW', confidence: 62, stopLossPercent: 1.5, takeProfitPercent: 2.5, riskPercent: 0.3, leverage: 1, concerns: [], reasoning: 'Not confident enough for more.' },
    side: 'LONG', price: 100, atrPct: 0.3, limits: LIMITS,
  })
  assert.equal(low.ai.riskLevel, 'LOW')
  assert.equal(low.plan.leverage, 1, 'a low-confidence answer stays at 1x, not forced up')

  // High confidence: a tight stop the model is genuinely willing to size can reach the normal ceiling - never pinned to a fixed value.
  const high = reviewRiskProposal({
    proposal: { decision: 'APPROVE', riskLevel: 'HIGH', confidence: 85, stopLossPercent: 0.2, takeProfitPercent: 0.6, riskPercent: 1, leverage: 5, concerns: [], reasoning: 'Strong, high-conviction setup.' },
    side: 'LONG', price: 100, atrPct: 0.05, limits: LIMITS,
  })
  assert.equal(high.ai.riskLevel, 'HIGH')
  assert.equal(high.plan.leverage, 5, 'a confident answer can reach the normal 5x ceiling - never pinned to 10x')
  assert.ok(high.plan.leverage <= LIMITS.maxLeverage)

  // asking for more than the ceiling is still clamped, same as before
  const greedy = reviewRiskProposal({
    proposal: { decision: 'APPROVE', riskLevel: 'HIGH', confidence: 85, stopLossPercent: 0.1, takeProfitPercent: 0.3, riskPercent: 1, leverage: 50, concerns: [], reasoning: 'Max it.' },
    side: 'LONG', price: 100, atrPct: 0.02, limits: LIMITS,
  })
  assert.equal(greedy.plan.leverage, LIMITS.maxLeverage)
})

test('risk manager: is told to classify riskLevel from its own confidence, and the fixed-10x wording is gone', async () => {
  const fake = fakeAgents()
  let risk = {}
  await runAiTradingPipeline({
    symbol: 'BTCUSDT', config, getMarketInputs: async () => marketInputs(), getFlowData: async () => FLOW_DATA,
    callAgent: async (call) => { if (/Risk Manager AI for XeniosTrade/.test(call.systemPrompt)) risk = call; return fake.callAgent(call) },
    backtestStats: positiveStats,
  })
  assert.match(risk.userPrompt, /riskLevel: classify what you are actually about to risk/)
  assert.match(risk.userPrompt, /HIGH only when the evidence is unusually strong and you would stake more of your own capital on it/)
  assert.match(risk.userPrompt, /LOW when the case is real but you are not that confident/)
  assert.match(risk.userPrompt, /Reply with exactly: \{"decision":"APPROVE\|REDUCE\|VETO","riskLevel":"LOW\|MEDIUM\|HIGH"/)
  assert.match(risk.systemPrompt, /`riskLevel` \(LOW\/MEDIUM\/HIGH\) is your own summary of how much you are risking here, driven by genuine confidence/)
  assert.doesNotMatch(risk.userPrompt, /FIXED at|fixed at 10x|account owner's setting/)
  assert.doesNotMatch(risk.systemPrompt, /FIXED at.*for this wallet/)
  // and there is no way left to pin it - the config field is gone, so riskLimitsFor only ever applies the normal ceiling (or test mode's floor)
  const { riskLimitsFor } = await import('../server/ai-trading/pipeline.js')
  assert.equal(normalizeAiTradingConfig({ execution: { realFixedLeverage: 10 } }).execution.realFixedLeverage, undefined)
  assert.equal(riskLimitsFor(config).maxLeverage, LIMITS.maxLeverage)
})

test('trade record: keeps the Risk Manager\'s riskLevel for the trade history, or null when it did not give one', async () => {
  const { buildAiTradeRecord } = await import('../server/ai-trading/execution.js')
  const run = { id: 'r1', symbol: 'BTCUSDT', final: {}, stages: [{ id: 'risk', output: { ai: { riskLevel: 'HIGH' } } }] }
  const plan = { side: 'LONG', entryPrice: 100, stopLoss: 99, takeProfit: 102, stopLossPct: 1, takeProfitPct: 2 }
  const scaled = { quantityHint: 1, margin: 10, maxLoss: 1, notional: 100, notes: [] }
  const record = buildAiTradeRecord({ run, plan, mode: 'real', scaled, execution: {}, marginMode: 'ISOLATED', leverage: 3, dateKey: '2026-09-22' })
  assert.equal(record.aiRiskLevel, 'HIGH')
  const withoutLevel = buildAiTradeRecord({ run: { ...run, stages: [{ id: 'risk', output: { ai: {} } }] }, plan, mode: 'real', scaled, execution: {}, marginMode: 'ISOLATED', leverage: 3, dateKey: '2026-09-22' })
  assert.equal(withoutLevel.aiRiskLevel, null)
})
