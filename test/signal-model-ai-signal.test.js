import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSignalModelStrategies } from '../src/lib/signalModels.js'

test('normalizeSignalModelStrategies: aiSignalProviderId/aiSignalModel round-trip through normalization (SaaS Phase 3)', () => {
  const normalized = normalizeSignalModelStrategies({
    'model-2': { aiSignalProviderId: 'anthropic', aiSignalModel: 'claude-haiku-4-5' },
  }, {})
  assert.equal(normalized['model-2'].aiSignalProviderId, 'anthropic')
  assert.equal(normalized['model-2'].aiSignalModel, 'claude-haiku-4-5')
})

test('normalizeSignalModelStrategies: an unassigned bot defaults to empty strings, not undefined', () => {
  const normalized = normalizeSignalModelStrategies({}, {})
  assert.equal(normalized['model-1'].aiSignalProviderId, '')
  assert.equal(normalized['model-1'].aiSignalModel, '')
})

test('normalizeSignalModelStrategies: aiSignalProviderId/aiSignalModel are trimmed strings, never carry stray types through', () => {
  const normalized = normalizeSignalModelStrategies({
    'model-5': { aiSignalProviderId: '  openai  ', aiSignalModel: 42 },
  }, {})
  assert.equal(normalized['model-5'].aiSignalProviderId, 'openai')
  assert.equal(normalized['model-5'].aiSignalModel, '42')
})

test('normalizeSignalModelStrategies: clearing an assignment (empty string) is preserved, not silently re-filled', () => {
  const withAssignment = normalizeSignalModelStrategies({
    'model-2': { aiSignalProviderId: 'anthropic', aiSignalModel: 'claude-haiku-4-5' },
  }, {})
  const cleared = normalizeSignalModelStrategies({
    'model-2': { ...withAssignment['model-2'], aiSignalProviderId: '', aiSignalModel: '' },
  }, {})
  assert.equal(cleared['model-2'].aiSignalProviderId, '')
  assert.equal(cleared['model-2'].aiSignalModel, '')
})
