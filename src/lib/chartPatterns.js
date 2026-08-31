// Chart pattern detection engine.
//
// Pure functions over an OHLC series ({ time, open, high, low, close }, ascending
// by time). Two families:
//   - candlestick patterns: rule checks on the last 1-3 bars
//   - chart patterns: matched against ZigZag swing pivots
//
// Every detected pattern is returned in one shape so the chart can draw it and
// the signal/AI layer can score it:
//
//   {
//     id, name, category: 'candlestick' | 'chart',
//     bias: 'bullish' | 'bearish' | 'neutral',
//     confidence: 0..1,
//     recency: 0..1,                       // 1 = ends on the latest bar
//     startIndex, endIndex, startTime, endTime,
//     detail: string,
//     marker: { time, position, shape, color, text } | null,   // candlestick
//     lines: [ { points: [{ time, value }], color, lineStyle, lineWidth } ],
//     label: { time, value, text, color } | null,
//   }

const BULL_COLOR = '#34d399'
const BEAR_COLOR = '#fb7185'
const NEUTRAL_COLOR = '#38bdf8'

function colorForBias(bias) {
  if (bias === 'bullish') return BULL_COLOR
  if (bias === 'bearish') return BEAR_COLOR
  return NEUTRAL_COLOR
}

// --- small OHLC helpers -----------------------------------------------------

const body = (c) => Math.abs(c.close - c.open)
const rangeOf = (c) => c.high - c.low
const upperWick = (c) => c.high - Math.max(c.open, c.close)
const lowerWick = (c) => Math.min(c.open, c.close) - c.low
const isBull = (c) => c.close > c.open
const isBear = (c) => c.close < c.open
const midBody = (c) => (c.open + c.close) / 2

function avgBody(data, endIdx, lookback = 14) {
  const start = Math.max(0, endIdx - lookback)
  let sum = 0
  let count = 0
  for (let i = start; i < endIdx; i += 1) {
    sum += body(data[i])
    count += 1
  }
  return count > 0 ? sum / count : 0
}

function trendBefore(data, endIdx, lookback = 10) {
  const start = Math.max(0, endIdx - lookback)
  if (endIdx - start < 3) return 'flat'
  const first = data[start].close
  const last = data[endIdx - 1].close
  const change = (last - first) / (first || 1)
  if (change > 0.008) return 'up'
  if (change < -0.008) return 'down'
  return 'flat'
}

function similar(a, b, tol) {
  const mean = (Math.abs(a) + Math.abs(b)) / 2
  if (mean === 0) return true
  return Math.abs(a - b) / mean <= tol
}

function recencyFor(endIndex, length) {
  if (length <= 1) return 1
  const fromEnd = length - 1 - endIndex
  return Math.max(0, 1 - fromEnd / Math.max(20, length * 0.4))
}

// --- ZigZag swing pivots --------------------------------------------------

export function findPivots(data, strength = 3) {
  const pivots = []

  for (let i = strength; i < data.length - strength; i += 1) {
    let isHigh = true
    let isLow = true

    for (let j = i - strength; j <= i + strength; j += 1) {
      if (j === i) continue
      if (data[j].high >= data[i].high) isHigh = false
      if (data[j].low <= data[i].low) isLow = false
    }

    if (isHigh) {
      pivots.push({ index: i, time: data[i].time, price: data[i].high, type: 'H' })
    } else if (isLow) {
      pivots.push({ index: i, time: data[i].time, price: data[i].low, type: 'L' })
    }
  }

  // Collapse runs of the same type, keeping the more extreme pivot.
  const cleaned = []
  for (const pivot of pivots) {
    const last = cleaned[cleaned.length - 1]
    if (last && last.type === pivot.type) {
      const moreExtreme = pivot.type === 'H' ? pivot.price > last.price : pivot.price < last.price
      if (moreExtreme) cleaned[cleaned.length - 1] = pivot
    } else {
      cleaned.push(pivot)
    }
  }

  return cleaned
}

// --- candlestick detectors ----------------------------------------------

// Each returns a partial pattern ({ name, bias, confidence, detail, span }) or
// null. `i` is the index of the pattern's final (most recent) bar.

