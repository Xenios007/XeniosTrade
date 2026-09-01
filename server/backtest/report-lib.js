// Shared metric math for the backtest reports. Operates on already-labelled v2
// rows (each has row.label with pnl / netR / grossPnl / frictionUsd / win /
// tpBeforeSl / outcome). No future data is read here.

export const n2 = (x) => (Number.isFinite(Number(x)) ? Number(Number(x).toFixed(2)) : 0)
export const n4 = (x) => (Number.isFinite(Number(x)) ? Number(Number(x).toFixed(4)) : 0)
export const pctOf = (a, b) => (b ? n2((a / b) * 100) : 0)
export const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
export const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export const stdev = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}
export const yearOf = (r) => new Date(r.timestamp).getUTCFullYear()

export function groupBy(rows, keyFn) {
  const m = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}

// full metric bundle over a set of v2 rows
export function metrics(rows) {
  const ord = [...rows].sort((a, b) => a.timestamp - b.timestamp)
  const pnls = ord.map((r) => Number(r.label?.pnl ?? r.pnl ?? 0))
  const gross = ord.map((r) => Number(r.label?.grossPnl ?? r.grossPnl ?? r.label?.pnl ?? 0))
  const rs = ord.map((r) => Number(r.label?.netR ?? 0))
  const fric = ord.map((r) => Number(r.label?.frictionUsd ?? r.frictionUsd ?? 0))
  const n = ord.length
  const wins = pnls.filter((p) => p > 0).length
  const losses = pnls.filter((p) => p < 0).length
  let eq = 0
  let peak = 0
  let dd = 0
  let ws = 0
  let ls = 0
  let bw = 0
  let bl = 0
  let gw = 0
  let gl = 0
  for (const p of pnls) {
    eq += p
    peak = Math.max(peak, eq)
    dd = Math.max(dd, peak - eq)
    if (p > 0) { ws += 1; ls = 0; gw += p } else if (p < 0) { ls += 1; ws = 0; gl += -p }
    bw = Math.max(bw, ws)
    bl = Math.max(bl, ls)
  }
  const m = mean(pnls)
  const sd = stdev(pnls)
  const down = pnls.filter((p) => p < 0)
  const dsd = down.length ? Math.sqrt(mean(down.map((p) => p * p))) : 0
  return {
    trades: n,
    wins,
    losses,
    winRate: pctOf(wins, n),
    grossPnl: n2(gross.reduce((s, x) => s + x, 0)),
    netPnl: n2(pnls.reduce((s, x) => s + x, 0)),
    avgPnl: n4(m),
    medianPnl: n4(median(pnls)),
    expectancy: n4(m),
    profitFactor: gl > 0 ? n4(gw / gl) : (gw > 0 ? 999 : 0),
    avgR: n4(mean(rs)),
    medianR: n4(median(rs)),
    maxDrawdown: n2(dd),
    longestWinStreak: bw,
    longestLossStreak: bl,
    sharpe: sd > 0 ? n4((m / sd) * Math.sqrt(n)) : 0,
    sortino: dsd > 0 ? n4((m / dsd) * Math.sqrt(n)) : 0,
    // fee vs slippage split is run-dependent; caller can override with the run's bps ratio
    frictionUsd: n2(fric.reduce((s, x) => s + x, 0)),
  }
}

// friction split given the run's fee/slippage bps
export function splitFriction(totalFrictionUsd, feeBps, slipBps) {
  const denom = (feeBps + slipBps) || 1
  return { feeCost: n2(totalFrictionUsd * (feeBps / denom)), slippageCost: n2(totalFrictionUsd * (slipBps / denom)) }
}

export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map((r) => line(r.map((c) => (c == null ? '·' : String(c)))))].join('\n')
}
