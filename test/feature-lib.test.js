import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEntryFeatures, FEATURE_VERSION } from '../server/backtest/feature-lib.js'
import { synthCandles } from './_helpers.js'

// mirror of LEARNING_BOT_FORBIDDEN_FEATURE_KEYS
const FORBIDDEN = new Set([
  'status', 'result', 'outcome', 'pnl', 'grossPnl', 'netPnl', 'netR', 'netReturn',
  'exitPrice', 'exitReason', 'win', 'tpBeforeSl', 'timedOut', 'holdBars', 'holdHours',
  'mfe', 'mae', 'maxFavorableExcursion', 'maxAdverseExcursion', 'mistakeTags',
  'reward', 'label', 'closedAt', 'closedDateKey', 'tradeDuration',
])

const build = (seed = 1, tMs = 5_000_000) => buildEntryFeatures({
  entryCandles: synthCandles(320, { seed, step: 300_000 }),
  setupCandles: synthCandles(220, { seed: seed + 1, step: 900_000 }),
  biasCandles: synthCandles(140, { seed: seed + 2, step: 3_600_000 }),
  fundingHistory: [
    { fundingTime: 0, fundingRate: 0.0001 },
    { fundingTime: 2_000_000, fundingRate: -0.0002 },
    { fundingTime: 4_000_000, fundingRate: 0.00015 },
  ],
  tMs,
})

test('feature vector: version tag present and stable', () => {
  const { featureVersion } = build()
  assert.equal(featureVersion, FEATURE_VERSION)
  assert.match(featureVersion, /^featv\d/)
})

test('feature vector: every value is a finite number', () => {
  const { features } = build()
  const keys = Object.keys(features)
  assert.ok(keys.length > 100, `expected >100 features, got ${keys.length}`)
  for (const k of keys) {
    assert.equal(typeof features[k], 'number', `${k} not a number`)
    assert.ok(Number.isFinite(features[k]), `${k} not finite: ${features[k]}`)
  }
})

test('feature vector: contains NO forbidden outcome key', () => {
  const { features } = build()
  for (const k of Object.keys(features)) {
    assert.ok(!FORBIDDEN.has(k), `forbidden outcome key leaked into features: ${k}`)
  }
})

test('feature vector: deterministic for identical input', () => {
  const a = build(7)
  const b = build(7)
  assert.deepEqual(a.features, b.features)
})

test('feature vector: only depends on the passed window (no look-ahead)', () => {
  // Same 320-bar entry window, but one call also passes 200 EXTRA future bars
  // appended. buildEntryFeatures must be handed a pre-sliced window by the
  // harness; here we confirm that giving it MORE bars changes the result
  // (i.e. it reads the tail), so the harness's slice-to-closed-by-t is what
  // enforces no-look-ahead — and that slicing then reproduces the exact vector.
  const full = synthCandles(520, { seed: 3, step: 300_000 })
  const windowAtK = full.slice(0, 320)
  const fFull = buildEntryFeatures({
    entryCandles: full, setupCandles: synthCandles(220, { seed: 4, step: 900_000 }),
    biasCandles: synthCandles(140, { seed: 5, step: 3_600_000 }), fundingHistory: [], tMs: 5_000_000,
  })
  const fWin = buildEntryFeatures({
    entryCandles: windowAtK, setupCandles: synthCandles(220, { seed: 4, step: 900_000 }),
    biasCandles: synthCandles(140, { seed: 5, step: 3_600_000 }), fundingHistory: [], tMs: 5_000_000,
  })
  assert.notDeepEqual(fFull.features, fWin.features)
  // re-slicing to the same window reproduces it byte-for-byte
  const fWin2 = buildEntryFeatures({
    entryCandles: full.slice(0, 320), setupCandles: synthCandles(220, { seed: 4, step: 900_000 }),
    biasCandles: synthCandles(140, { seed: 5, step: 3_600_000 }), fundingHistory: [], tMs: 5_000_000,
  })
  assert.deepEqual(fWin.features, fWin2.features)
})

test('funding features: available flag + zeros when no history', () => {
  const withF = build()
  assert.equal(withF.features.fund_available, 1)
  const noF = buildEntryFeatures({
    entryCandles: synthCandles(320, { step: 300_000 }),
    setupCandles: synthCandles(220, { step: 900_000 }),
    biasCandles: synthCandles(140, { step: 3_600_000 }),
    fundingHistory: [], tMs: 5_000_000,
  })
  assert.equal(noF.features.fund_available, 0)
  assert.equal(noF.features.fund_rate, 0)
})

test('time features: cyclical encodings within [-1,1] and session flags 0/1', () => {
  const { features } = build(1, Date.UTC(2023, 5, 15, 9, 30)) // 09:30 UTC = London session
  for (const k of ['hour_sin', 'hour_cos', 'dow_sin', 'dow_cos']) {
    assert.ok(features[k] >= -1.0001 && features[k] <= 1.0001, `${k}=${features[k]}`)
  }
  assert.equal(features.london_session, 1)
  assert.ok([0, 1].includes(features.ny_session))
})

test('directional sanity: strong uptrend gives positive short-horizon returns & EMA slope', () => {
  const up = synthCandles(320, { trend: 0.15, noise: 0.15, seed: 2, step: 300_000 })
  const { features } = buildEntryFeatures({
    entryCandles: up,
    setupCandles: synthCandles(220, { trend: 0.4, noise: 0.2, seed: 2, step: 900_000 }),
    biasCandles: synthCandles(140, { trend: 1.2, noise: 0.3, seed: 2, step: 3_600_000 }),
    fundingHistory: [], tMs: 320 * 300_000,
  })
  assert.ok(features.e5_ret12 > 0, `ret12 should be positive in an uptrend, got ${features.e5_ret12}`)
  assert.ok(features.e5_ema20_slope > 0, `ema20 slope should be positive, got ${features.e5_ema20_slope}`)
  assert.equal(features.e5_trend_dir, 1)
})
