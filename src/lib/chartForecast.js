// Draft 60-candle directional forecast, built purely from the per-bot signal
// analyses the app already computes for the selected symbol (`modelAnalyses`
// in App.jsx, one entry per SIGNAL_MODELS bot). This is a linear extrapolation
// of current bot consensus, not a trained prediction model — see
// ForecastPanel's on-page disclaimer.

const INTERVAL_MS = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1M': 30 * 24 * 60 * 60_000,
}

export const FORECAST_HORIZON_CANDLES = 60

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function impliedMovePercent(analysis) {
  const entry = toFiniteNumber(analysis?.entryPrice)
  const target = toFiniteNumber(analysis?.takeProfit)

  if (!entry || entry <= 0 || !target || target <= 0) {
    return null
  }

  return (Math.abs(target - entry) / entry) * 100
}

// A bot that has cleared its own minimumScore ("ready") is trusted more than
// one that is merely biased, and a bot's own checklist completion (score /
// maxScore) scales its vote within that tier.
function botWeight(analysis) {
  const scoreRatio = analysis.maxScore > 0 ? analysis.score / analysis.maxScore : 0
  const readinessMultiplier = analysis.ready ? 1.4 : 0.6
  return readinessMultiplier * Math.max(scoreRatio, 0.15)
}

export function intervalToMs(interval) {
  return INTERVAL_MS[interval] || INTERVAL_MS['15m']
}

const FORECAST_WAVE_STEPS = 10
const FORECAST_WAVE_CYCLES = 2.25

// Sketches the forecast as a hand-drawn-looking wave rather than a flat
// diagonal: a damped sine riding a straight trend line from the current
// price to the target, so it still lands exactly on the projected price at
// the end of the horizon. Amplitude scales with the size of the forecast
// move (with a floor) so a small percent move still reads as a visible
// squiggle instead of a nearly-flat line.
export function buildForecastWavePoints({ startTime, startPrice, horizonSeconds, direction, percent }) {
  if (!direction || !Number.isFinite(startPrice) || startPrice <= 0 || !Number.isFinite(horizonSeconds)) {
    return []
  }

  const sign = direction === 'LONG' ? 1 : -1
  const targetPrice = startPrice * (1 + sign * (percent / 100))
  const totalMove = targetPrice - startPrice
  const amplitude = Math.max(Math.abs(totalMove) * 0.55, startPrice * 0.0025)

  const points = []
  for (let step = 0; step <= FORECAST_WAVE_STEPS; step += 1) {
    const t = step / FORECAST_WAVE_STEPS
    const isLast = step === FORECAST_WAVE_STEPS
    const trend = startPrice + totalMove * t
    const damping = 1 - t
    const wave = Math.sin(t * FORECAST_WAVE_CYCLES * Math.PI * 2) * amplitude * damping
    points.push({
      time: Math.round(startTime + horizonSeconds * t),
      value: isLast ? targetPrice : trend + wave,
    })
  }

  return points.filter((point, index, arr) => index === 0 || point.time > arr[index - 1].time)
}

// Aggregates every bot's current directional signal (LONG / SHORT / WAIT) into
// one consensus direction, a confidence share, and a percentage move, sized
// off each agreeing bot's own take-profit distance from entry.
//
// `excludeModelId` computes the forecast leave-one-out style — used server-side
// so a bot's own AI-entry nudge / take-profit blend reacts to what the *other*
// bots think, not partly to its own vote (see mock-trading-server.js's
// getLeaveOneOutForecastForCandidate).
export function computeSixtyCandleForecast(modelAnalyses = {}, { excludeModelId = null } = {}) {
  const allBots = Object.entries(modelAnalyses || {})
    .filter(([modelId, analysis]) => Boolean(analysis) && modelId !== excludeModelId)
    .map(([modelId, analysis]) => ({ modelId, ...analysis, weight: botWeight(analysis) }))

  const directional = allBots.filter((bot) => bot.direction === 'LONG' || bot.direction === 'SHORT')

  if (directional.length === 0) {
    return {
      direction: null,
      percent: 0,
      confidence: 0,
      agreeingBots: [],
      disagreeingBots: [],
      waitingBots: allBots,
      allBots,
    }
  }

  const longWeight = directional.filter((bot) => bot.direction === 'LONG').reduce((sum, bot) => sum + bot.weight, 0)
  const shortWeight = directional.filter((bot) => bot.direction === 'SHORT').reduce((sum, bot) => sum + bot.weight, 0)
  const direction = longWeight >= shortWeight ? 'LONG' : 'SHORT'
  const totalWeight = longWeight + shortWeight
  const confidence = totalWeight > 0 ? (direction === 'LONG' ? longWeight : shortWeight) / totalWeight : 0

  const agreeingBots = directional
    .filter((bot) => bot.direction === direction)
    .sort((a, b) => b.weight - a.weight)
  const disagreeingBots = directional.filter((bot) => bot.direction !== direction)
  const waitingBots = allBots.filter((bot) => bot.direction !== 'LONG' && bot.direction !== 'SHORT')

  const magnitudeWeightSum = agreeingBots.reduce((sum, bot) => {
    const move = impliedMovePercent(bot)
    return move ? sum + bot.weight : sum
  }, 0)
  const magnitudeSum = agreeingBots.reduce((sum, bot) => {
    const move = impliedMovePercent(bot)
    return move ? sum + move * bot.weight : sum
  }, 0)
  const fallbackAverage = agreeingBots
    .map((bot) => impliedMovePercent(bot))
    .filter((move) => Number.isFinite(move) && move > 0)
  const percent = magnitudeWeightSum > 0
    ? magnitudeSum / magnitudeWeightSum
    : (fallbackAverage.length
      ? fallbackAverage.reduce((sum, move) => sum + move, 0) / fallbackAverage.length
      : 0)

  return {
    direction,
    percent: Number(percent.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    agreeingBots,
    disagreeingBots,
    waitingBots,
    allBots,
  }
}
