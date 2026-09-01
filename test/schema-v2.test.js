import test from 'node:test'
import assert from 'node:assert/strict'

// Set the autostart guard BEFORE the server module is evaluated. A static import
// is hoisted above module-body statements, so the server must be pulled in via a
// dynamic import that runs after this assignment.
process.env.XENIOS_SERVER_AUTOSTART = 'off'
const {
  assertNoLeakageInFeatures, buildLearningBotTrainingRowV2, buildLearningBotDataset,
} = await import('../server/mock-trading-server.js')

const FORBIDDEN = [
  'status', 'result', 'outcome', 'pnl', 'grossPnl', 'exitPrice', 'win', 'tpBeforeSl',
  'timedOut', 'holdBars', 'holdHours', 'mfe', 'mae', 'mistakeTags', 'reward', 'label',
]

const v2Trade = () => ({
  schemaVersion: 2,
  id: 'bt2-model-5-BTCUSDT-1700000000000',
  runId: 'test-run',
  symbol: 'BTCUSDT',
  isExtendedUniverse: false,
  timestamp: 1_700_000_000_000,
  signalModelId: 'model-5',
  signalModelName: 'Bot 5',
  strategyFamily: 'mean-reversion',
  setupFamily: 'Oversold reversion',
  side: 'BUY',
  marketRegime: 'RANGE',
  split: 'train',
  featureVersion: 'featv1-2026-09',
  features: { e5_ret1: 0.001, e5_rsi14: 0.31, s15_ema20_dist: -0.004, b1h_trend_dir: 0, fund_rate: -0.0003, hour_sin: 0.5 },
  configuredStopLossPercent: 0.7,
  leverage: 6,
  signalSummary: 'Bot 5 long mean-reversion confirmed',
  notional: 600,
  label: {
    outcome: 'CLOSED_TP', win: 1, tpBeforeSl: 1, netR: 1.4, netReturn: 0.014,
    pnl: 8.4, grossPnl: 9.1, frictionUsd: 0.7, holdBars: 9, holdHours: 0.75, timedOut: false,
  },
  reward: 0.6,
  status: 'CLOSED_TP', result: 'TP', pnl: 8.4, transactTime: 1_700_000_000_000,
})

test('assertNoLeakageInFeatures: passes a clean feature map', () => {
  assert.doesNotThrow(() => assertNoLeakageInFeatures(v2Trade().features, 'x'))
})

test('assertNoLeakageInFeatures: throws for every forbidden outcome key', () => {
  for (const key of FORBIDDEN) {
    assert.throws(
      () => assertNoLeakageInFeatures({ e5_ret1: 0.1, [key]: 1 }, 'rowX'),
      /Leakage: forbidden outcome key/,
      `expected throw for forbidden key "${key}"`,
    )
  }
})

test('buildLearningBotTrainingRowV2: separates features from label/reward', () => {
  const row = buildLearningBotTrainingRowV2(v2Trade())
  assert.equal(row.schemaVersion, 2)
  assert.ok(row.features && typeof row.features === 'object')
  assert.ok(row.label && typeof row.label === 'object')
  assert.equal(typeof row.reward, 'number')
  // outcome fields live in label, never in features
  for (const k of Object.keys(row.features)) {
    assert.ok(!FORBIDDEN.includes(k), `feature ${k} is a forbidden outcome key`)
  }
  assert.equal(row.label.outcome, 'CLOSED_TP')
  assert.equal(row.label.win, 1)
  assert.ok(Array.isArray(row.mistakeTags)) // reporting only, not a feature
  assert.equal(row.marketRegime, 'RANGE')
  assert.equal(row.split, 'train')
  assert.equal(row.strategyFamily, 'mean-reversion')
})

test('buildLearningBotTrainingRowV2: aborts if a forbidden key was smuggled into features', () => {
  const bad = v2Trade()
  bad.features.pnl = 8.4
  assert.throws(() => buildLearningBotTrainingRowV2(bad), /Leakage/)
})

test('buildLearningBotDataset: v2 rows kept as v2, legacy rows demoted to v1', () => {
  const legacy = {
    id: 'legacy-1', symbol: 'ETHUSDT', side: 'SELL', source: 'AUTO',
    status: 'CLOSED_SL', result: 'SL', signalModelId: 'model-1', signalModelName: 'Bot 1',
    pnl: -3.2, leverage: 8, configuredStopLossPercent: 0.6,
    signalSummary: 'support-zone reversal', transactTime: 1_699_000_000_000,
  }
  const ds = buildLearningBotDataset([v2Trade(), legacy], { focusSource: 'all', reviewWindowTrades: 0, minClosedTradesForInsights: 1 })
  const byId = Object.fromEntries(ds.map((r) => [r.id, r]))
  assert.equal(byId[v2Trade().id].schemaVersion, 2)
  assert.ok(byId[v2Trade().id].features)
  assert.equal(byId['legacy-1'].schemaVersion, 1)
  assert.equal(byId['legacy-1'].features, null)
})

test('every v2 dataset row: features carry zero forbidden keys', () => {
  const ds = buildLearningBotDataset(
    [v2Trade(), { ...v2Trade(), id: 'row2', split: 'holdout' }],
    { focusSource: 'all', reviewWindowTrades: 0, minClosedTradesForInsights: 1 },
  )
  for (const row of ds) {
    if (!row.features) continue
    for (const k of Object.keys(row.features)) {
      assert.ok(!FORBIDDEN.includes(k), `${row.id}: forbidden feature ${k}`)
    }
  }
})
