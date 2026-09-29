import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOT3_CUSTOM_RISK_PRESET_ID,
  getEffectiveSignalModelStrategy,
  normalizeBot3CustomRisk,
  resolveBot3RiskPresetId,
} from '../src/lib/signalModels.js'

test('normalizeBot3CustomRisk fills defaults and clamps to the allowed ranges', () => {
  assert.deepEqual(normalizeBot3CustomRisk(undefined), {
    riskPerTradePercent: 0.75,
    maxLossesPerDay: 3,
    dailyMaxLossPercent: 2,
    estimatedStopLossPercent: 1,
  })
  const clamped = normalizeBot3CustomRisk({ riskPerTradePercent: 50, maxLossesPerDay: 0, dailyMaxLossPercent: -3, estimatedStopLossPercent: 'nope' })
  assert.equal(clamped.riskPerTradePercent, 2)
  assert.equal(clamped.maxLossesPerDay, 1)
  assert.equal(clamped.dailyMaxLossPercent, 0.5)
  assert.equal(clamped.estimatedStopLossPercent, 1)
})

test('the custom preset id survives resolveBot3RiskPresetId, unknown ids still fall back to the default', () => {
  assert.equal(resolveBot3RiskPresetId(BOT3_CUSTOM_RISK_PRESET_ID), BOT3_CUSTOM_RISK_PRESET_ID)
  assert.equal(resolveBot3RiskPresetId('nonsense'), 'bot3-20')
})

test('Bot 3 uses the user\'s custom risk numbers for sizing', () => {
  const effective = getEffectiveSignalModelStrategy({
    bot3RiskPresetId: BOT3_CUSTOM_RISK_PRESET_ID,
    bot3CustomRisk: { riskPerTradePercent: 0.5, maxLossesPerDay: 2, dailyMaxLossPercent: 1, estimatedStopLossPercent: 1 },
    leverage: 10,
  }, 'model-3', { runningBalance: 1000 })

  assert.equal(effective.maxLossPerTrade, 5, '0.5% of a 1000 balance')
  assert.equal(effective.maxLossesPerDay, 2)
  assert.equal(effective.maxLossPerDay, 10, '1% daily cap of a 1000 balance')
})