function detectCandlestickAt(data, i) {
  const c = data[i]
  const p = data[i - 1]
  const p2 = data[i - 2]
  const r = rangeOf(c)
  if (r <= 0) return null
  const b = body(c)
  const trend = trendBefore(data, i)
  const strongBody = avgBody(data, i) * 1.1

  // Doji family (1 bar)
  if (b <= 0.1 * r) {
    if (lowerWick(c) >= 0.6 * r && upperWick(c) <= 0.15 * r) {
      return { name: 'Dragonfly Doji', bias: 'bullish', confidence: 0.45, detail: 'Long lower wick, open≈close — sellers rejected.', span: 1 }
    }
    if (upperWick(c) >= 0.6 * r && lowerWick(c) <= 0.15 * r) {
      return { name: 'Gravestone Doji', bias: 'bearish', confidence: 0.45, detail: 'Long upper wick, open≈close — buyers rejected.', span: 1 }
    }
    return { name: 'Doji', bias: 'neutral', confidence: 0.3, detail: 'Open and close nearly equal — indecision.', span: 1 }
  }

  // Hammer / hanging man / inverted hammer / shooting star (1 bar)
  if (b > 0 && lowerWick(c) >= 2 * b && upperWick(c) <= 0.6 * b) {
    if (trend === 'down') {
      return { name: 'Hammer', bias: 'bullish', confidence: lowerWick(c) >= 3 * b ? 0.62 : 0.5, detail: 'Long lower wick after a decline — rejection of lows.', span: 1 }
    }
    if (trend === 'up') {
      return { name: 'Hanging Man', bias: 'bearish', confidence: 0.48, detail: 'Long lower wick after an advance — early distribution.', span: 1 }
    }
  }
  if (b > 0 && upperWick(c) >= 2 * b && lowerWick(c) <= 0.6 * b) {
    if (trend === 'down') {
      return { name: 'Inverted Hammer', bias: 'bullish', confidence: 0.46, detail: 'Long upper wick after a decline — buyers testing higher.', span: 1 }
    }
    if (trend === 'up') {
      return { name: 'Shooting Star', bias: 'bearish', confidence: upperWick(c) >= 3 * b ? 0.6 : 0.5, detail: 'Long upper wick after an advance — rejection of highs.', span: 1 }
    }
  }

  if (!p) return null

  // Engulfing (2 bars)
  if (isBear(p) && isBull(c) && c.close >= p.open && c.open <= p.close && body(c) > body(p)) {
    return { name: 'Bullish Engulfing', bias: 'bullish', confidence: body(c) > body(p) * 1.6 ? 0.7 : 0.58, detail: 'Green bar fully engulfs the prior red body.', span: 2 }
  }
  if (isBull(p) && isBear(c) && c.close <= p.open && c.open >= p.close && body(c) > body(p)) {
    return { name: 'Bearish Engulfing', bias: 'bearish', confidence: body(c) > body(p) * 1.6 ? 0.7 : 0.58, detail: 'Red bar fully engulfs the prior green body.', span: 2 }
  }

  // Piercing line / dark cloud cover (2 bars)
  if (isBear(p) && isBull(c) && c.open < p.low && c.close > midBody(p) && c.close < p.open) {
    return { name: 'Piercing Line', bias: 'bullish', confidence: 0.55, detail: 'Gap-down open, close back above the prior midpoint.', span: 2 }
  }
  if (isBull(p) && isBear(c) && c.open > p.high && c.close < midBody(p) && c.close > p.open) {
    return { name: 'Dark Cloud Cover', bias: 'bearish', confidence: 0.55, detail: 'Gap-up open, close back below the prior midpoint.', span: 2 }
  }

  // Harami (2 bars) — small bar contained within the prior, larger body
  if (isBear(p) && isBull(c) && c.open > p.close && c.close < p.open && body(p) > body(c) * 1.5) {
    return { name: 'Bullish Harami', bias: 'bullish', confidence: 0.4, detail: 'Small green bar held inside the prior red body.', span: 2 }
  }
  if (isBull(p) && isBear(c) && c.open < p.close && c.close > p.open && body(p) > body(c) * 1.5) {
    return { name: 'Bearish Harami', bias: 'bearish', confidence: 0.4, detail: 'Small red bar held inside the prior green body.', span: 2 }
  }

  // Tweezers (2 bars)
  if (similar(c.low, p.low, 0.0015) && trend === 'down' && isBull(c) && isBear(p)) {
    return { name: 'Tweezer Bottom', bias: 'bullish', confidence: 0.44, detail: 'Two matching lows — support held.', span: 2 }
  }
  if (similar(c.high, p.high, 0.0015) && trend === 'up' && isBear(c) && isBull(p)) {
    return { name: 'Tweezer Top', bias: 'bearish', confidence: 0.44, detail: 'Two matching highs — resistance held.', span: 2 }
  }

  if (!p2) return null

  // Morning / evening star (3 bars)
  if (isBear(p2) && body(p2) >= strongBody && body(p) <= 0.5 * body(p2) && isBull(c) && c.close > midBody(p2)) {
    return { name: 'Morning Star', bias: 'bullish', confidence: 0.66, detail: 'Big red bar, small pause, strong green reversal.', span: 3 }
  }
  if (isBull(p2) && body(p2) >= strongBody && body(p) <= 0.5 * body(p2) && isBear(c) && c.close < midBody(p2)) {
    return { name: 'Evening Star', bias: 'bearish', confidence: 0.66, detail: 'Big green bar, small pause, strong red reversal.', span: 3 }
  }

  // Three soldiers / crows (3 bars)
  if (
    isBull(c) && isBull(p) && isBull(p2)
    && c.close > p.close && p.close > p2.close
    && c.open > p.open && p.open > p2.open
    && c.open < p.close && p.open < p2.close
    && upperWick(c) <= body(c) && upperWick(p) <= body(p)
  ) {
    return { name: 'Three White Soldiers', bias: 'bullish', confidence: 0.62, detail: 'Three rising green bars with small upper wicks.', span: 3 }
  }
  if (
    isBear(c) && isBear(p) && isBear(p2)
    && c.close < p.close && p.close < p2.close
    && c.open < p.open && p.open < p2.open
    && c.open > p.close && p.open > p2.close
    && lowerWick(c) <= body(c) && lowerWick(p) <= body(p)
  ) {
    return { name: 'Three Black Crows', bias: 'bearish', confidence: 0.62, detail: 'Three falling red bars with small lower wicks.', span: 3 }
  }

  return null
}

