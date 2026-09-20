// Quant Agent's evidence: win-rate / payoff statistics from the ~117k backtest
// trades in server/data/backtest-history.json.
//
// That file is ~116 MB — parsing it inside the pm2 API process would blow its
// 896 MB heap cap — so scripts/build-ai-trading-quant-stats.js aggregates it
// once, offline, into a small bucket table (server/data/ai-trading/quant-stats.json)
// and the server only ever reads that. Re-run the script after a new backtest.
//
// Honest limitation, surfaced in the UI: these are trades from the rule-based
// Bots 1-4, not from the Market Analyst, so "similar" means same symbol, same
// direction and a similar stop distance — not the same setup.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const QUANT_STATS_FILE = path.join(__dirname, '..', 'data', 'ai-trading', 'quant-stats.json')
export const QUANT_MIN_SAMPLE = 30
const WILSON_Z = 1.645 // one-sided 95%

export function stopLossBucket(stopLossPct) {
  const pct = Number(stopLossPct)
  if (!Number.isFinite(pct) || pct < 0.4) return 'lt0.4'
  if (pct < 0.8) return '0.4-0.8'
  if (pct < 1.5) return '0.8-1.5'
  return 'gte1.5'
}

const STOP_BUCKETS = ['lt0.4', '0.4-0.8', '0.8-1.5', 'gte1.5']

const emptyCell = () => ({ n: 0, wins: 0, sumWin: 0, sumLoss: 0 })

function addTo(cell, pnl) {
  cell.n += 1
  if (pnl > 0) {
    cell.wins += 1
    cell.sumWin += pnl
  } else {
    cell.sumLoss += Math.abs(pnl)
  }
}

function mergeCells(cells) {
  const total = emptyCell()
  for (const cell of cells) {
    if (!cell) continue
    total.n += cell.n
    total.wins += cell.wins
    total.sumWin += cell.sumWin
    total.sumLoss += cell.sumLoss
  }
  return total
}

/** Streaming accumulator: feed it backtest trades one at a time, then call finalize(). */
export function createQuantStatsAccumulator() {
  const buckets = {}
  let tradeCount = 0

  return {
    add(trade) {
      const pnl = Number(trade?.pnl)
      const side = trade?.side === 'BUY' ? 'LONG' : trade?.side === 'SELL' ? 'SHORT' : null
      if (!side || !trade?.symbol || !Number.isFinite(pnl)) return
      const key = `${trade.symbol}|${side}|${stopLossBucket(trade.configuredStopLossPercent)}`
      addTo((buckets[key] ||= emptyCell()), pnl)
      tradeCount += 1
    },
    finalize(source = 'backtest-history.json') {
      const rounded = {}
      for (const [key, cell] of Object.entries(buckets)) {
        rounded[key] = { ...cell, sumWin: Math.round(cell.sumWin * 100) / 100, sumLoss: Math.round(cell.sumLoss * 100) / 100 }
      }
      return { generatedAt: Date.now(), source, tradeCount, buckets: rounded }
    },
  }
}

let cachedStats = null
let cachedStamp = null

/** Reads the aggregated table (mtime-cached). Returns null when it hasn't been built yet. */
export async function loadQuantStats(file = QUANT_STATS_FILE) {
  try {
    const stat = await fs.stat(file)
    const stamp = `${file}:${stat.mtimeMs}:${stat.size}`
    if (cachedStats && cachedStamp === stamp) return cachedStats
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!parsed || typeof parsed.buckets !== 'object') return null
    cachedStats = parsed
    cachedStamp = stamp
    return parsed
  } catch {
    return null
  }
}

function wilsonLowerBound(wins, n) {
  if (n <= 0) return 0
  const p = wins / n
  const z2 = WILSON_Z * WILSON_Z
  const centre = p + z2 / (2 * n)
  const margin = WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return Math.max(0, (centre - margin) / (1 + z2 / n))
}

const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)

function selectCells(stats, level, { symbol, side, bucket }) {
  const entries = Object.entries(stats.buckets)
  const match = (predicate) => mergeCells(entries.filter(([key]) => predicate(key.split('|'))).map(([, cell]) => cell))

  switch (level) {
    case 'symbol+side+stop':
      return match(([s, d, b]) => s === symbol && d === side && b === bucket)
    case 'symbol+side':
      return match(([s, d]) => s === symbol && d === side)
    case 'side+stop':
      return match(([, d, b]) => d === side && b === bucket)
    default:
      return match(([, d]) => d === side)
  }
}

/**
 * Expected value of the proposed trade side per unit risked (R), from the most
 * specific bucket that has at least QUANT_MIN_SAMPLE trades.
 *
 * evR uses the historical win rate and payoff; conservativeEvR swaps in the
 * lower 95% Wilson bound of the win rate. Verdict:
 *   SUPPORTS  conservative EV > 0
 *   NEUTRAL   EV > 0 but not distinguishable from luck, or too little data
 *   AGAINST   EV <= 0 on an adequate sample
 */
export function lookupQuantEdge(stats, { symbol, side, stopLossPct, takeProfitPct }) {
  const proposedRewardRisk = stopLossPct > 0 ? takeProfitPct / stopLossPct : null
  const base = {
    symbol,
    side,
    proposedRewardRisk: round(proposedRewardRisk, 2),
    breakEvenWinRate: proposedRewardRisk > 0 ? round(1 / (1 + proposedRewardRisk)) : null,
  }

  if (!stats?.buckets || !Object.keys(stats.buckets).length) {
    return { ...base, available: false, verdict: 'NEUTRAL', note: 'No backtest statistics built yet — run `npm run ai-trading:quant-stats`.' }
  }

  const bucket = stopLossBucket(stopLossPct)
  const levels = ['symbol+side+stop', 'symbol+side', 'side+stop', 'side']
  let chosen = null
  let cell = null
  for (const level of levels) {
    const candidate = selectCells(stats, level, { symbol, side, bucket })
    if (candidate.n >= QUANT_MIN_SAMPLE) {
      chosen = level
      cell = candidate
      break
    }
  }

  if (!cell) {
    return { ...base, available: false, verdict: 'NEUTRAL', note: `Fewer than ${QUANT_MIN_SAMPLE} similar backtest trades for ${symbol} ${side}.` }
  }

  const losses = cell.n - cell.wins
  const winRate = cell.wins / cell.n
  const winRateLow = wilsonLowerBound(cell.wins, cell.n)
  const avgWin = cell.wins ? cell.sumWin / cell.wins : 0
  const avgLoss = losses ? cell.sumLoss / losses : 0
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : null

  if (payoffRatio == null) {
    return { ...base, available: false, verdict: 'NEUTRAL', note: 'Similar trades had no losses to size a payoff ratio against.' }
  }

  const evR = winRate * payoffRatio - (1 - winRate)
  const conservativeEvR = winRateLow * payoffRatio - (1 - winRateLow)
  const verdict = conservativeEvR > 0 ? 'SUPPORTS' : evR > 0 ? 'NEUTRAL' : 'AGAINST'

  return {
    ...base,
    available: true,
    level: chosen,
    stopLossBucket: bucket,
    sampleSize: cell.n,
    winRate: round(winRate),
    winRateLow: round(winRateLow),
    payoffRatio: round(payoffRatio, 2),
    expectedValueR: round(evR),
    conservativeEvR: round(conservativeEvR),
    verdict,
    note: `Backtests of the rule-based Bots 1-4 (${chosen}); similar means same symbol/direction/stop distance, not the same setup.`,
  }
}

export { STOP_BUCKETS }
