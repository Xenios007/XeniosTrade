// Entry-time-only features shared by offline fitting and online inference.
export const CONSOLIDATED_VERSION = 'consolidated-v1'
export const SOURCE_BOTS = Array.from({ length: 8 }, (_, i) => `model-${i + 1}`)
const BLOCK_KEYS = ['ret3','ret12','ema20_dist','ema50_dist','ema20_50_spread','ema20_slope',
  'trend_strength','rsi14','rsi_slope','macd_hist','atr_pct','bb_position','bb_width',
  'rel_volume','taker_buy_ratio','taker_delta_proxy','body_range','upper_wick','lower_wick',
  'close_pos','range_pos','vwap_dist','vol_percentile','compression','expansion']
export const INPUT_KEYS = ['side', ...SOURCE_BOTS, 'stopFraction',
  ...['e5','s15','b1h'].flatMap(tf => BLOCK_KEYS.map(k => `${tf}_${k}`))]

export function inputVector({ features, botId, side, stopFraction }) {
  if (!features || !SOURCE_BOTS.includes(botId) || !['BUY','SELL'].includes(side)
    || !Number.isFinite(stopFraction) || stopFraction <= 0) return null
  const values = [side === 'BUY' ? 1 : -1, ...SOURCE_BOTS.map(b => b === botId ? 1 : 0), stopFraction]
  for (const key of INPUT_KEYS.slice(10)) {
    if (!Number.isFinite(features[key])) return null
    values.push(features[key])
  }
  return values
}

export function predictTree(tree, vector, trace = []) {
  if (!vector || !tree) return null
  let node = tree
  while (node.feature !== undefined) {
    const value = vector[node.feature]
    if (!Number.isFinite(value)) return null
    const left = value <= node.threshold
    trace.push({ feature: INPUT_KEYS[node.feature], value, operator: left ? '<=' : '>', threshold: node.threshold })
    node = left ? node.left : node.right
  }
  return { expectedR: node.meanR, trainingSamples: node.count, leafId: node.id, trace }
}

export function scoreCandidate(artifact, candidate) {
  if (artifact?.version !== CONSOLIDATED_VERSION || artifact.inputKeys?.join('|') !== INPUT_KEYS.join('|')) {
    return { accepted: false, reason: 'Missing or incompatible consolidated model.' }
  }
  const vector = inputVector(candidate)
  const prediction = predictTree(artifact.tree, vector)
  if (!prediction) return { accepted: false, reason: 'Required entry-time features are unavailable.' }
  const accepted = prediction.expectedR >= artifact.threshold
  return { ...prediction, accepted, validated:artifact.validated,
    reason: accepted ? 'Entry pattern passed the frozen research threshold; paper simulation only.' : 'Expected return below the frozen research threshold.' }
}