function buildCandlestickPatterns(data, { lookback }) {
  const out = []
  const start = Math.max(2, data.length - lookback)
  const seenAtBar = new Set()

  for (let i = data.length - 1; i >= start; i -= 1) {
    if (seenAtBar.has(i)) continue
    const hit = detectCandlestickAt(data, i)
    if (!hit) continue

    const startIndex = i - (hit.span - 1)
    const anchor = data[i]
    const color = colorForBias(hit.bias)
    const above = hit.bias === 'bearish'

    out.push({
      id: `candle-${hit.name.replace(/\s+/g, '-').toLowerCase()}-${anchor.time}`,
      name: hit.name,
      category: 'candlestick',
      bias: hit.bias,
      confidence: hit.confidence,
      recency: recencyFor(i, data.length),
      startIndex,
      endIndex: i,
      startTime: data[startIndex].time,
      endTime: anchor.time,
      detail: hit.detail,
      marker: {
        time: anchor.time,
        position: above ? 'aboveBar' : 'belowBar',
        shape: above ? 'arrowDown' : 'arrowUp',
        color,
        text: hit.name,
      },
      lines: [],
      label: null,
    })

    for (let k = startIndex; k <= i; k += 1) seenAtBar.add(k)
  }

  return out
}

// --- chart (geometric) detectors --------------------------------------

function horizontalLine(price, fromTime, toTime, color, lineStyle = 2, lineWidth = 1) {
  return {
    points: [{ time: fromTime, value: price }, { time: toTime, value: price }],
    color,
    lineStyle,
    lineWidth,
  }
}

function polyline(pivots, color, lineStyle = 0, lineWidth = 2) {
  return {
    points: pivots.map((pivot) => ({ time: pivot.time, value: pivot.price })),
    color,
    lineStyle,
    lineWidth,
  }
}

