// Chronological time-series splitting with purge + embargo.
//
// For a symbol with ~60 months of history:
//   months  1-36  -> TRAIN
//   months 37-48  -> VALIDATION / model selection / walk-forward
//   months 49-60  -> HOLDOUT (untouched; never influences anything)
//
// Shorter-history symbols get the same 60/20/20 proportion of their genuine
// history, always keeping a real untouched tail.
//
// Purge/embargo: samples whose entry time is within `embargoMs` of a split
// boundary are dropped so a trade that could still be open at the boundary
// cannot leak across it. embargoMs defaults to the max outcome horizon (48h).

export const SPLIT_EMBARGO_MS = 48 * 3_600_000

export const TRAIN_FRACTION = 0.60
export const VAL_FRACTION = 0.20
// holdout = remainder

/**
 * @param {number} startMs  first genuine candle time for the symbol
 * @param {number} endMs    last candle time
 * @param {number} [embargoMs]
 * @returns {{ trainEnd:number, valEnd:number, startMs:number, endMs:number, embargoMs:number }}
 */
export function computeSplitBoundaries(startMs, endMs, embargoMs = SPLIT_EMBARGO_MS) {
  const span = Math.max(0, endMs - startMs)
  const trainEnd = startMs + span * TRAIN_FRACTION
  const valEnd = startMs + span * (TRAIN_FRACTION + VAL_FRACTION)
  return { startMs, endMs, trainEnd, valEnd, embargoMs }
}

/**
 * Assign a split tag to an entry timestamp. Returns 'train' | 'val' | 'holdout'
 * | 'purged'. `purged` rows must be excluded from every stage.
 */
export function assignSplit(tMs, boundaries) {
  const { trainEnd, valEnd, embargoMs } = boundaries
  if (Math.abs(tMs - trainEnd) < embargoMs) return 'purged'
  if (Math.abs(tMs - valEnd) < embargoMs) return 'purged'
  if (tMs < trainEnd) return 'train'
  if (tMs < valEnd) return 'val'
  return 'holdout'
}

/**
 * Walk-forward folds inside [startMs, valEnd) (train+val only, never holdout).
 * Returns an array of { trainStart, trainEnd, testStart, testEnd } with an
 * embargo gap between train and test.
 */
export function walkForwardFolds(boundaries, folds = 4) {
  const { startMs, valEnd, embargoMs } = boundaries
  const span = valEnd - startMs
  const step = span / (folds + 1)
  const out = []
  for (let i = 1; i <= folds; i += 1) {
    const trainEnd = startMs + step * i
    out.push({
      trainStart: startMs,
      trainEnd: trainEnd - embargoMs,
      testStart: trainEnd + embargoMs,
      testEnd: startMs + step * (i + 1),
    })
  }
  return out
}

/**
 * Symbol-holdout experiment: deterministically reserve a fraction of symbols
 * for an unseen-symbol generalization test. Uses a stable hash so the same
 * symbol list always yields the same reservation.
 */
export function symbolHoldout(symbols, reserveCount = 4) {
  const scored = symbols.map((s) => {
    let h = 0
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return { s, h }
  })
  scored.sort((a, b) => a.h - b.h)
  const reserved = new Set(scored.slice(0, reserveCount).map((x) => x.s))
  return {
    trainSymbols: symbols.filter((s) => !reserved.has(s)),
    holdoutSymbols: symbols.filter((s) => reserved.has(s)),
  }
}
