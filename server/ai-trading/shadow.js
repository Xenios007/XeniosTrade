// Shadow outcome tracker: what would each LONG/SHORT signal have done if it had been taken, whether or not a gate blocked it?
//
// Every Analyst LONG/SHORT is recorded (blocked by Flow, by the Critic, by the Risk Manager, approved, or executed) together with the
// Analyst's own stop/target bracket. A resolver later replays the signal against 1-minute candles and records which level was hit first.
// A baseline ("what would ANY entry in the same hour have done with this bracket?") is added once enough later data exists, so the gates
// can be judged against "no skill at all" instead of against nothing. Free: only public candles, no orders, no model calls.
//
// Everything here is pure (candles are passed in); the server owns the fetching and the storage. Honest limits, stated in the summary:
// fees are an assumed flat round-trip cost, a candle that touches both levels counts as a STOP (conservative), the entry is the price the
// run saw (up to one 5M bar old), and small samples say so.

export const SHADOW_HORIZON_MS = 2 * 60 * 60_000 // how long a signal is followed
export const SHADOW_BASELINE_WINDOW_MS = 60 * 60_000 // baseline entries are sampled through the hour after the signal
export const SHADOW_BASELINE_STEP_MS = 5 * 60_000
export const SHADOW_FEE_ROUND_TRIP_PCT = 0.1 // assumed taker fee in + out, percent of position
export const MAX_SHADOW_SIGNALS = 3000
export const SHADOW_MIN_DECIDED = 30 // below this a hit rate is flagged as weak evidence

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
const round = (value, digits = 3) => (finite(value) ? Number(Number(value).toFixed(digits)) : null)

/** Which stage stopped this signal: the first failed gate among flow / critic / risk, or how it got through. */
export function classifySignal(run) {
  if (run?.execution?.status === 'opened') return 'executed'
  if (run?.final?.approved) return 'approved_not_opened'
  const gates = run?.final?.gates || []
  for (const id of ['flow', 'critic', 'risk']) {
    const gate = gates.find((item) => item.id === id)
    if (gate && !gate.passed) return id
  }
  return 'other'
}

/** The shadow record for a finished run, or null when the Analyst did not go LONG/SHORT with a usable bracket. */
export function buildShadowSignal(run) {
  const stage = (id) => run?.stages?.find((item) => item.id === id)
  const analyst = stage('analyst')?.output
  if (!analyst || (analyst.action !== 'LONG' && analyst.action !== 'SHORT')) return null
  const entryPrice = Number(run.price)
  const stopPct = Number(analyst.stopLossPercent)
  const targetPct = Number(analyst.takeProfitPercent)
  if (!(entryPrice > 0 && stopPct > 0 && targetPct > 0) || !finite(run.startedAt)) return null
  return {
    id: run.id,
    symbol: run.symbol,
    side: analyst.action,
    entryPrice,
    stopPct,
    targetPct,
    confidence: finite(analyst.confidence) ? Number(analyst.confidence) : null,
    startedAt: Number(run.startedAt),
    testMode: run.testMode === true,
    group: classifySignal(run),
    verdicts: {
      flow: stage('flow')?.output?.verdict ?? null,
      critic: stage('critic')?.output?.verdict ?? null,
      risk: stage('risk')?.output?.ai?.decision ?? null,
    },
    status: 'pending',
    outcome: null,
    baseline: null,
  }
}

/**
 * Walks 1-minute candles (`{ time, high, low, close }`) from `fromMs` (inclusive) to `untilMs` (exclusive) for a bracket around
 * `entryPrice`. The first candle to touch the stop or the target decides; one touching both counts as a stop (conservative) and is flagged.
 */