function makeChartPattern({ name, bias, confidence, pivots, data, detail, lines, neckline }) {
  const startIndex = pivots[0].index
  const endIndex = pivots[pivots.length - 1].index
  const lastBar = data[data.length - 1]
  const lastClose = lastBar.close
  let conf = confidence

  // Breakout confirmation nudges confidence.
  if (neckline != null) {
    if (bias === 'bearish' && lastClose < neckline) conf = Math.min(0.95, conf + 0.12)
    if (bias === 'bullish' && lastClose > neckline) conf = Math.min(0.95, conf + 0.12)
  }

  const color = colorForBias(bias)
  const above = bias === 'bearish'

  return {
    id: `chart-${name.replace(/\s+/g, '-').toLowerCase()}-${data[endIndex].time}`,
    name,
    category: 'chart',
    bias,
    confidence: conf,
    recency: recencyFor(endIndex, data.length),
    startIndex,
    endIndex,
    startTime: data[startIndex].time,
    endTime: lastBar.time,
    detail,
    marker: {
      time: lastBar.time,
      position: above ? 'aboveBar' : 'belowBar',
      shape: 'circle',
      color,
      text: name,
    },
    lines,
    label: {
      time: lastBar.time,
      value: pivots[pivots.length - 1].price,
      text: name,
      color,
    },
  }
}

