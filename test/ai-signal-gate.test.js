import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

process.env.XENIOS_SERVER_AUTOSTART = 'off'
const { evaluateAiSignalForCandidate } = await import('../server/mock-trading-server.js')

async function withFakeProvider(handler, run) {
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

const candidate = {
  symbol: 'BTCUSDT',
  side: 'BUY',
  direction: 'LONG',
  entryPrice: 60000,
  stopLoss: 59000,
  takeProfit: 62000,
  positionNotional: 300,
  summary: 'Bot 2 breakout retest aligned with higher-timeframe trend.',
  signalModelId: 'model-2',
  signalModelName: 'Bot 2',
}

test('evaluateAiSignalForCandidate: accept verdict is parsed and clamps confidence into 0-100', async () => {
  await withFakeProvider(() => ({
    payload: { choices: [{ message: { content: '{"accept":true,"confidence":150,"reason":"Strong breakout confirmation."}' } }] },
  }), async (baseUrl) => {
    const result = await evaluateAiSignalForCandidate({
      providerId: 'custom',
      model: 'fake-model',
      credential: { apiKey: 'k', baseUrl, model: 'fake-model' },
      candidate,
      signalModelName: 'Bot 2',
    })
    assert.equal(result.accept, true)
    assert.equal(result.confidence, 100, 'clamped to the 0-100 range')
    assert.equal(result.reason, 'Strong breakout confirmation.')
    assert.equal(result.unavailable, false)
  })
})

test('evaluateAiSignalForCandidate: a reject verdict is honoured with the model\'s reason', async () => {
  await withFakeProvider(() => ({
    payload: { choices: [{ message: { content: '{"accept":false,"confidence":20,"reason":"Setup looks overextended."}' } }] },
  }), async (baseUrl) => {
    const result = await evaluateAiSignalForCandidate({
      providerId: 'custom',
      model: 'fake-model',
      credential: { apiKey: 'k', baseUrl, model: 'fake-model' },
      candidate,
      signalModelName: 'Bot 2',
    })
    assert.equal(result.accept, false)
    assert.equal(result.confidence, 20)
    assert.equal(result.reason, 'Setup looks overextended.')
  })
})

test('evaluateAiSignalForCandidate: fails open (accept: true, unavailable: true) on a provider error, never throws', async () => {
  await withFakeProvider(() => ({ status: 401, payload: { error: { message: 'invalid api key' } } }), async (baseUrl) => {
    const result = await evaluateAiSignalForCandidate({
      providerId: 'custom',
      model: 'fake-model',
      credential: { apiKey: 'bad-key', baseUrl, model: 'fake-model' },
      candidate,
      signalModelName: 'Bot 2',
    })
    assert.equal(result.accept, true, 'fails open so a broken key never silently halts the bot')
    assert.equal(result.unavailable, true)
    assert.match(result.reason, /AI signal unavailable/)
  })
})

test('evaluateAiSignalForCandidate: fails open when the credential is missing entirely (NOT_CONFIGURED)', async () => {
  const result = await evaluateAiSignalForCandidate({
    providerId: 'custom',
    model: 'fake-model',
    credential: null,
    candidate,
    signalModelName: 'Bot 2',
  })
  assert.equal(result.accept, true)
  assert.equal(result.unavailable, true)
})

test('evaluateAiSignalForCandidate: a malformed (non-JSON) reply also fails open rather than throwing', async () => {
  await withFakeProvider(() => ({
    payload: { choices: [{ message: { content: 'not json at all' } }] },
  }), async (baseUrl) => {
    const result = await evaluateAiSignalForCandidate({
      providerId: 'custom',
      model: 'fake-model',
      credential: { apiKey: 'k', baseUrl, model: 'fake-model' },
      candidate,
      signalModelName: 'Bot 2',
    })
    assert.equal(result.accept, true)
    assert.equal(result.unavailable, true)
  })
})
