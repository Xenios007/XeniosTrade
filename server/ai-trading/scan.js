// Auto-scan decisions, kept pure (no I/O) so they are unit-testable. The loop in
// mock-trading-server.js does the fetching, calls runAiTradingPipeline per symbol
// and applies these rules; nothing here can place an order.

import { AI_SCAN_COOLDOWN_MS } from '../../src/lib/aiTrading.js'
import { MAX_OPEN_POSITIONS, isOpenAiTrade } from './execution.js'

function closedAtOf(trade) {
  return Number(trade?.closedAt || trade?.transactTime || 0)
}

/**
 * Splits the enabled symbols into the ones worth a pipeline run now and the ones to skip, with a reason.
 * A run is wasted LLM spend (and a duplicate entry) when the symbol already has an open AI position, was closed
 * moments ago, is being analysed right now, or the wallet is already at its position cap.
 */
export function planScanCycle({ symbols, trades = [], mode = 'testnet', now = Date.now(), inFlight = new Set(), cooldownMs = AI_SCAN_COOLDOWN_MS }) {
  const toRun = []
  const skipped = []
  const openInMode = trades.filter((trade) => isOpenAiTrade(trade) && trade.aiTradingMode === mode).length
  const atCap = openInMode >= (MAX_OPEN_POSITIONS[mode] ?? 1)

  for (const symbol of symbols) {
    const own = trades.filter((trade) => trade.symbol === symbol)
    if (inFlight.has(symbol)) {
      skipped.push({ symbol, reason: 'A run for this symbol is already in progress.' })
    } else if (own.some(isOpenAiTrade)) {
      skipped.push({ symbol, reason: 'Already has an open AI position.' })
    } else if (atCap) {
      skipped.push({ symbol, reason: `The ${mode} wallet is at its ${MAX_OPEN_POSITIONS[mode]}-position limit.` })
    } else if (own.some((trade) => !isOpenAiTrade(trade) && now - closedAtOf(trade) < cooldownMs && closedAtOf(trade) > 0)) {
      skipped.push({ symbol, reason: `Closed less than ${Math.round(cooldownMs / 60_000)} min ago (cooldown).` })
    } else {
      toRun.push(symbol)
    }
  }
  return { toRun, skipped }
}

/** One line per symbol for the status panel: what the scan concluded and why. */
export function summarizeScanResult(run, now = Date.now()) {
  const analyst = run.stages?.find((stage) => stage.id === 'analyst')
  if (analyst?.status === 'error') {
    return { at: now, outcome: 'error', detail: String(analyst.error || run.final?.reason || 'The Market Analyst failed.').slice(0, 240), runId: run.id }
  }
  const final = run.final || {}
  if (run.execution?.status === 'opened') {
    return { at: now, outcome: 'opened', detail: `${final.action} opened on ${run.execution.mode}.`, runId: run.id }
  }
  if (run.execution?.status === 'failed') {
    return { at: now, outcome: 'error', detail: `Approved ${final.action} but it could not be opened: ${run.execution.error}`.slice(0, 240), runId: run.id }
  }
  if (final.approved) {
    return { at: now, outcome: 'approved', detail: `${final.action} approved — open it from Run History.`, runId: run.id }
  }
  return { at: now, outcome: 'hold', detail: String(final.reason || 'No trade.').slice(0, 240), runId: run.id }
}

/**
 * Runs where the Analyst just said HOLD (or failed) are one cheap call each and would push the real decisions out of
 * the 50-run history within an hour, so a scan keeps only runs that went past the Analyst; the per-symbol status keeps the rest.
 */
export function shouldPersistScanRun(run) {
  const analyst = run.stages?.find((stage) => stage.id === 'analyst')
  const action = analyst?.output?.action
  return Boolean(run.execution) || action === 'LONG' || action === 'SHORT'
}