export function walkBracket({ side, entryPrice, stopPct, targetPct, candles, fromMs, untilMs }) {
  const long = side === 'LONG'
  const stop = long ? entryPrice * (1 - stopPct / 100) : entryPrice * (1 + stopPct / 100)
  const target = long ? entryPrice * (1 + targetPct / 100) : entryPrice * (1 - targetPct / 100)
  let mfe = 0
  let mae = 0
  let seen = 0
  let last = null
  for (const candle of candles) {
    if (candle.time < fromMs || candle.time >= untilMs) continue
    seen += 1
    last = candle
    const favorable = long ? ((candle.high - entryPrice) / entryPrice) * 100 : ((entryPrice - candle.low) / entryPrice) * 100
    const adverse = long ? ((entryPrice - candle.low) / entryPrice) * 100 : ((candle.high - entryPrice) / entryPrice) * 100
    mfe = Math.max(mfe, favorable)
    mae = Math.max(mae, adverse)
    const hitStop = long ? candle.low <= stop : candle.high >= stop
    const hitTarget = long ? candle.high >= target : candle.low <= target
    if (hitStop || hitTarget) {
      return { result: hitStop ? 'stop' : 'target', ambiguous: hitStop && hitTarget, at: candle.time, mfePct: round(mfe), maePct: round(mae), seen, last }
    }
  }
  return { result: null, ambiguous: false, at: null, mfePct: round(mfe), maePct: round(mae), seen, last }
}

const netOf = (result, stopPct, targetPct, grossPct, feePct) => {
  if (result === 'target') return targetPct - feePct
  if (result === 'stop') return -stopPct - feePct
  return grossPct - feePct
}

/**
 * The outcome of one signal given candles that start at (or before) its start time. Returns null while it is still undecided and
 * inside the horizon (the caller tries again later).
 */
export function resolveShadowSignal(signal, candles, now = Date.now(), feePct = SHADOW_FEE_ROUND_TRIP_PCT) {
  const horizonEnd = signal.startedAt + SHADOW_HORIZON_MS
  const walk = walkBracket({ ...signal, candles, fromMs: signal.startedAt, untilMs: Math.min(now, horizonEnd) })
  if (walk.result) {
    return {
      result: walk.result,
      ambiguous: walk.ambiguous,
      at: walk.at,
      minutes: Math.max(0, Math.round((walk.at - signal.startedAt) / 60_000)),
      mfePct: walk.mfePct,
      maePct: walk.maePct,
      netPct: round(netOf(walk.result, signal.stopPct, signal.targetPct, 0, feePct)),
    }
  }
  if (now < horizonEnd || walk.seen === 0) return null
  const closeAtHorizon = walk.last.close
  const grossPct = ((signal.side === 'LONG' ? closeAtHorizon - signal.entryPrice : signal.entryPrice - closeAtHorizon) / signal.entryPrice) * 100
  return {
    result: 'expired',
    ambiguous: false,
    at: horizonEnd,
    minutes: Math.round(SHADOW_HORIZON_MS / 60_000),
    mfePct: walk.mfePct,
    maePct: walk.maePct,
    netPct: round(netOf('expired', signal.stopPct, signal.targetPct, grossPct, feePct)),
  }
}

/** True when the candles cover the whole baseline (entries through the window plus the horizon after the last one). */
export function baselineIsCovered(signal, now = Date.now()) {
  return now >= signal.startedAt + SHADOW_BASELINE_WINDOW_MS + SHADOW_HORIZON_MS
}

/**
 * "No skill" comparison: the same bracket applied to an entry every 5 minutes through the hour after the signal (entry = that minute's
 * open), each followed for the same horizon. Counts, so groups can be pooled.
 */
export function computeBaseline(signal, candles) {
  const counts = { n: 0, target: 0, stop: 0, expired: 0 }
  for (let offset = 0; offset < SHADOW_BASELINE_WINDOW_MS; offset += SHADOW_BASELINE_STEP_MS) {
    const from = signal.startedAt + offset
    const entry = candles.find((candle) => candle.time >= from)
    if (!entry || !(entry.open > 0)) continue
    const walk = walkBracket({ ...signal, entryPrice: entry.open, candles, fromMs: entry.time, untilMs: entry.time + SHADOW_HORIZON_MS })
    counts.n += 1
    counts[walk.result || 'expired'] += 1
  }
  return counts.n ? counts : null
}

