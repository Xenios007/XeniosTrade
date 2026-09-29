process.env.XENIOS_SERVER_AUTOSTART = 'off'

import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCustomBot } from '../server/mock-trading-server.js'
import { buildDefaultSignalModelStrategies } from '../src/lib/signalModels.js'
import { synthCandles } from './_helpers.js'

// SaaS Phase 8G: analyzeCustomBot pools checklist rows from real, distinct native-model
// builders (unmodified) rather than any mocked/fake evaluator - these are real candle
// fixtures run through the real dispatch (buildSignalAnalysisSnapshot).

const strategy = { signalModelStrategies: buildDefaultSignalModelStrategies({}), runningBalance: 1000 }

function makeSymbolInputs() {
  // Enough history for every family's lookback windows (model-2's zone/EMA context, model-5's
  // mean-reversion bands) without needing to hand-craft a specific setup - these tests assert
  // shape/pooling/threshold logic, not "this exact candle sequence should be ready".
  return {
    bias: synthCandles(200, { seed: 1 }),
    higher: synthCandles(200, { seed: 2 }),
    entry: synthCandles(200, { seed: 3 }),
    trigger: synthCandles(200, { seed: 4 }),
    marketContext: {},
  }
}

test('pools checklist rows from 2 distinct component models, never throws on synthetic data', () => {
  const customBot = {
    id: 'custom-test-1',
    name: 'Test Combo',
    componentSignalItems: [
      { modelId: 'model-2', key: 'setup-zone-context' },
      { modelId: 'model-2', key: 'bias-multi-timeframe' },
      { modelId: 'model-5', key: 'mr-zscore-stretch' },
    ],
    combinationMode: 'ALL',
    minimumAligned: 1,
    riskSourceModelId: 'model-2',
    walletId: 'wallet-model-1',
    enabled: true,
  }

  const result = analyzeCustomBot(customBot, 'BTCUSDT', makeSymbolInputs(), strategy)

  assert.equal(result.customBotId, 'custom-test-1')
  assert.equal(result.checklist.length, 3)
  assert.deepEqual(result.checklist.map((item) => item.modelId), ['model-2', 'model-2', 'model-5'])
  assert.deepEqual(result.checklist.map((item) => item.key), ['setup-zone-context', 'bias-multi-timeframe', 'mr-zscore-stretch'])
  assert.equal(result.maxScore, 3)
  assert.ok(result.score >= 0 && result.score <= 3)
  assert.equal(result.combinationMode, 'ALL')
  assert.equal(result.threshold, 3, 'ALL mode requires every checklist row')
  assert.equal(typeof result.ready, 'boolean')
  assert.equal(typeof result.summary, 'string')
})

test('THRESHOLD mode uses minimumAligned, capped at the checklist length', () => {
  const customBot = {
    id: 'custom-test-2',
    name: 'Threshold Combo',
    componentSignalItems: [
      { modelId: 'model-2', key: 'setup-zone-context' },
      { modelId: 'model-5', key: 'mr-zscore-stretch' },
    ],
    combinationMode: 'THRESHOLD',
    minimumAligned: 1,
    riskSourceModelId: 'model-5',
    walletId: 'wallet-model-1',
    enabled: true,
  }

  const result = analyzeCustomBot(customBot, 'ETHUSDT', makeSymbolInputs(), strategy)
  assert.equal(result.threshold, 1)
  assert.equal(result.riskSourceModelId, 'model-5')
})

test('an unknown component key pools as not-passed rather than throwing', () => {
  const customBot = {
    id: 'custom-test-3',
    name: 'Bad Key Combo',
    componentSignalItems: [
      { modelId: 'model-2', key: 'this-key-does-not-exist' },
      { modelId: 'model-5', key: 'mr-zscore-stretch' },
    ],
    combinationMode: 'ALL',
    minimumAligned: 1,
    riskSourceModelId: 'model-2',
    walletId: 'wallet-model-1',
    enabled: true,
  }

  const result = analyzeCustomBot(customBot, 'BTCUSDT', makeSymbolInputs(), strategy)
  const badRow = result.checklist.find((item) => item.key === 'this-key-does-not-exist')
  assert.equal(badRow.passed, false)
  assert.equal(badRow.label, 'this-key-does-not-exist', 'falls back to the raw key when no matching checklist entry exists')
})

test('an unresolvable risk source (not among the component models) never crashes - ready stays false', () => {
  const customBot = {
    id: 'custom-test-4',
    name: 'Bad Risk Source',
    componentSignalItems: [
      { modelId: 'model-2', key: 'setup-zone-context' },
      { modelId: 'model-5', key: 'mr-zscore-stretch' },
    ],
    combinationMode: 'ALL',
    minimumAligned: 1,
    riskSourceModelId: 'model-99-does-not-exist',
    walletId: 'wallet-model-1',
    enabled: true,
  }

  const result = analyzeCustomBot(customBot, 'BTCUSDT', makeSymbolInputs(), strategy)
  assert.equal(result.ready, false)
  assert.equal(result.riskSourceReady, false)
  assert.equal(result.entryPrice, null)
})
