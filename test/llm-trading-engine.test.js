process.env.XENIOS_SERVER_AUTOSTART = 'off'

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLlmTradingBot, parseTradeDecision, LLM_TRADE_MIN_CONFIDENCE } from '../server/strategy/llm-trading-engine.js'
import { requestOpenAiCompatibleTradeDecision } from '../server/strategy/openai-compatible-client.js'
import { getSignalModel, getEffectiveSignalModelStrategy, buildDefaultSignalModelStrategies } from '../src/lib/signalModels.js'
import { synthCandles } from './_helpers.js'

// createLlmTradingBot persists its decision cache under server/data/<id>/ -
// these test-only bot ids never collide with a real bot, but clean up the
// scratch directories they create so a test run doesn't leave files behind.
const SERVER_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data')
after(async () => {
  const entries = await fs.readdir(SERVER_DATA_DIR).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('test-bot-'))
      .map((entry) => fs.rm(path.join(SERVER_DATA_DIR, entry), { recursive: true, force: true }).catch(() => {})),
  )
})

const strat = (id) => getEffectiveSignalModelStrategy(
  { signalModelStrategies: buildDefaultSignalModelStrategies({}), runningBalance: 1000 },
  id, { runningBalance: 1000 },
)

test('parseTradeDecision: accepts a valid object and a JSON string', () => {
  const decision = { action: 'LONG', confidence: 70, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'ok' }
  assert.deepEqual(parseTradeDecision(decision), decision)
  assert.deepEqual(parseTradeDecision(JSON.stringify(decision)), decision)
})

test('parseTradeDecision: rejects a bad action or a non-numeric confidence', () => {
  assert.throws(() => parseTradeDecision({ action: 'BUY', confidence: 70, stopLossPercent: 1, takeProfitPercent: 2 }), /invalid action/)
  assert.throws(() => parseTradeDecision({ action: 'LONG', confidence: 'high', stopLossPercent: 1, takeProfitPercent: 2 }), /confidence/)
  assert.throws(() => parseTradeDecision(null), /JSON object/)
})

test('requestOpenAiCompatibleTradeDecision: returns null when unconfigured, never calls fetch', async () => {
  const originalFetch = global.fetch
  let called = false
  global.fetch = async () => { called = true; throw new Error('should not be called') }
  try {
    const result = await requestOpenAiCompatibleTradeDecision({ apiKey: '', baseUrl: 'https://example.test', model: 'x', systemPrompt: 's', userPrompt: 'u' })
    assert.equal(result, null)
    assert.equal(called, false)
  } finally {
    global.fetch = originalFetch
  }
})

test('requestOpenAiCompatibleTradeDecision: parses a successful chat-completions response', async () => {
  const originalFetch = global.fetch
  const decision = { action: 'SHORT', confidence: 82, stopLossPercent: 0.8, takeProfitPercent: 1.6, reasoning: 'overextended' }
  let capturedUrl = null
  let capturedBody = null
  global.fetch = async (url, init) => {
    capturedUrl = url
    capturedBody = JSON.parse(init.body)
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }),
    }
  }
  try {
    const result = await requestOpenAiCompatibleTradeDecision({
      apiKey: 'key-123', baseUrl: 'https://example.test/v1', model: 'some-model', systemPrompt: 'sys', userPrompt: 'usr',
    })
    assert.deepEqual(result, decision)
    assert.equal(capturedUrl, 'https://example.test/v1/chat/completions')
    assert.equal(capturedBody.model, 'some-model')
    assert.equal(capturedBody.response_format.type, 'json_object')
  } finally {
    global.fetch = originalFetch
  }
})

test('requestOpenAiCompatibleTradeDecision: throws with the upstream error message on a non-ok response', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'invalid api key' } }),
  })
  try {
    await assert.rejects(
      requestOpenAiCompatibleTradeDecision({ apiKey: 'bad', baseUrl: 'https://example.test', model: 'x', systemPrompt: 's', userPrompt: 'u' }),
      /invalid api key/,
    )
  } finally {
    global.fetch = originalFetch
  }
})

// End-to-end engine test using a fake provider (no real network) - proves the
// shared caching/gating/sizing logic every LLM bot inherits works correctly.
function fakeMarketInputs() {
  const entry = synthCandles(120, { step: 300_000 })
  const bias = synthCandles(60, { step: 3_600_000 })
  return { entry, bias, marketContext: {} }
}

test('createLlmTradingBot: not configured -> notReady, never calls requestDecision', async () => {
  let called = false
  const bot = createLlmTradingBot({
    id: 'test-bot-unconfigured',
    label: 'Test Bot',
    strategyFamily: 'llm-test',
    isConfigured: () => false,
    resolveModelLabel: () => 'test-model',
    requestDecision: async () => { called = true; return null },
  })

  await bot.refreshDecisions({ symbols: ['BTCUSDT'], getSymbolInputs: async () => fakeMarketInputs() })
  assert.equal(called, false)

  const snap = bot.buildSignalSnapshot({
    symbol: 'BTCUSDT', signalModel: getSignalModel('model-11'), effectiveStrategy: strat('model-11'),
    closedEntryTimeframe: fakeMarketInputs().entry,
  })
  assert.equal(snap.ready, false)
  assert.match(snap.summary, /API key/i)
})

