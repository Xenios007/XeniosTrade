// AI Trading experiments: each strategy setting (config.strategy, tagged by aiStrategyTag, e.g. 'swing+trend+fee+lean+maker') is its own
// experiment with its own journal, trade history, run log and shadow results, so results from one never blur into another's.
// Everything recorded before strategies existed has no tag and belongs to 'scalp' - the original 5-agent 5M pipeline.
// Pure helpers, shared by the pages (and unit-tested).

import { AI_TRADING_ROUND_TRIP_FEE_PCT, AI_TRADING_TIMEFRAMES } from './aiTrading.js'

export const ALL_EXPERIMENTS = 'all'
export const LEGACY_EXPERIMENT = 'scalp'

/** The experiment a trade (aiStrategy), run / scan entry / shadow signal (strategy) belongs to. */
export function experimentTagOf(item) {
  return item?.aiStrategy || item?.strategy || LEGACY_EXPERIMENT
}

/** Human description of an experiment tag: a short name, the trade style, and the switches that were on. */
export function describeExperiment(tag) {
  if (tag === ALL_EXPERIMENTS) {
    return { tag, name: 'All experiments', style: 'Every pipeline setting combined', switches: [], agents: null }
  }
  const [timeframeId, ...flags] = String(tag || LEGACY_EXPERIMENT).split('+')
  const timeframe = AI_TRADING_TIMEFRAMES[timeframeId] || AI_TRADING_TIMEFRAMES.scalp
  const has = (flag) => flags.includes(flag)
  const agents = has('lean') ? 3 : 5
  const switches = [has('trend') && 'trend filter', has('fee') && 'fee-aware rules', has('maker') && 'maker entry'].filter(Boolean)
  const frame = timeframe.id === 'swing' ? 'Swing' : 'Scalp'
  const legacy = tag === LEGACY_EXPERIMENT
  return {
    tag,
    agents,
    timeframe: timeframe.id,
    name: `${agents}-agent ${frame}${legacy ? ' (original)' : ''}${switches.length ? ` · ${switches.join(', ')}` : ''}`,
    style: timeframe.id === 'swing'
      ? `${timeframe.entry.label} entries, ${timeframe.bias.label} trend, ${timeframe.regime?.label || timeframe.context.label} confirmation; holds ${timeframe.holdHint}`
      : `${timeframe.entry.label} entries, ${timeframe.bias.label} trend; holds ${timeframe.holdHint}`,
    switches,
  }
}

/**
 * The dropdown options: every experiment that has data, plus the one configured now (which may have none yet), current first, then
 * newest first by the latest activity seen for it, then 'All experiments'.
 */
export function listExperiments({ items = [], current = null } = {}) {
  const latest = new Map()
  for (const item of items) {
    const tag = experimentTagOf(item)
    const at = Number(item?.startedAt ?? item?.transactTime ?? item?.at ?? 0) || 0
    latest.set(tag, Math.max(latest.get(tag) ?? 0, at))
  }
  if (current && !latest.has(current)) latest.set(current, Number.MAX_SAFE_INTEGER)
  const tags = [...latest.keys()].sort((a, b) => (a === current ? -1 : b === current ? 1 : latest.get(b) - latest.get(a)))
  return [...tags.map((tag) => ({ ...describeExperiment(tag), current: tag === current })), describeExperiment(ALL_EXPERIMENTS)]
}

export function filterByExperiment(items, tag) {
  if (!Array.isArray(items)) return []
  if (!tag || tag === ALL_EXPERIMENTS) return items
  return items.filter((item) => experimentTagOf(item) === tag)
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
const round = (value, digits = 2) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)))

/**
 * The numbers that tell two experiments apart. `pnl` on a trade is the price move only, so fees are ESTIMATED at the taker round trip
 * on the notional (a maker entry pays less; the estimate is on the conservative side).
 */
export function summarizeExperimentTrades(trades, { feePct = AI_TRADING_ROUND_TRIP_FEE_PCT } = {}) {
  const closed = (trades || []).filter((trade) => trade.status && trade.status !== 'OPEN' && Number.isFinite(Number(trade.pnl)))
  const pnls = closed.map((trade) => Number(trade.pnl))
  const wins = pnls.filter((pnl) => pnl > 0)
  const losses = pnls.filter((pnl) => pnl <= 0)
  const grossWin = wins.reduce((sum, value) => sum + value, 0)
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0))
  const pnl = pnls.reduce((sum, value) => sum + value, 0)
  const fees = closed.reduce((sum, trade) => sum + (Math.abs(Number(trade.notional)) || 0) * (feePct / 100), 0)
  const pct = (trade, level) => {
    const entry = Number(trade.entryPrice)
    const price = Number(trade[level])
    return entry > 0 && price > 0 ? (Math.abs(price - entry) / entry) * 100 : null
  }
  const holds = closed
    .map((trade) => (Number(trade.closedAt) - Number(trade.transactTime)) / 60_000)
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0)
  const byExit = {}
  for (const trade of closed) {
    const key = trade.status === 'CLOSED_MANUAL' ? (trade.closedBy === 'position-manager' ? 'position-manager' : 'manual') : String(trade.result || trade.status || 'other').toLowerCase()
    byExit[key] = (byExit[key] || 0) + 1
  }
  return {
    trades: (trades || []).length,
    open: (trades || []).filter((trade) => trade.status === 'OPEN').length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? round(wins.length / closed.length, 4) : null,
    pnl: round(pnl),
    estFees: round(fees),
    netPnl: round(pnl - fees),
    avgWin: round(mean(wins)),
    avgLoss: round(mean(losses)),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    avgHoldMinutes: round(mean(holds), 0),
    avgStopPct: round(mean(closed.map((trade) => pct(trade, 'initialStopLoss')).filter((value) => value != null)), 3),
    avgTargetPct: round(mean(closed.map((trade) => pct(trade, 'initialTakeProfit')).filter((value) => value != null)), 3),
    avgLeverage: round(mean(closed.map((trade) => Number(trade.leverage)).filter((value) => value > 0)), 1),
    byExit,
  }
}
