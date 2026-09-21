process.env.XENIOS_SERVER_AUTOSTART = 'off'

import test from 'node:test'
import assert from 'node:assert/strict'
import { quoteLargeIntegers } from '../server/exchange-json.js'

const { createExchangeTradeExecution } = await import('../server/mock-trading-server.js')

// An order id above 2^53, as Binance now issues. JSON.parse would round it; the executor must keep it exact.
const BIG_ID = '8389766281691711234'

const symbolInfo = {
  symbol: 'ETHUSDT',
  filters: [
    { filterType: 'PRICE_FILTER', tickSize: '0.01' },
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' },
    { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '10000' },
    { filterType: 'MIN_NOTIONAL', notional: '20' },
  ],
}
const payload = { symbol: 'ETHUSDT', side: 'BUY', quantity: 0.132, symbolInfo, stopLoss: 2708.81785, takeProfit: 2744.209, entryPrice: 2722.43, leverage: 10, marginMode: 'ISOLATED' }
const settings = { liveApiKey: 'key', liveSecretKey: 'secret', apiKey: 'tkey', secretKey: 'tsecret', strategy: { marginMode: 'ISOLATED' } }
const live = { forceBinance: true, environment: 'REAL_MONEY' }

/** A fake Binance: records every request and answers according to the scenario. */
function stubExchange({ statusLookup = 'ok', algo = 'ok', validate = 'ok', entry = 'ok' } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url))
    const method = init.method || 'GET'
    const params = Object.fromEntries(new URLSearchParams(method === 'GET' ? target.search : init.body || ''))
    calls.push({ method, path: target.pathname, params })
    const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    const key = `${method} ${target.pathname}`

    if (key === 'POST /fapi/v1/order/test') {
      return validate === 'fail' ? reply({ code: -1111, msg: 'Precision is over the maximum defined for this asset.' }, 400) : reply({})
    }
    if (key === 'POST /fapi/v1/order') {
      if (params.reduceOnly === 'true') return reply('{"orderId":777,"status":"NEW","executedQty":"0.000","avgPrice":"0.00"}')
      if (entry === 'fail') return reply({ code: -2019, msg: 'Margin is insufficient.' }, 400)
      // the acknowledgement: a big integer id and a "0.000" executed quantity, exactly as Binance sends it
      return reply(`{"orderId":${BIG_ID},"symbol":"ETHUSDT","status":"NEW","executedQty":"0.000","avgPrice":"0.00000"}`)
    }
    if (key === 'GET /fapi/v1/order') {
      if (statusLookup === 'fail' || (params.orderId !== BIG_ID && params.orderId !== '777')) return reply({ code: -2013, msg: 'Order does not exist.' }, 400)
      return reply(`{"orderId":${params.orderId === '777' ? 777 : BIG_ID},"status":"FILLED","executedQty":"${params.orderId === '777' ? '0.132' : '0.132'}","avgPrice":"2728.14000","updateTime":1789992534000}`)
    }
    if (key === 'POST /fapi/v1/algoOrder') {
      return algo === 'fail' ? reply({ code: -4130, msg: 'Order would immediately trigger.' }, 400) : reply({ algoId: 1000002574850969, clientAlgoId: params.clientAlgoId })
    }
    return reply({}) // margin type, leverage, cancels
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

async function run(scenario, options = live) {
  const exchange = stubExchange(scenario)
  const originalError = console.error
  console.error = () => {}
  try {
    const result = await createExchangeTradeExecution(payload, settings, options).then((value) => ({ value }), (error) => ({ error }))
    return { ...result, calls: exchange.calls }
  } finally {
    console.error = originalError
    exchange.restore()
  }
}

const paths = (calls) => calls.map((call) => `${call.method} ${call.path}`)

test('quoteLargeIntegers: exact id strings, nothing else touched', () => {
  const parsed = JSON.parse(quoteLargeIntegers(`{"orderId":${BIG_ID},"algoId":1000002574850969,"price":"0.0","qty":12345678901234567.5,"clientOrderId":"web_${BIG_ID}","list":[{"id":${BIG_ID}}]}`))
  assert.equal(parsed.orderId, BIG_ID)
  assert.equal(parsed.list[0].id, BIG_ID)
  assert.equal(parsed.algoId, 1000002574850969, 'an id a double holds exactly stays a number, so nothing else changes shape')
  assert.equal(parsed.price, '0.0')
  assert.equal(parsed.clientOrderId, `web_${BIG_ID}`)
  // small ids stay numbers
  assert.equal(JSON.parse(quoteLargeIntegers('{"orderId":243082661006}')).orderId, 243082661006)
  // and a plain JSON.parse of the same text would have rounded it
  assert.notEqual(String(JSON.parse(`{"orderId":${BIG_ID}}`).orderId), BIG_ID)
})