test('createLlmTradingBot: WAIT / low-confidence decisions stay not-ready; confident LONG/SHORT produce a sized trade', async () => {
  const inputs = fakeMarketInputs()
  const latestEntry = inputs.entry.at(-1)

  for (const [decision, expectReady] of [
    [{ action: 'WAIT', confidence: 90, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'no edge' }, false],
    [{ action: 'LONG', confidence: LLM_TRADE_MIN_CONFIDENCE - 1, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'weak' }, false],
    [{ action: 'LONG', confidence: LLM_TRADE_MIN_CONFIDENCE + 10, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'strong long' }, true],
    [{ action: 'SHORT', confidence: LLM_TRADE_MIN_CONFIDENCE + 10, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'strong short' }, true],
  ]) {
    const bot = createLlmTradingBot({
      id: `test-bot-${decision.action}-${decision.confidence}`,
      label: 'Test Bot',
      strategyFamily: 'llm-test',
      isConfigured: () => true,
      resolveModelLabel: () => 'test-model',
      requestDecision: async () => decision,
    })

    await bot.refreshDecisions({ symbols: ['BTCUSDT'], getSymbolInputs: async () => inputs })

    const snap = bot.buildSignalSnapshot({
      symbol: 'BTCUSDT', signalModel: getSignalModel('model-11'), effectiveStrategy: strat('model-11'),
      closedEntryTimeframe: inputs.entry,
    })

    assert.equal(snap.ready, expectReady, `${decision.action}@${decision.confidence} readiness`)
    if (expectReady) {
      const price = latestEntry.close
      if (decision.action === 'LONG') {
        assert.equal(snap.side, 'BUY')
        assert.ok(snap.stopLoss < price && snap.takeProfit > price, 'LONG: stop below, target above entry')
      } else {
        assert.equal(snap.side, 'SELL')
        assert.ok(snap.stopLoss > price && snap.takeProfit < price, 'SHORT: stop above, target below entry')
      }
      assert.ok(snap.positionNotional > 0 && snap.margin > 0)
      assert.equal(snap.strategyFamily, 'llm-test')
    }
  }
})

test('createLlmTradingBot: refreshDecisions only calls the provider for stale symbols', async () => {
  const inputs = fakeMarketInputs()
  const calls = []
  const bot = createLlmTradingBot({
    id: 'test-bot-stale-gating',
    label: 'Test Bot',
    strategyFamily: 'llm-test',
    isConfigured: () => true,
    resolveModelLabel: () => 'test-model',
    requestDecision: async ({ symbol }) => {
      calls.push(symbol)
      return { action: 'WAIT', confidence: 99, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'n/a' }
    },
  })

  await bot.refreshDecisions({ symbols: ['BTCUSDT', 'ETHUSDT'], getSymbolInputs: async () => inputs })
  assert.deepEqual(calls.sort(), ['BTCUSDT', 'ETHUSDT'])

  // Same closed candle (same closeTime) on the second cycle -> cache is fresh, no new calls.
  await bot.refreshDecisions({ symbols: ['BTCUSDT', 'ETHUSDT'], getSymbolInputs: async () => inputs })
  assert.deepEqual(calls.sort(), ['BTCUSDT', 'ETHUSDT'])
})

test('createLlmTradingBot: a provider error for one symbol does not break the batch', async () => {
  const inputs = fakeMarketInputs()
  const bot = createLlmTradingBot({
    id: 'test-bot-partial-failure',
    label: 'Test Bot',
    strategyFamily: 'llm-test',
    isConfigured: () => true,
    resolveModelLabel: () => 'test-model',
    requestDecision: async ({ symbol }) => {
      if (symbol === 'ETHUSDT') throw new Error('upstream boom')
      return { action: 'WAIT', confidence: 99, stopLossPercent: 1, takeProfitPercent: 2, reasoning: 'n/a' }
    },
  })

  await assert.doesNotReject(bot.refreshDecisions({ symbols: ['BTCUSDT', 'ETHUSDT'], getSymbolInputs: async () => inputs }))

  const btcSnap = bot.buildSignalSnapshot({
    symbol: 'BTCUSDT', signalModel: getSignalModel('model-11'), effectiveStrategy: strat('model-11'), closedEntryTimeframe: inputs.entry,
  })
  const ethSnap = bot.buildSignalSnapshot({
    symbol: 'ETHUSDT', signalModel: getSignalModel('model-11'), effectiveStrategy: strat('model-11'), closedEntryTimeframe: inputs.entry,
  })
  assert.match(btcSnap.summary, /WAIT/)
  assert.match(ethSnap.summary, /waiting for its next live API decision/)
})
