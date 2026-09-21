// Per-day limits for automatic real-money trading: a profit lock, a loss stop and a trade cap. Pure (no I/O) so it is unit-testable; the scan
// planner and the executor both call it, so a limit stops new AUTOMATIC entries everywhere (manual execution stays the operator's call).
//
// "Today" is the Asia/Manila calendar day, the same day key the rest of the app uses for trades. Realized P&L is the closed AI trades' `pnl`
// minus an estimated round-trip fee (the recorded pnl is price P&L only), so a target is reached on money actually kept, not on gross moves.
// Only real mode is limited: testnet is fake money and is left free to keep testing.

export const DAILY_FEE_ROUND_TRIP_PCT = 0.1

export function manilaDay(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

const isOpen = (trade) => String(trade?.status || '').toUpperCase() === 'OPEN'
const round2 = (value) => Math.round(value * 100) / 100

/** Price P&L of a closed trade minus the estimated fee on its notional. */
export function tradeNetPnl(trade, feePct = DAILY_FEE_ROUND_TRIP_PCT) {
  // An unknown P&L (null / missing) must stay unknown: Number(null) is 0, which would charge a fee against a trade with no result.
  const raw = trade?.pnl
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) return 0
  return Number(raw) - (Number(trade?.notional) || 0) * (feePct / 100)
}

/**
 * Today's realized result for one trading mode and whether a limit now blocks NEW automatic trades.
 * `execution` carries dailyProfitTargetUsdt / dailyMaxLossUsdt / dailyMaxTrades (0 = that limit is off).
 */
export function dailyStatus({ trades = [], mode = 'real', now = Date.now(), execution = {} } = {}) {
  const dateKey = manilaDay(now)
  const mine = trades.filter((trade) => trade?.aiTradingMode === mode)
  const closedToday = mine.filter((trade) => !isOpen(trade) && trade.closedDateKey === dateKey)
  const openedToday = mine.filter((trade) => trade.tradeDateKey === dateKey || (!trade.tradeDateKey && manilaDay(Number(trade.transactTime) || 0) === dateKey))
  const nets = closedToday.map((trade) => tradeNetPnl(trade))
  const realized = round2(nets.reduce((sum, value) => sum + value, 0))
  const target = Number(execution.dailyProfitTargetUsdt) || 0
  const maxLoss = Number(execution.dailyMaxLossUsdt) || 0
  const maxTrades = Math.floor(Number(execution.dailyMaxTrades)) || 0

  let blocked = null
  if (mode === 'real') {
    if (target > 0 && realized >= target) {
      blocked = { code: 'profit', reason: `Daily profit target reached: ${realized >= 0 ? '+' : ''}${realized.toFixed(2)} of +${target} USDT realized today (after estimated fees). No new automatic real-money trades until tomorrow (Manila time).` }
    } else if (maxLoss > 0 && realized <= -maxLoss) {
      blocked = { code: 'loss', reason: `Daily loss limit reached: ${realized.toFixed(2)} USDT realized today (limit -${maxLoss}). No new automatic real-money trades until tomorrow (Manila time).` }
    } else if (maxTrades > 0 && openedToday.length >= maxTrades) {
      blocked = { code: 'trades', reason: `Daily trade limit reached: ${openedToday.length} of ${maxTrades} real-money trades opened today. No new automatic trades until tomorrow (Manila time).` }
    }
  }

  return {
    dateKey,
    mode,
    realizedUsdt: realized,
    tradesOpened: openedToday.length,
    tradesClosed: closedToday.length,
    wins: nets.filter((value) => value > 0).length,
    losses: nets.filter((value) => value <= 0).length,
    profitTargetUsdt: target,
    maxLossUsdt: maxLoss,
    maxTrades,
    blocked,
  }
}
