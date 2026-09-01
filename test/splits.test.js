import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSplitBoundaries, assignSplit, walkForwardFolds, symbolHoldout,
  SPLIT_EMBARGO_MS, TRAIN_FRACTION, VAL_FRACTION,
} from '../server/backtest/splits.js'

const MONTH = 30 * 86_400_000
const start = Date.UTC(2021, 0, 1)
const end = start + 60 * MONTH

test('boundaries: 60/20/20 of the genuine history span', () => {
  const b = computeSplitBoundaries(start, end)
  assert.equal(b.startMs, start)
  assert.equal(b.endMs, end)
  assert.equal(b.trainEnd, start + 60 * MONTH * TRAIN_FRACTION)
  assert.equal(b.valEnd, start + 60 * MONTH * (TRAIN_FRACTION + VAL_FRACTION))
  assert.equal(b.embargoMs, SPLIT_EMBARGO_MS)
})

test('assignSplit: chronological ordering train < val < holdout', () => {
  const b = computeSplitBoundaries(start, end)
  assert.equal(assignSplit(start + 10 * MONTH, b), 'train')
  assert.equal(assignSplit(start + 40 * MONTH, b), 'val')
  assert.equal(assignSplit(start + 55 * MONTH, b), 'holdout')
})

test('assignSplit: purge/embargo zone around each boundary', () => {
  const b = computeSplitBoundaries(start, end)
  // just inside the embargo on either side of trainEnd -> purged
  assert.equal(assignSplit(b.trainEnd - SPLIT_EMBARGO_MS / 2, b), 'purged')
  assert.equal(assignSplit(b.trainEnd + SPLIT_EMBARGO_MS / 2, b), 'purged')
  assert.equal(assignSplit(b.valEnd - SPLIT_EMBARGO_MS / 2, b), 'purged')
  // outside the embargo -> not purged
  assert.notEqual(assignSplit(b.trainEnd - SPLIT_EMBARGO_MS * 2, b), 'purged')
})

test('short-history symbol: still keeps an untouched holdout tail', () => {
  const shortEnd = start + 9 * MONTH
  const b = computeSplitBoundaries(start, shortEnd)
  assert.equal(assignSplit(shortEnd - 100, b), 'holdout')
  // last ~20% is holdout
  assert.equal(assignSplit(start + 8 * MONTH, b), 'holdout')
  assert.equal(assignSplit(start + 3 * MONTH, b), 'train')
})

test('walk-forward folds: test windows stay inside train+val, never holdout', () => {
  const b = computeSplitBoundaries(start, end)
  const folds = walkForwardFolds(b, 4)
  assert.equal(folds.length, 4)
  for (const f of folds) {
    assert.ok(f.trainEnd < f.testStart, 'embargo gap between train and test')
    assert.ok(f.testEnd <= b.valEnd + 1, 'fold test window must not enter holdout')
    assert.ok(f.trainStart === b.startMs)
  }
})

test('symbolHoldout: deterministic and fully partitions the input', () => {
  const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT']
  const a = symbolHoldout(syms, 3)
  const b = symbolHoldout(syms, 3)
  assert.deepEqual(a, b)
  assert.equal(a.holdoutSymbols.length, 3)
  assert.equal(a.trainSymbols.length, 5)
  assert.deepEqual(
    [...a.trainSymbols, ...a.holdoutSymbols].sort(),
    [...syms].sort(),
  )
  // no overlap
  for (const s of a.holdoutSymbols) assert.ok(!a.trainSymbols.includes(s))
})
