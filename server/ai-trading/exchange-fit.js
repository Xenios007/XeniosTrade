// Pure sizing helpers for the exchange's minimum order size. Kept free of imports so the pipeline (what the Risk Manager is told,
// and its early veto) and the executor (the order that is actually placed) use exactly the same numbers.
//
// The problem: a real-money position is scaled down to the margin cap, so it can be smaller than the exchange's minimum order for
// the symbol (e.g. ETHUSDT needs 20 USDT of position). Leverage turns the same margin into a bigger position, so when the sized
// position is too small we raise leverage - only as far as needed, never past the leverage ceiling, never past the position the Risk
// Manager itself sized, and only while the stop stays safely inside the liquidation distance.

export const AVAILABLE_BALANCE_USAGE = 0.9
// Headroom over the exchange minimum so lot-step rounding and a small price move cannot drop the order back under it.
const MIN_ORDER_BUFFER = 1.02
// Same 90% rule the Risk Manager uses: the stop must sit well inside the liquidation distance (100 / leverage).
const LIQUIDATION_SAFETY = 0.9

const fx = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a')

/** Margin allowed on one trade: 90% of the available balance, and on real money also the configured cap. 0 = no margin. */
export function marginCapFor({ mode, availableUsdt, realMaxMarginUsdt }) {
  const available = Number(availableUsdt)
  if (!(available > 0)) return 0
  const cap = available * AVAILABLE_BALANCE_USAGE
  return mode === 'real' ? Math.min(cap, Number(realMaxMarginUsdt) || 0) : cap
}

/** Smallest order value (USDT) the exchange accepts for a symbol at `price`: whole lot steps, >= minQty, >= the notional filter. */
export function minOrderNotional({ minNotional = 0, minQty = 0, stepSize = 0, price }) {
  if (!(Number(price) > 0)) return 0
  let quantity = Math.max(Number(minQty) || 0, (Number(minNotional) || 0) / price)
  const step = Number(stepSize)
  if (step > 0) quantity = Math.ceil(quantity / step - 1e-9) * step
  return quantity * price
}

/**
 * What position and leverage would actually be opened for a plan, given the margin cap and the exchange minimum.
 *
 * @param {object} args
 * @param {number} args.planNotional   the Risk Manager's sized position (USDT)
 * @param {number} args.planLeverage   the leverage that sizing produced
 * @param {number} args.marginCap      margin allowed on this trade (marginCapFor)
 * @param {number} args.minOrderUsdt   exchange minimum order value (minOrderNotional); 0/undefined = unknown, nothing to fit
 * @param {number} args.maxLeverage    the leverage ceiling (code, not the model)
 * @param {number} args.stopLossPct    the plan's stop distance in percent
 * @returns {{ ok: boolean, changed: boolean, leverage: number, notional: number, margin: number, minOrderUsdt: number, reason?: string }}
 */
export function fitPlanToExchangeMinimum({ planNotional, planLeverage, marginCap, minOrderUsdt, maxLeverage, stopLossPct }) {
  const leverage0 = Math.max(Number(planLeverage) || 1, 1)
  const notional0 = Math.min(Number(planNotional) || 0, (Number(marginCap) || 0) * leverage0)
  const unchanged = { ok: true, changed: false, leverage: leverage0, notional: notional0, margin: notional0 / leverage0, minOrderUsdt: minOrderUsdt || 0 }
  if (!(minOrderUsdt > 0) || notional0 >= minOrderUsdt) return unchanged

  const fail = (reason) => ({ ...unchanged, ok: false, reason })
  if (!(marginCap > 0)) return fail('No margin is available for this trade, so it cannot reach the exchange minimum order.')

  const target = minOrderUsdt * MIN_ORDER_BUFFER
  if (target > planNotional) {
    return fail(`The Risk Manager's position (${fx(planNotional)} USDT) is smaller than the exchange minimum order (${fx(minOrderUsdt)} USDT), and the code never sizes a trade above the plan.`)
  }
  const needed = Math.ceil(target / marginCap - 1e-9)
  if (needed > maxLeverage) {
    return fail(`Reaching the exchange minimum order (${fx(minOrderUsdt)} USDT) with ${fx(marginCap)} USDT of margin needs ${needed}x leverage, above the ${maxLeverage}x ceiling. Raise the margin cap or trade a symbol with a smaller minimum.`)
  }
  const leverage = Math.max(needed, leverage0)
  const liquidationDistancePct = (100 / leverage) * LIQUIDATION_SAFETY
  if (Number(stopLossPct) >= liquidationDistancePct) {
    return fail(`At ${leverage}x (needed to reach the exchange minimum) the ${fx(stopLossPct)}% stop is not safely inside the ~${fx(liquidationDistancePct)}% liquidation distance.`)
  }
  return { ok: true, changed: true, leverage, notional: target, margin: target / leverage, minOrderUsdt }
}
