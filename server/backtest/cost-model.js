// Execution cost regimes. Re-scores a stored backtest trade under different
// fee/slippage assumptions without re-running the replay.
//
// A stored row must carry: side, entryPrice, exitPrice, notional, stopLoss,
// grossPnl (pnl BEFORE friction), and configuredStopLossPercent.

export const COST_REGIMES = {
  NORMAL: { feeBps: 5, slippageBps: 2 },
  STRESS: { feeBps: 5, slippageBps: 5 },
  HIGH_STRESS: { feeBps: 7, slippageBps: 10 },
}

const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * @param {object} row  stored trade row
 * @param {{feeBps:number, slippageBps:number}} regime
 * @returns {{ netPnl:number, feeCost:number, slippageCost:number, R:number, win:boolean }}
 */
export function rescoreTrade(row, regime) {
  const notional = num(row.notional)
  const feeCost = notional * (num(regime.feeBps) / 10_000) * 2
  const slippageCost = notional * (num(regime.slippageBps) / 10_000) * 2
  const gross = row.grossPnl != null
    ? num(row.grossPnl)
    // fall back: reconstruct gross from stored net + the friction the run used
    : num(row.pnl) + (row.frictionUsd != null ? num(row.frictionUsd) : 0)
  const netPnl = gross - feeCost - slippageCost

  // risk in USDT: prefer explicit stop distance, else configured SL %
  const entry = num(row.entryPrice)
  const stop = num(row.stopLoss)
  let riskUsd = entry > 0 && stop > 0
    ? Math.abs(entry - stop) / entry * notional
    : notional * (num(row.configuredStopLossPercent) / 100)
  if (!(riskUsd > 0)) riskUsd = notional * 0.005
  const R = netPnl / riskUsd

  return {
    netPnl: Number(netPnl.toFixed(4)),
    feeCost: Number(feeCost.toFixed(4)),
    slippageCost: Number(slippageCost.toFixed(4)),
    R: Number(R.toFixed(4)),
    win: netPnl > 0,
  }
}

/**
 * Aggregate a set of rows under one cost regime.
 */
export function aggregateUnderRegime(rows, regime) {
  let n = 0
  let wins = 0
  let net = 0
  let grossWin = 0
  let grossLoss = 0
  let feeTot = 0
  let slipTot = 0
  const Rs = []
  for (const row of rows) {
    const r = rescoreTrade(row, regime)
    n += 1
    if (r.win) wins += 1
    net += r.netPnl
    if (r.netPnl > 0) grossWin += r.netPnl
    else grossLoss += -r.netPnl
    feeTot += r.feeCost
    slipTot += r.slippageCost
    Rs.push(r.R)
  }
  const avgR = Rs.length ? Rs.reduce((s, x) => s + x, 0) / Rs.length : 0
  return {
    trades: n,
    wins,
    winRate: n ? Number(((wins / n) * 100).toFixed(2)) : 0,
    netPnl: Number(net.toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : (grossWin > 0 ? Infinity : 0),
    expectancy: n ? Number((net / n).toFixed(4)) : 0,
    avgR: Number(avgR.toFixed(4)),
    feeCost: Number(feeTot.toFixed(2)),
    slippageCost: Number(slipTot.toFixed(2)),
  }
}
