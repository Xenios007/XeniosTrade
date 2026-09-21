import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHADOW_BASELINE_WINDOW_MS, SHADOW_HORIZON_MS, baselineIsCovered, buildShadowSignal, classifySignal, computeBaseline, resolveShadowSignal,
  summarizeShadow, walkBracket, wilsonInterval,
} from '../server/ai-trading/shadow.js'

const MINUTE = 60_000
const T0 = 1_700_000_000_000

// One 1-minute candle `minute` minutes after T0.
const candle = (minute, { open, high, low, close }) => ({ time: T0 + minute * MINUTE, open, high, low, close })
// `count` flat candles at `price`, optionally with a hook to override individual minutes.
const flat = (count, price = 100, overrides = {}) => Array.from({ length: count }, (_unused, minute) => candle(minute, { open: price, high: price, low: price, close: price, ...(overrides[minute] || {}) }))

const gate = (id, passed) => ({ id, label: id, passed, detail: '' })
const makeRun = ({ action = 'LONG', stop = 0.5, target = 0.8, gates = [], approved = false, execution = null, flow = 'NEUTRAL', critic = 'REJECT', testMode = false } = {}) => ({
  id: `ai-trading-BTCUSDT-${T0}`,
  symbol: 'BTCUSDT',
  startedAt: T0,
  price: 100,
  testMode,
  execution,
  final: { approved, gates },
  stages: [
    { id: 'analyst', output: { action, confidence: 62, stopLossPercent: stop, takeProfitPercent: target } },
    { id: 'flow', output: { verdict: flow } },
    { id: 'critic', output: { verdict: critic } },
    { id: 'risk', output: null },
  ],
})

test('classifySignal: executed, approved-not-opened, or the first failed gate among flow / critic / risk', () => {
  assert.equal(classifySignal(makeRun({ execution: { status: 'opened' }, approved: true })), 'executed')
  assert.equal(classifySignal(makeRun({ approved: true })), 'approved_not_opened')
  assert.equal(classifySignal(makeRun({ gates: [gate('analyst', true), gate('flow', false), gate('critic', false), gate('risk', false)] })), 'flow')
  assert.equal(classifySignal(makeRun({ gates: [gate('analyst', true), gate('flow', true), gate('critic', false), gate('risk', false)] })), 'critic')
  assert.equal(classifySignal(makeRun({ gates: [gate('analyst', true), gate('flow', true), gate('critic', true), gate('risk', false)] })), 'risk')
  assert.equal(classifySignal(makeRun({ gates: [gate('analyst', true), gate('flow', true), gate('critic', true), gate('risk', true)] })), 'other')
})

test('buildShadowSignal: records LONG/SHORT with the Analyst bracket and verdicts; ignores HOLD and unusable brackets', () => {
  const signal = buildShadowSignal(makeRun({ gates: [gate('flow', true), gate('critic', false)], critic: 'REJECT' }))
  assert.deepEqual(
    { side: signal.side, entry: signal.entryPrice, stop: signal.stopPct, target: signal.targetPct, group: signal.group, status: signal.status, critic: signal.verdicts.critic, flow: signal.verdicts.flow },
    { side: 'LONG', entry: 100, stop: 0.5, target: 0.8, group: 'critic', status: 'pending', critic: 'REJECT', flow: 'NEUTRAL' },
  )
  assert.equal(buildShadowSignal(makeRun({ action: 'HOLD' })), null)
  assert.equal(buildShadowSignal(makeRun({ stop: 0 })), null)
  assert.equal(buildShadowSignal({ ...makeRun(), price: 0 }), null)
  assert.equal(buildShadowSignal({ id: 'x', stages: [] }), null)
  assert.equal(buildShadowSignal(makeRun({ testMode: true })).testMode, true)
})