/** Wilson score interval (95%) for k successes in n, as fractions. */
export function wilsonInterval(k, n, z = 1.96) {
  if (!(n > 0)) return null
  const p = k / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) }
}

const GROUP_LABELS = {
  all: 'All Analyst signals',
  executed: 'Executed (a trade was opened)',
  approved_not_opened: 'Approved, not opened',
  flow: 'Blocked by Market Flow',
  critic: 'Blocked by the Critic',
  risk: 'Blocked by the Risk Manager',
  other: 'Blocked elsewhere',
}

function summarizeGroup(key, signals, feePct) {
  const resolved = signals.filter((signal) => signal.outcome)
  const count = (result) => resolved.filter((signal) => signal.outcome.result === result).length
  const target = count('target')
  const stop = count('stop')
  const expired = count('expired')
  const decided = target + stop
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
  const avgStop = mean(signals.map((signal) => signal.stopPct))
  const avgTarget = mean(signals.map((signal) => signal.targetPct))
  const withBaseline = signals.filter((signal) => signal.baseline?.n)
  const baseTarget = withBaseline.reduce((sum, signal) => sum + signal.baseline.target, 0)
  const baseDecided = withBaseline.reduce((sum, signal) => sum + signal.baseline.target + signal.baseline.stop, 0)
  const interval = wilsonInterval(target, decided)
  return {
    key,
    label: GROUP_LABELS[key] || key,
    signals: signals.length,
    pending: signals.length - resolved.length,
    resolved: resolved.length,
    target,
    stop,
    expired,
    decided,
    targetRate: decided ? round(target / decided, 4) : null,
    targetRateLow: interval ? round(interval.low, 4) : null,
    targetRateHigh: interval ? round(interval.high, 4) : null,
    // The hit rate at which this bracket breaks even after the assumed fee: p (t - f) = (1 - p) (s + f)
    breakEvenRate: avgStop != null && avgTarget != null ? round((avgStop + feePct) / (avgStop + avgTarget), 4) : null,
    avgNetPct: round(mean(resolved.map((signal) => signal.outcome.netPct)), 4),
    baselineSignals: withBaseline.length,
    baselineTargetRate: baseDecided ? round(baseTarget / baseDecided, 4) : null,
    weak: decided < SHADOW_MIN_DECIDED,
  }
}

/** Per-stage results, plus how the Critic and Flow verdicts were distributed, for the dashboard. */
export function summarizeShadow(signals, { feePct = SHADOW_FEE_ROUND_TRIP_PCT, testMode = false } = {}) {
  const pool = signals.filter((signal) => signal.testMode === testMode)
  const keys = ['executed', 'approved_not_opened', 'flow', 'critic', 'risk', 'other']
  const groups = [summarizeGroup('all', pool, feePct), ...keys.map((key) => summarizeGroup(key, pool.filter((signal) => signal.group === key), feePct)).filter((group) => group.signals > 0)]
  const tally = (field) => {
    const counts = {}
    for (const signal of pool) if (signal.verdicts?.[field]) counts[signal.verdicts[field]] = (counts[signal.verdicts[field]] || 0) + 1
    return counts
  }
  const critic = tally('critic')
  const criticRan = Object.values(critic).reduce((sum, value) => sum + value, 0)
  return {
    mode: testMode ? 'test-mode signals' : 'normal-mode signals',
    feePct,
    horizonMinutes: SHADOW_HORIZON_MS / 60_000,
    groups,
    verdicts: { flow: tally('flow'), critic, risk: tally('risk') },
    criticRejectRate: criticRan ? round((critic.REJECT || 0) / criticRan, 4) : null,
    notes: [
      'The Analyst\'s own stop/target bracket is replayed against 1-minute candles; the first level touched decides, and a candle touching both counts as a stop.',
      `Fees are assumed at ${feePct}% round trip. The baseline applies the same bracket to an entry every 5 minutes through the hour after each signal.`,
      `Rates on fewer than ${SHADOW_MIN_DECIDED} decided signals are weak evidence; the interval shows how wide the uncertainty still is.`,
    ],
  }
}