test('executor: the entry order id stays exact through the status lookup (the ETH "Order does not exist" bug)', async () => {
  const { value, error, calls } = await run({})
  assert.equal(error, undefined, error?.message)
  assert.equal(value.validationStatus, 'EXECUTED')
  const lookup = calls.find((call) => call.method === 'GET' && call.path === '/fapi/v1/order' && call.params.orderId !== '777')
  assert.equal(lookup.params.orderId, BIG_ID, 'the status lookup asked for the exact order id')
  assert.equal(String(value.exchangeEntryOrderId), BIG_ID)
  assert.equal(value.quantity, 0.132)
  assert.equal(value.entryPrice, 2728.14)
  // both protective orders were placed, with prices on the tick
  const algos = calls.filter((call) => call.path === '/fapi/v1/algoOrder')
  assert.equal(algos.length, 2)
  assert.deepEqual(algos.map((call) => [call.params.type, call.params.triggerPrice, call.params.quantity, call.params.reduceOnly]), [['STOP_MARKET', '2708.82', '0.132', 'true'], ['TAKE_PROFIT_MARKET', '2744.2', '0.132', 'true']])
})

test('executor: live orders are validated first (the test endpoint), then placed; every step before the entry is in order', async () => {
  const { calls } = await run({})
  assert.deepEqual(paths(calls).slice(0, 5), ['POST /fapi/v1/marginType', 'POST /fapi/v1/leverage', 'POST /fapi/v1/order/test', 'POST /fapi/v1/order', 'GET /fapi/v1/order'])
  const validation = calls.find((call) => call.path === '/fapi/v1/order/test')
  const entry = calls.find((call) => call.method === 'POST' && call.path === '/fapi/v1/order')
  assert.deepEqual(validation.params.quantity, entry.params.quantity)
  assert.equal(entry.params.quantity, '0.132')
  // testnet is not validated first
  const testnet = await run({}, { forceBinance: true, environment: 'TESTNET' })
  assert.equal(testnet.calls.some((call) => call.path === '/fapi/v1/order/test'), false)
})

test('executor: a failed status lookup no longer strands an unprotected position - the trade completes with stop and target', async () => {
  const { value, error, calls } = await run({ statusLookup: 'fail' })
  assert.equal(error, undefined, error?.message)
  assert.equal(value.validationStatus, 'EXECUTED')
  assert.equal(value.quantity, 0.132, 'falls back to the quantity sent (the acknowledgement said 0.000)')
  assert.equal(calls.filter((call) => call.path === '/fapi/v1/algoOrder').length, 2, 'stop-loss and take-profit were both placed')
  assert.equal(calls.some((call) => call.params.reduceOnly === 'true' && call.path === '/fapi/v1/order'), false, 'nothing was closed')
})

test('executor: if the protective orders fail, the position is closed again and the error says so', async () => {
  const { error, calls } = await run({ algo: 'fail' })
  assert.match(error.message, /Failed to place exchange-side stop loss \/ take profit after entry: Order would immediately trigger/)
  assert.match(error.message, /The position was closed again/)
  const close = calls.find((call) => call.method === 'POST' && call.path === '/fapi/v1/order' && call.params.reduceOnly === 'true')
  assert.ok(close, 'a reduce-only market order was sent')
  assert.deepEqual([close.params.side, close.params.type, close.params.quantity], ['SELL', 'MARKET', '0.132'])
})

test('executor: a failing status lookup on the closing order does not make a completed close look failed', async () => {
  const { error } = await run({ algo: 'fail', statusLookup: 'fail' })
  assert.match(error.message, /The position was closed again/)
})

test('executor: a rejected order is reported with the step that failed, before any position exists', async () => {
  const validation = await run({ validate: 'fail' })
  assert.match(validation.error.message, /^Order validation: Precision is over the maximum defined for this asset/)
  assert.equal(validation.calls.some((call) => call.method === 'POST' && call.path === '/fapi/v1/order'), false, 'no real order was sent')

  const entry = await run({ entry: 'fail' })
  assert.match(entry.error.message, /^Entry order: Margin is insufficient/)
  assert.equal(entry.calls.some((call) => call.path === '/fapi/v1/algoOrder'), false)
})