test('walkBracket: the first level touched decides, for LONG and SHORT, and a candle touching both counts as a stop', () => {
  const base = { entryPrice: 100, stopPct: 0.5, targetPct: 0.8, fromMs: T0, untilMs: T0 + 120 * MINUTE }
  // LONG: target 100.8, stop 99.5
  const targetFirst = walkBracket({ ...base, side: 'LONG', candles: flat(30, 100, { 5: { high: 100.9 }, 8: { low: 99.4 } }) })
  assert.equal(targetFirst.result, 'target')
  assert.equal(targetFirst.at, T0 + 5 * MINUTE)
  const stopFirst = walkBracket({ ...base, side: 'LONG', candles: flat(30, 100, { 3: { low: 99.4 }, 5: { high: 100.9 } }) })
  assert.equal(stopFirst.result, 'stop')
  const both = walkBracket({ ...base, side: 'LONG', candles: flat(30, 100, { 4: { high: 101, low: 99 } }) })
  assert.equal(both.result, 'stop')
  assert.equal(both.ambiguous, true)
  // SHORT: target 99.2, stop 100.5
  assert.equal(walkBracket({ ...base, side: 'SHORT', candles: flat(30, 100, { 6: { low: 99.1 } }) }).result, 'target')
  assert.equal(walkBracket({ ...base, side: 'SHORT', candles: flat(30, 100, { 6: { high: 100.6 } }) }).result, 'stop')
  // nothing touched: excursions are still measured
  const none = walkBracket({ ...base, side: 'LONG', candles: flat(30, 100, { 7: { high: 100.3, low: 99.8 } }) })
  assert.equal(none.result, null)
  assert.equal(none.mfePct, 0.3)
  assert.equal(none.maePct, 0.2)
  // candles outside the window are ignored
  assert.equal(walkBracket({ ...base, side: 'LONG', fromMs: T0 + 20 * MINUTE, candles: flat(30, 100, { 5: { high: 105 } }) }).result, null)
})

test('resolveShadowSignal: hit, still pending inside the horizon, or expired with the move at the horizon; fees are netted', () => {
  const signal = buildShadowSignal(makeRun())
  const hit = resolveShadowSignal(signal, flat(200, 100, { 12: { high: 101 } }), T0 + 30 * MINUTE)
  assert.equal(hit.result, 'target')
  assert.equal(hit.minutes, 12)
  assert.equal(hit.netPct, 0.7) // +0.8% target - 0.10% fee
  const stop = resolveShadowSignal(signal, flat(200, 100, { 3: { low: 99 } }), T0 + 30 * MINUTE)
  assert.equal(stop.result, 'stop')
  assert.equal(stop.netPct, -0.6) // -0.5% stop - 0.10% fee

  // inside the horizon and undecided: try again later
  assert.equal(resolveShadowSignal(signal, flat(60), T0 + 60 * MINUTE), null)
  // past the horizon without a touch: expired at the close of the last candle in the window
  const drift = flat(200, 100).map((c, index) => ({ ...c, close: 100 + index * 0.001, high: 100 + index * 0.001, low: 99.9 }))
  const expired = resolveShadowSignal(signal, drift, T0 + SHADOW_HORIZON_MS + MINUTE)
  assert.equal(expired.result, 'expired')
  assert.ok(expired.netPct < 0.1 && expired.netPct > -0.2, `net ${expired.netPct}`)
  // no candles at all: never invent an outcome
  assert.equal(resolveShadowSignal(signal, [], T0 + SHADOW_HORIZON_MS + MINUTE), null)
})

test('baseline: the same bracket from an entry every 5 minutes; covered only once the later data exists', () => {
  const signal = buildShadowSignal(makeRun())
  // a steady climb of 0.05% per minute: every entry reaches +0.8% long before the horizon
  const climb = Array.from({ length: 200 }, (_unused, minute) => {
    const price = 100 * (1 + 0.0005) ** minute
    return candle(minute, { open: price, high: price * 1.0001, low: price * 0.9999, close: price })
  })
  const up = computeBaseline(signal, climb)
  assert.equal(up.n, SHADOW_BASELINE_WINDOW_MS / (5 * MINUTE))
  assert.equal(up.target, up.n)
  // a steady fall stops every long out
  const fall = climb.map((c) => ({ ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close }))
  const down = computeBaseline(signal, fall)
  assert.equal(down.stop, down.n)
  assert.equal(computeBaseline(signal, []), null)

  assert.equal(baselineIsCovered(signal, T0 + SHADOW_BASELINE_WINDOW_MS + SHADOW_HORIZON_MS - 1), false)
  assert.equal(baselineIsCovered(signal, T0 + SHADOW_BASELINE_WINDOW_MS + SHADOW_HORIZON_MS), true)
})

