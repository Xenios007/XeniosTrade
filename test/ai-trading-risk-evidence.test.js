import test from 'node:test'
import assert from 'node:assert/strict'
import {
  atrPctSeries, atrPercentile, bookImpact, buildRiskEvidence, describeRiskEvidence, excursionStats, quantileTable, rankIn,
} from '../server/ai-trading/risk-evidence.js'

// A candle whose range is `range` (fraction of price) around `close`.
const candle = (close, range = 0.001) => ({ open: close, high: close * (1 + range / 2), low: close * (1 - range / 2), close, volume: 1, closeTime: 0 })
// `count` candles whose close moves by `step` (fraction) per bar and whose range follows rangeAt(index).
const series = (count, step, rangeAt = () => 0.001) => {
  const out = []
  let close = 100
  for (let index = 0; index < count; index += 1) {
    out.push(candle(close, rangeAt(index)))
    close *= 1 + step
  }
  return out
}

test('quantileTable and rankIn are inverses on a simple sample', () => {
  const table = quantileTable(Array.from({ length: 101 }, (_unused, index) => index))
  assert.equal(table.length, 21)
  assert.equal(table[0], 0)
  assert.equal(table[10], 50)
  assert.equal(table[20], 100)
  assert.ok(Math.abs(rankIn(table, 50) - 0.5) < 1e-9)
  assert.ok(Math.abs(rankIn(table, 90) - 0.9) < 1e-9)
  assert.equal(rankIn(table, -5), 0)
  assert.equal(rankIn(table, 500), 1)
  assert.equal(quantileTable([]), null)
  assert.equal(rankIn(null, 1), null)
})

test('atrPercentile: a volatility spike is a high percentile, a quiet market a low one, and short data is refused', () => {
  const calmThenWild = series(200, 0, (index) => (index < 180 ? 0.002 : 0.02))
  const wild = atrPercentile(calmThenWild)
  assert.ok(wild.percentile >= 90, `percentile ${wild.percentile}`)
  assert.equal(wild.samples, 200 - 14)

  const wildThenCalm = series(200, 0, (index) => (index < 150 ? 0.02 : 0.002))
  assert.ok(atrPercentile(wildThenCalm).percentile <= 25)

  assert.equal(atrPercentile(series(20, 0)), null, 'too little history to rank')
  assert.equal(atrPctSeries(series(5, 0)).length, 0)
})

test('excursionStats: an uptrend favors longs and hurts shorts, and independent windows are honest', () => {
  const stats = excursionStats(series(300, 0.001), 12)
  assert.equal(stats.horizonBars, 12)
  assert.equal(stats.windows, 300 - 12)
  assert.equal(stats.independent, Math.floor((300 - 12) / 12))
  const median = (table) => table[10]
  assert.ok(median(stats.long.mfe) > 1, `long favorable median ${median(stats.long.mfe)}`)
  assert.ok(median(stats.long.mae) < 0.2, 'a steady uptrend gives longs a small adverse move')
  // the short side is the mirror image
  assert.equal(stats.short.mfe[10], stats.long.mae[10])
  assert.equal(stats.short.mae[10], stats.long.mfe[10])
  assert.equal(excursionStats(series(30, 0), 12), null, 'not enough windows')
})

test('bookImpact: spread, average slippage per size, and null when the book cannot fill it', () => {
  const book = { bids: [['99', '1'], ['98', '10']], asks: [['101', '1'], ['102', '10']] }
  const impact = bookImpact(book, [101, 203, 5000])
  assert.equal(impact.levels, 2)
  assert.equal(impact.spreadPct, 2)
  // buying 101 USDT takes exactly the best ask (101): 1% over the 100 mid. Selling 101 USDT takes the 99 bid (99 USDT) and then 2 USDT at 98,
  // which is slightly worse than 1% because a USDT amount buys more units at the lower price.
  assert.deepEqual(impact.impacts[0], { notionalUsdt: 101, buyPct: 1, sellPct: 1.02 })
  // buying 203 USDT: 1 @ 101 (101) + 102 USDT @ 102 = 2 units -> average 101.5 -> 1.5% over the 100 mid
  assert.equal(impact.impacts[1].buyPct, 1.5)
  assert.equal(impact.impacts[2].buyPct, null)
  assert.equal(bookImpact({ bids: [], asks: [] }, [10]), null)
  assert.equal(bookImpact(null, [10]), null)
})