function buildChartPatterns(data, { pivotStrength, tolerance }) {
  const pivots = findPivots(data, pivotStrength)
  if (pivots.length < 4) return []

  const out = []
  const recent = pivots.slice(-7)
  const lastTime = data[data.length - 1].time
  const highs = recent.filter((p) => p.type === 'H')
  const lows = recent.filter((p) => p.type === 'L')

  // Double top / double bottom (H-L-H or L-H-L on the last 3 pivots)
  const p3 = pivots.slice(-3)
  if (p3.length === 3) {
    const [a, b, c] = p3
    if (a.type === 'H' && b.type === 'L' && c.type === 'H' && similar(a.price, c.price, tolerance)) {
      const neckline = b.price
      out.push(makeChartPattern({
        name: 'Double Top', bias: 'bearish', confidence: 0.6, pivots: p3, data, neckline,
        detail: 'Two highs at the same level with a trough between — breakdown targets the neckline.',
        lines: [polyline([a, c], BEAR_COLOR, 2, 2), horizontalLine(neckline, a.time, lastTime, BEAR_COLOR)],
      }))
    }
    if (a.type === 'L' && b.type === 'H' && c.type === 'L' && similar(a.price, c.price, tolerance)) {
      const neckline = b.price
      out.push(makeChartPattern({
        name: 'Double Bottom', bias: 'bullish', confidence: 0.6, pivots: p3, data, neckline,
        detail: 'Two lows at the same level with a peak between — breakout targets the neckline.',
        lines: [polyline([a, c], BULL_COLOR, 2, 2), horizontalLine(neckline, a.time, lastTime, BULL_COLOR)],
      }))
    }
  }

  // Head & shoulders / inverse (last 5 pivots)
  const p5 = pivots.slice(-5)
  if (p5.length === 5) {
    const [h1, l1, head, l2, h3] = p5
    if (
      h1.type === 'H' && l1.type === 'L' && head.type === 'H' && l2.type === 'L' && h3.type === 'H'
      && head.price > h1.price && head.price > h3.price
      && similar(h1.price, h3.price, tolerance * 1.6)
      && similar(l1.price, l2.price, tolerance * 1.8)
    ) {
      const neckline = (l1.price + l2.price) / 2
      out.push(makeChartPattern({
        name: 'Head & Shoulders', bias: 'bearish', confidence: 0.68, pivots: p5, data, neckline,
        detail: 'Three peaks, the middle highest, with a shared neckline — a topping reversal.',
        lines: [polyline(p5, BEAR_COLOR, 0, 2), horizontalLine(neckline, h1.time, lastTime, BEAR_COLOR)],
      }))
    }
    if (
      h1.type === 'L' && l1.type === 'H' && head.type === 'L' && l2.type === 'H' && h3.type === 'L'
      && head.price < h1.price && head.price < h3.price
      && similar(h1.price, h3.price, tolerance * 1.6)
      && similar(l1.price, l2.price, tolerance * 1.8)
    ) {
      const neckline = (l1.price + l2.price) / 2
      out.push(makeChartPattern({
        name: 'Inverse Head & Shoulders', bias: 'bullish', confidence: 0.68, pivots: p5, data, neckline,
        detail: 'Three troughs, the middle lowest, with a shared neckline — a bottoming reversal.',
        lines: [polyline(p5, BULL_COLOR, 0, 2), horizontalLine(neckline, h1.time, lastTime, BULL_COLOR)],
      }))
    }
  }

  // Triangles / wedges / channel from >=2 highs and >=2 lows
  if (highs.length >= 2 && lows.length >= 2) {
    const h = highs.slice(-3)
    const l = lows.slice(-3)
    const hFirst = h[0]
    const hLast = h[h.length - 1]
    const lFirst = l[0]
    const lLast = l[l.length - 1]
    const highsFlat = similar(hFirst.price, hLast.price, tolerance)
    const lowsFlat = similar(lFirst.price, lLast.price, tolerance)
    const highsUp = hLast.price > hFirst.price * (1 + tolerance)
    const highsDown = hLast.price < hFirst.price * (1 - tolerance)
    const lowsUp = lLast.price > lFirst.price * (1 + tolerance)
    const lowsDown = lLast.price < lFirst.price * (1 - tolerance)
    const topLine = polyline([hFirst, hLast], NEUTRAL_COLOR, 0, 2)
    const botLine = polyline([lFirst, lLast], NEUTRAL_COLOR, 0, 2)
    const span = [hFirst, lFirst, hLast, lLast].sort((a, b) => a.index - b.index)

    if (highsFlat && lowsUp) {
      out.push(makeChartPattern({
        name: 'Ascending Triangle', bias: 'bullish', confidence: 0.56, pivots: span, data, neckline: hLast.price,
        detail: 'Flat resistance with rising lows — buyers pressing into supply.',
        lines: [horizontalLine((hFirst.price + hLast.price) / 2, hFirst.time, lastTime, BULL_COLOR), polyline([lFirst, lLast], BULL_COLOR, 0, 2)],
      }))
    } else if (lowsFlat && highsDown) {
      out.push(makeChartPattern({
        name: 'Descending Triangle', bias: 'bearish', confidence: 0.56, pivots: span, data, neckline: lLast.price,
        detail: 'Flat support with falling highs — sellers pressing into demand.',
        lines: [horizontalLine((lFirst.price + lLast.price) / 2, lFirst.time, lastTime, BEAR_COLOR), polyline([hFirst, hLast], BEAR_COLOR, 0, 2)],
      }))
    } else if (highsDown && lowsUp) {
      out.push(makeChartPattern({
        name: 'Symmetrical Triangle', bias: 'neutral', confidence: 0.48, pivots: span, data,
        detail: 'Converging highs and lows — a coil that resolves with the breakout.',
        lines: [topLine, botLine],
      }))
    } else if (highsUp && lowsUp && (hLast.price - hFirst.price) < (lLast.price - lFirst.price) * 1.2) {
      out.push(makeChartPattern({
        name: 'Rising Wedge', bias: 'bearish', confidence: 0.52, pivots: span, data,
        detail: 'Higher highs and higher lows converging — momentum fading into a bearish break.',
        lines: [polyline([hFirst, hLast], BEAR_COLOR, 0, 2), polyline([lFirst, lLast], BEAR_COLOR, 0, 2)],
      }))
    } else if (highsDown && lowsDown && Math.abs(hLast.price - hFirst.price) < Math.abs(lLast.price - lFirst.price) * 1.2) {
      out.push(makeChartPattern({
        name: 'Falling Wedge', bias: 'bullish', confidence: 0.52, pivots: span, data,
        detail: 'Lower highs and lower lows converging — selling exhausting into a bullish break.',
        lines: [polyline([hFirst, hLast], BULL_COLOR, 0, 2), polyline([lFirst, lLast], BULL_COLOR, 0, 2)],
      }))
    } else if (highsFlat && lowsFlat) {
      out.push(makeChartPattern({
        name: 'Rectangle Range', bias: 'neutral', confidence: 0.44, pivots: span, data,
        detail: 'Parallel highs and lows — range trade until one side breaks.',
        lines: [
          horizontalLine((hFirst.price + hLast.price) / 2, hFirst.time, lastTime, NEUTRAL_COLOR),
          horizontalLine((lFirst.price + lLast.price) / 2, lFirst.time, lastTime, NEUTRAL_COLOR),
        ],
      }))
    }
  }

  // Flags: an impulsive pole then a shallow counter-trend drift.
  const flag = detectFlag(data, tolerance)
  if (flag) out.push(flag)

  return out
}

