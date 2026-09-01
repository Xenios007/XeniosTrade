import test from 'node:test'
import assert from 'node:assert/strict'

// historical-data.js has no exported fetch internals, so we exercise the retry
// policy by stubbing global.fetch and importing a fresh module instance.
async function freshModule() {
  const mod = `../server/backtest/historical-data.js?bust=${Math.random()}`
  return import(mod)
}

test('permanent 4xx (invalid symbol) does NOT burn retries — fails fast', async () => {
  let calls = 0
  const realFetch = global.fetch
  global.fetch = async () => {
    calls += 1
    return { status: 400, ok: false, json: async () => ({ code: -1121, msg: 'Invalid symbol.' }), text: async () => 'Invalid symbol.' }
  }
  try {
    const { fetchHistoricalKlines } = await freshModule()
    const t0 = Date.now()
    // spot 400 (fail fast, 1 call each base) -> futures 400 (fail fast) -> throws
    await assert.rejects(fetchHistoricalKlines('NOTASYMBOLUSDT', '1h', Date.now() - 3_600_000, Date.now()))
    const elapsed = Date.now() - t0
    // 3 endpoints (2 spot + 1 futures), 1 call each, no exponential backoff:
    // must be far under the old ~36s of retry sleeps.
    assert.ok(calls <= 4, `expected <=4 fetch calls, got ${calls}`)
    assert.ok(elapsed < 4000, `expected <4s, took ${elapsed}ms`)
  } finally {
    global.fetch = realFetch
  }
})

test('429 rate-limit IS retried (not treated as permanent)', async () => {
  let calls = 0
  const realFetch = global.fetch
  global.fetch = async () => {
    calls += 1
    if (calls < 3) return { status: 429, ok: false, json: async () => ({}), text: async () => '' }
    return { status: 200, ok: true, json: async () => [] }
  }
  try {
    const { fetchHistoricalKlines } = await freshModule()
    const rows = await fetchHistoricalKlines('BTCUSDT', '1h', Date.now() - 3_600_000, Date.now())
    assert.ok(Array.isArray(rows))
    assert.ok(calls >= 3, `429 should have been retried, calls=${calls}`)
  } finally {
    global.fetch = realFetch
  }
})