test('buildRiskEvidence: partial data gives partial evidence, nothing gives null, and a broken part never throws', () => {
  assert.equal(buildRiskEvidence({}), null)
  const partial = buildRiskEvidence({ depth: { bids: [['99', '5']], asks: [['101', '5']] }, notionalsUsdt: [50] })
  assert.ok(partial.book)
  assert.equal(partial.atr5m, null)
  assert.doesNotThrow(() => buildRiskEvidence({ candles5m: [{}, {}, null], depth: 'garbage' }))
})

test('describeRiskEvidence: says what was measured, with sample sizes and the honest caveats', () => {
  const evidence = buildRiskEvidence({
    candles5m: series(500, 0.0004, (index) => 0.002 + (index % 7) * 0.0003),
    candles1h: series(300, 0.0002),
    depth: { bids: [['99.9', '500'], ['99.8', '500']], asks: [['100.1', '500'], ['100.2', '500']] },
    notionalsUsdt: [21, 45],
  })
  const lines = describeRiskEvidence({ evidence, side: 'LONG', stopPct: 0.35, targetPct: 0.65, flowMetrics: { fundingRatePct: 0.0100, fundingAnnualizedPct: 10.9 }, maxLeverage: 5 })
  const text = lines.join('\n')
  assert.match(lines[0], /^Measured evidence/)
  assert.match(text, /Volatility context: 5M ATR is [\d.]+% of price, the \d+th percentile of the last 486 5M bars/)
  assert.match(text, /1H ATR .* of the last 286 1H bars/)
  assert.match(text, /Typical excursion in the 60 minutes after ANY 5M close, for a LONG \(n=488 overlapping windows, about 40 independent\)/)
  assert.match(text, /base rate for the symbol, not this setup/)
  assert.match(text, /At the Analyst's numbers, within that horizon: price moved at least 0\.35% against a LONG .* in about \d+% of windows; at least 0\.65% in favor .* in about \d+%\. Separate frequencies, not a win probability/)
  assert.match(text, /Funding is 0\.0100% per interval .* a LONG PAYS about 0\.0100% of notional/)
  assert.match(text, /Live futures order book \(top 2 levels\): spread 0\.2000%; a market order of 21\.00 USDT slips about [\d.]+% buying/)
  assert.match(text, /Isolated-margin liquidation .*\(1x ~ 100%, 2x ~ 50%, 3x ~ 33%, 5x ~ 20%\)/)
  assert.doesNotMatch(text, /10x ~/, 'only up to the leverage ceiling')
  assert.match(lines.at(-1), /Not measured, so unavailable to you: exchange fees, account drawdown \/ daily loss, and MFE\/MAE of comparable setups/)

  // direction flips the funding cost
  const short = describeRiskEvidence({ evidence, side: 'SHORT', flowMetrics: { fundingRatePct: 0.01, fundingAnnualizedPct: 10.9 } }).join('\n')
  assert.match(short, /a SHORT RECEIVES about/)
  const negative = describeRiskEvidence({ evidence, side: 'LONG', flowMetrics: { fundingRatePct: -0.02, fundingAnnualizedPct: -21.9 } }).join('\n')
  assert.match(negative, /a LONG RECEIVES about 0\.0200%/)
})

test('describeRiskEvidence: says nothing when nothing was measured (no empty "evidence" block)', () => {
  assert.deepEqual(describeRiskEvidence({}), [])
  assert.deepEqual(describeRiskEvidence({ evidence: null, flowMetrics: {} }), [])
  // funding alone is a measurement
  const fundingOnly = describeRiskEvidence({ side: 'LONG', flowMetrics: { fundingRatePct: 0.01, fundingAnnualizedPct: 10.9 } })
  assert.match(fundingOnly[0], /^Measured evidence/)
  assert.match(fundingOnly.join('\n'), /Funding is/)
})

test('a missing measurement stays missing: null / undefined / empty funding is never reported as 0%', () => {
  for (const fundingRatePct of [null, undefined, '', Number.NaN]) {
    assert.deepEqual(describeRiskEvidence({ side: 'LONG', flowMetrics: { fundingRatePct, fundingAnnualizedPct: null } }), [], `funding ${String(fundingRatePct)}`)
  }
  // a real zero IS a measurement
  assert.match(describeRiskEvidence({ side: 'LONG', flowMetrics: { fundingRatePct: 0, fundingAnnualizedPct: 0 } }).join('\n'), /neither pays nor receives/)
  assert.equal(rankIn([0, 1, 2], null), null)
  assert.equal(quantileTable([null, undefined, '', 5]).every((value) => value === 5), true, 'only the real 5 is measured')
})