function detectFlag(data, tolerance) {
  const n = data.length
  if (n < 24) return null
  const poleLen = 6
  const flagLen = 8
  const poleStart = n - 1 - flagLen - poleLen
  const poleEnd = n - 1 - flagLen
  if (poleStart < 0) return null

  const poleMove = (data[poleEnd].close - data[poleStart].close) / (data[poleStart].close || 1)
  const flagSlice = data.slice(poleEnd, n)
  const flagMove = (flagSlice[flagSlice.length - 1].close - flagSlice[0].close) / (flagSlice[0].close || 1)
  const flagRange = Math.max(...flagSlice.map((c) => c.high)) - Math.min(...flagSlice.map((c) => c.low))
  const poleRange = Math.abs(data[poleEnd].close - data[poleStart].close)
  if (poleRange === 0 || flagRange > poleRange * 0.8) return null

  const pivots = [
    { index: poleStart, time: data[poleStart].time, price: data[poleStart].close },
    { index: poleEnd, time: data[poleEnd].time, price: data[poleEnd].close },
    { index: n - 1, time: data[n - 1].time, price: data[n - 1].close },
  ]

  if (poleMove > 0.03 && flagMove < 0.01 && flagMove > -0.025) {
    return makeChartPattern({
      name: 'Bull Flag', bias: 'bullish', confidence: 0.55, pivots, data,
      detail: 'Sharp advance then a tight downward drift — continuation setup.',
      lines: [polyline([pivots[0], pivots[1]], BULL_COLOR, 0, 2), polyline([pivots[1], pivots[2]], BULL_COLOR, 2, 2)],
    })
  }
  if (poleMove < -0.03 && flagMove > -0.01 && flagMove < 0.025) {
    return makeChartPattern({
      name: 'Bear Flag', bias: 'bearish', confidence: 0.55, pivots, data,
      detail: 'Sharp decline then a tight upward drift — continuation setup.',
      lines: [polyline([pivots[0], pivots[1]], BEAR_COLOR, 0, 2), polyline([pivots[1], pivots[2]], BEAR_COLOR, 2, 2)],
    })
  }
  return null
}

// --- public API -----------------------------------------------------------

export function detectChartPatterns(data = [], options = {}) {
  const {
    pivotStrength = 3,
    tolerance = 0.02,
    candleLookback = 60,
    maxPatterns = 14,
  } = options

  if (!Array.isArray(data) || data.length < 12) {
    return { patterns: [], summary: emptySummary() }
  }

  const candlePatterns = buildCandlestickPatterns(data, { lookback: candleLookback })
  const chartPatterns = buildChartPatterns(data, { pivotStrength, tolerance })

  const patterns = [...chartPatterns, ...candlePatterns]
    .sort((a, b) => (b.endIndex - a.endIndex) || (b.confidence - a.confidence))
    .slice(0, maxPatterns)

  return { patterns, summary: summarizePatternBias(patterns) }
}

function emptySummary() {
  return {
    bias: 'neutral',
    score: 0,
    bullishWeight: 0,
    bearishWeight: 0,
    count: 0,
    top: null,
    forming: null,
  }
}

export function summarizePatternBias(patterns = []) {
  if (patterns.length === 0) return emptySummary()

  let bullishWeight = 0
  let bearishWeight = 0

  for (const pattern of patterns) {
    const weight = pattern.confidence * (0.4 + 0.6 * pattern.recency)
    if (pattern.bias === 'bullish') bullishWeight += weight
    else if (pattern.bias === 'bearish') bearishWeight += weight
  }

  const total = bullishWeight + bearishWeight
  const score = total > 0 ? (bullishWeight - bearishWeight) / total : 0
  const bias = score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral'
  const top = [...patterns].sort((a, b) => (b.confidence * b.recency) - (a.confidence * a.recency))[0] || null
  const forming = [...patterns].sort((a, b) => b.recency - a.recency)[0] || null

  return {
    bias,
    score: Number(score.toFixed(3)),
    bullishWeight: Number(bullishWeight.toFixed(3)),
    bearishWeight: Number(bearishWeight.toFixed(3)),
    count: patterns.length,
    top,
    forming,
  }
}

// Score contribution for the signal / AI layer: -1..+1 aligned with `side`
// ('LONG' | 'SHORT'). Positive = patterns confirm the intended direction.
export function patternScoreForSide(summary, side) {
  if (!summary || summary.count === 0) return 0
  const directional = side === 'SHORT' ? -summary.score : summary.score
  return Number(Math.max(-1, Math.min(1, directional)).toFixed(3))
}
