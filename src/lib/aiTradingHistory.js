// Pure helpers for the AI Trading "Run History" timeline. Shared by the server (which keeps the scan log) and the
// page (which merges it with the saved runs), and free of I/O so they are unit-testable.
//
// Two sources feed the timeline:
//  - saved runs (`runs.json`): the full pipeline report, kept for runs where the Analyst went LONG/SHORT or a trade opened;
//  - the scan log (`scan-log.json`): one light entry per symbol per scan cycle, including the Analyst HOLDs and errors
//    that are deliberately NOT saved as runs (they would push real decisions out of the 50-run history).

export const MAX_SCAN_LOG_ENTRIES = 500

/**
 * Appends `incoming` scan entries (newest first) to `existing`, capped at `max`. A `skipped` entry that repeats the
 * previous entry for the same symbol (same reason, e.g. "Already has an open AI position") is dropped: it would
 * otherwise flood the log every 5 minutes with no new information.
 */
export function mergeScanLog(existing, incoming, max = MAX_SCAN_LOG_ENTRIES) {
  const log = Array.isArray(existing) ? existing : []
  const accepted = []
  for (const entry of incoming) {
    if (entry.outcome === 'skipped') {
      const previous = [...accepted, ...log].find((item) => item.symbol === entry.symbol)
      if (previous && previous.outcome === 'skipped' && previous.detail === entry.detail) continue
    }
    accepted.unshift(entry)
  }
  return [...accepted, ...log].slice(0, max)
}

/**
 * One newest-first list of `{ kind: 'run', at, run }` and `{ kind: 'scan', at, entry }` items.
 * A scan entry that has a saved run is shown as that run (the full report), not twice.
 */
export function buildHistoryFeed(runs, scanLog) {
  const savedIds = new Set((runs || []).map((run) => run.id))
  const items = [
    ...(runs || []).map((run) => ({ kind: 'run', at: Number(run.startedAt) || 0, run })),
    ...(scanLog || [])
      .filter((entry) => !(entry.runId && savedIds.has(entry.runId)))
      .map((entry) => ({ kind: 'scan', at: Number(entry.at) || 0, entry })),
  ]
  return items.sort((a, b) => b.at - a.at)
}

export const HISTORY_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'signals', label: 'Signals & trades' },
  { id: 'errors', label: 'Errors' },
]

/** True when the item is a failure: an errored scan entry, or a saved run with a failed stage / failed open. */
function isErrorItem(item) {
  if (item.kind === 'scan') return item.entry.outcome === 'error'
  const run = item.run
  return run.execution?.status === 'failed' || (run.stages || []).some((stage) => stage.status === 'error')
}

export function filterHistoryFeed(feed, filter) {
  if (filter === 'signals') return feed.filter((item) => item.kind === 'run')
  if (filter === 'errors') return feed.filter(isErrorItem)
  return feed
}