test('wilsonInterval: sensible bounds that tighten with sample size', () => {
  assert.equal(wilsonInterval(1, 0), null)
  const small = wilsonInterval(6, 11)
  const large = wilsonInterval(55, 100)
  assert.ok(small.low < 0.545 && small.high > 0.545)
  assert.ok(large.low < 0.55 && large.high > 0.55)
  assert.ok(large.high - large.low < small.high - small.low)
  assert.ok(wilsonInterval(0, 10).low === 0 && wilsonInterval(10, 10).high === 1)
})

test('summarizeShadow: per-stage rates with intervals, break-even, baseline, weak-evidence flag, and the Critic reject rate', () => {
  const make = (id, group, result, { critic = 'REJECT', baseline = null, testMode = false } = {}) => ({
    id, symbol: 'BTCUSDT', side: 'LONG', entryPrice: 100, stopPct: 0.5, targetPct: 0.8, confidence: 60, startedAt: T0, testMode, group,
    verdicts: { flow: 'NEUTRAL', critic, risk: null },
    status: result ? 'resolved' : 'pending',
    outcome: result ? { result, netPct: result === 'target' ? 0.7 : result === 'stop' ? -0.6 : 0 } : null,
    baseline,
  })
  const signals = [
    make('a', 'critic', 'target', { baseline: { n: 12, target: 6, stop: 6, expired: 0 } }),
    make('b', 'critic', 'target'),
    make('c', 'critic', 'stop'),
    make('d', 'critic', 'expired'),
    make('e', 'critic', null),
    make('f', 'flow', 'stop', { critic: null }),
    make('g', 'executed', 'target', { critic: 'CAUTION' }),
    make('h', 'critic', 'target', { testMode: true, critic: 'CAUTION' }),
  ]
  const normal = summarizeShadow(signals)
  const byKey = Object.fromEntries(normal.groups.map((group) => [group.key, group]))
  assert.equal(byKey.all.signals, 7, 'test-mode signals are kept apart')
  assert.equal(byKey.critic.signals, 5)
  assert.equal(byKey.critic.resolved, 4)
  assert.equal(byKey.critic.pending, 1)
  assert.equal(byKey.critic.decided, 3)
  assert.equal(byKey.critic.targetRate, 0.6667)
  assert.equal(byKey.critic.expired, 1)
  assert.equal(byKey.critic.weak, true)
  assert.ok(byKey.critic.targetRateLow < 0.6667 && byKey.critic.targetRateHigh > 0.6667)
  // break-even after fees for a 0.5% stop / 0.8% target: (0.5 + 0.1) / (0.5 + 0.8)
  assert.equal(byKey.critic.breakEvenRate, 0.4615)
  assert.equal(byKey.critic.baselineTargetRate, 0.5)
  assert.equal(byKey.critic.baselineSignals, 1)
  assert.equal(byKey.critic.avgNetPct, 0.2) // (0.7 + 0.7 - 0.6 + 0) / 4
  assert.equal(byKey.flow.targetRate, 0)
  assert.equal(byKey.executed.targetRate, 1)
  // Critic verdicts among signals where it ran: 4 REJECT of 6
  assert.deepEqual(normal.verdicts.critic, { REJECT: 5, CAUTION: 1 })
  assert.equal(normal.criticRejectRate, 0.8333)
  assert.match(normal.notes.join(' '), /touching both counts as a stop/)

  const test = summarizeShadow(signals, { testMode: true })
  assert.equal(test.groups[0].signals, 1)
  assert.equal(test.criticRejectRate, 0)
})
