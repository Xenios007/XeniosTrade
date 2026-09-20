import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHistoryFeed, filterHistoryFeed, mergeScanLog } from '../src/lib/aiTradingHistory.js'

const entry = (symbol, at, outcome = 'hold', extra = {}) => ({ symbol, at, outcome, detail: `${symbol} ${outcome}`, ...extra })

test('mergeScanLog: newest first, capped, and a repeated skip for the same symbol is not logged again', () => {
  const first = mergeScanLog([], [entry('BTCUSDT', 1), entry('ETHUSDT', 2)])
  assert.deepEqual(first.map((item) => item.symbol), ['ETHUSDT', 'BTCUSDT'], 'incoming order is oldest-to-newest within a cycle; the log is newest first')

  const skipped = mergeScanLog([], [entry('BTCUSDT', 1, 'skipped')])
  assert.equal(mergeScanLog(skipped, [entry('BTCUSDT', 2, 'skipped')]).length, 1, 'same symbol, same reason: dropped')
  assert.equal(mergeScanLog(skipped, [{ ...entry('BTCUSDT', 2, 'skipped'), detail: 'different reason' }]).length, 2)
  assert.equal(mergeScanLog(skipped, [entry('ETHUSDT', 2, 'skipped')]).length, 2, 'another symbol is unaffected')
  assert.equal(mergeScanLog(mergeScanLog(skipped, [entry('BTCUSDT', 2, 'hold')]), [entry('BTCUSDT', 3, 'skipped')]).length, 3, 'a hold in between resets the dedupe')

  const many = Array.from({ length: 10 }, (_unused, index) => entry('BTCUSDT', index))
  assert.equal(mergeScanLog([], many, 4).length, 4)
  assert.equal(mergeScanLog(undefined, [entry('BTCUSDT', 1)]).length, 1, 'a missing/corrupt existing log is treated as empty')
})

test('buildHistoryFeed: merges runs and scan entries by time, and shows a scanned run once (as the run)', () => {
  const runs = [{ id: 'run-b', startedAt: 300, symbol: 'ETHUSDT' }, { id: 'run-a', startedAt: 100, symbol: 'BTCUSDT' }]
  const scanLog = [
    entry('ETHUSDT', 310, 'opened', { runId: 'run-b' }),
    entry('SOLUSDT', 250),
    entry('BTCUSDT', 110, 'approved', { runId: 'run-gone' }),
    entry('XRPUSDT', 50, 'error'),
  ]
  const feed = buildHistoryFeed(runs, scanLog)
  assert.deepEqual(feed.map((item) => `${item.kind}:${item.run?.id || item.entry.symbol}`), ['run:run-b', 'scan:SOLUSDT', 'scan:BTCUSDT', 'run:run-a', 'scan:XRPUSDT'])
  assert.equal(buildHistoryFeed(null, null).length, 0)
})

test('filterHistoryFeed: signals = saved runs, errors = errored scans plus runs with a failed stage or failed open', () => {
  const runs = [
    { id: 'ok', startedAt: 4, stages: [{ status: 'ok' }] },
    { id: 'stage-error', startedAt: 3, stages: [{ status: 'ok' }, { status: 'error' }] },
    { id: 'open-failed', startedAt: 2, stages: [], execution: { status: 'failed' } },
  ]
  const feed = buildHistoryFeed(runs, [entry('BTCUSDT', 1, 'error'), entry('ETHUSDT', 5, 'hold')])
  assert.equal(filterHistoryFeed(feed, 'all').length, 5)
  assert.deepEqual(filterHistoryFeed(feed, 'signals').map((item) => item.run.id), ['ok', 'stage-error', 'open-failed'])
  assert.deepEqual(filterHistoryFeed(feed, 'errors').map((item) => item.run?.id || item.entry.symbol), ['stage-error', 'open-failed', 'BTCUSDT'])
})
