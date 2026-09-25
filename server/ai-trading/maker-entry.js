// Maker-first entry (strategy.makerEntry): post a post-only limit order at the touch, give it a short window to fill, cancel what is
// left and take the remainder at market. A maker fill pays roughly half the taker fee (and no spread), which matters when fees were
// eating most of the edge. The worst case is the old behaviour (a market order), a few seconds later.
//
// Pure orchestration: every exchange call is injected, so this is unit-tested with a stub. The server owns the real calls and keeps the
// whole thing inside createExchangeTradeExecution's "a position may exist" try/catch.

export const MAKER_WAIT_MS = 15_000
export const MAKER_POLL_MS = 2_000

const TERMINAL = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'])

/** The price that rests on the book without crossing: the best bid for a BUY, the best ask for a SELL. */
export function makerLimitPrice({ side, bidPrice, askPrice }) {
  const price = Number(side === 'BUY' ? bidPrice : askPrice)
  if (!(price > 0)) throw new Error(`No usable ${side === 'BUY' ? 'bid' : 'ask'} price for a maker entry.`)
  return price
}

/** Binance refuses a post-only (GTX) order that would take liquidity: -5022, "could not be executed as maker". */
export function isPostOnlyRejection(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /-5022|post ?only|executed as maker/i.test(message)
}

/**
 * @param {object} args
 * @param {number} args.quantity            the full position size
 * @param {object} args.exchange
 * @param {() => Promise<object>} args.exchange.placeLimit        posts the GTX limit order; resolves with the order
 * @param {(orderId) => Promise<object>} args.exchange.fetchStatus
 * @param {(orderId) => Promise<object|null>} args.exchange.cancel
 * @param {(quantity: number) => Promise<object>} args.exchange.placeMarket
 * @param {(quantity: number) => number} args.exchange.tradableQuantity  step-aligned quantity, or 0 when too small to be an order
 * @returns {Promise<{ executedQty: number, avgPrice: number, makerQty: number, takerQty: number, orderIds: string[], orderId: string|null, clientOrderId: string|null, notes: string[] }>}
 */
export async function runMakerEntry({ quantity, exchange, waitMs = MAKER_WAIT_MS, pollMs = MAKER_POLL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const notes = []
  const orderIds = []
  let makerQty = 0
  let makerPrice = 0
  let limit = null

  try {
    limit = await exchange.placeLimit()
  } catch (error) {
    // Price moved through the touch between the quote and the order: nothing rests, nothing filled. Any other error is a real failure.
    if (!isPostOnlyRejection(error)) throw error
    notes.push('Post-only order would have crossed the book; entered at market instead.')
  }

  if (limit?.orderId != null) {
    orderIds.push(String(limit.orderId))
    let status = limit
    const deadline = now() + waitMs
    while (!TERMINAL.has(status?.status) && now() < deadline) {
      await sleep(pollMs)
      status = (await exchange.fetchStatus(limit.orderId).catch(() => null)) || status
    }
    if (!TERMINAL.has(status?.status)) {
      // Cancel the rest; a throw here leaves the order possibly live, and the caller's catch cancels it again and closes the position.
      const cancelled = await exchange.cancel(limit.orderId)
      status = (await exchange.fetchStatus(limit.orderId).catch(() => null)) || cancelled || status
    }
    makerQty = Number(status?.executedQty) || 0
    makerPrice = Number(status?.avgPrice) || Number(status?.price) || Number(limit.price) || 0
    if (makerQty > 0 && makerQty < quantity) notes.push(`Maker order filled ${makerQty} of ${quantity}; the rest went at market.`)
    if (makerQty <= 0) notes.push(`Maker order did not fill within ${Math.round(waitMs / 1000)}s; entered at market instead.`)
  }

  let takerQty = 0
  let takerPrice = 0
  let market = null
  const remainder = exchange.tradableQuantity(quantity - makerQty)
  if (remainder > 0) {
    try {
      market = await exchange.placeMarket(remainder)
      const status = (market?.orderId != null ? await exchange.fetchStatus(market.orderId).catch(() => null) : null) || market
      takerQty = Number(status?.executedQty) || 0
      if (!(takerQty > 0) && makerQty <= 0) takerQty = remainder // an ack can report executedQty "0" for a MARKET order that filled
      takerPrice = Number(status?.avgPrice) || 0
      if (market?.orderId != null) orderIds.push(String(market.orderId))
    } catch (error) {
      // With part of the position already filled as maker, keep that (smaller) position rather than fail the trade; with nothing filled
      // there is no position, so the failure is the answer.
      if (makerQty <= 0) throw error
      notes.push(`Market order for the remaining ${remainder} failed (${error instanceof Error ? error.message : error}); kept the ${makerQty} filled as maker.`)
    }
  } else if (makerQty > 0 && makerQty < quantity) {
    notes.push('The unfilled remainder was below the exchange minimum; kept the maker fill only.')
  }

  const executedQty = makerQty + takerQty
  const avgPrice = executedQty > 0 && (makerPrice > 0 || takerPrice > 0)
    ? ((makerQty * (makerPrice || takerPrice)) + (takerQty * (takerPrice || makerPrice))) / executedQty
    : 0
  const last = market?.orderId != null ? market : limit
  return {
    executedQty,
    avgPrice,
    makerQty,
    takerQty,
    orderIds,
    orderId: last?.orderId != null ? String(last.orderId) : null,
    clientOrderId: last?.clientOrderId || null,
    notes,
  }
}
