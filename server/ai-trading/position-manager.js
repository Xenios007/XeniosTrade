// Position Manager — the fifth AI role. The four entry agents (pipeline.js) decide whether a trade should exist; this one
// works AFTER entry, like a trader who inherited the position: every few minutes it is handed a fresh snapshot of the open
// trade and decides what to do with it (hold, breakeven, tighten, let it run, extend the target, take a partial, exit).
//
// This module is pure (no I/O). The judgment belongs to the model: R multiple, distance to stop/target, drawdown and the
// market changes are INPUTS in the prompt, never trigger rules here. The only code checks are safety invariants that keep
// the exchange order valid and stop the model from ever adding risk:
//   - a stop can only move toward profit (never wider), and it must sit on the protective side of the current price;
//   - a take profit can only be extended further out or removed (never pulled closer to price by "extending");
//   - a partial close is a real fraction of the position; size is never added;
//   - anything invalid is rejected as a whole and the trade keeps its current orders.

import { AI_POSITION_MANAGER_DECISIONS } from '../../src/lib/aiTrading.js'
import { describeFlow } from './flow-data.js'
import { describeMarket, flowSummary } from './pipeline.js'

const fx = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a')
const isNum = (value) => Number.isFinite(Number(value)) && value !== null && value !== '' && typeof value !== 'boolean'
const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)
const asText = (value, max = 600) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** A stop must sit at least this far (fraction of price) on the protective side, or the exchange triggers it on placement. */
export const MIN_STOP_BUFFER = 0.0003
/** A new target must sit at least this far beyond the current price. */
export const MIN_TARGET_BUFFER = 0.0005
export const MAX_STORED_REVIEWS = 60
const PREVIOUS_REVIEWS_SHOWN = 6

const sideSign = (trade) => (String(trade?.side).toUpperCase() === 'BUY' ? 1 : -1)
const finiteOrNull = (value) => (isNum(value) && Number(value) > 0 ? Number(value) : null)

// ----------------------------------------------------------------- entry context

/** What the entry agents concluded, kept on the trade so the thesis survives the 50-run history rolling over. */
export function buildEntryContext(run) {
  const stage = (id) => run?.stages?.find((item) => item.id === id)?.output || null
  const analyst = stage('analyst')
  const flow = stage('flow')
  const critic = stage('critic')
  const risk = stage('risk')
  return {
    testMode: run?.testMode === true,
    entryConfidence: run?.final?.confidence ?? null,
    analyst: analyst && {
      action: analyst.action, confidence: analyst.confidence, regime: analyst.regime,
      stopLossPercent: analyst.stopLossPercent, takeProfitPercent: analyst.takeProfitPercent,
      keyFactors: analyst.keyFactors, reasoning: analyst.reasoning,
    },
    flow: flow && { verdict: flow.verdict, crowding: flow.crowding, flags: flow.flags, reasoning: flow.reasoning, metrics: flow.metrics || null },
    critic: critic && { verdict: critic.verdict, objections: critic.objections, reasoning: critic.reasoning },
    risk: risk && {
      decision: risk.ai?.decision ?? null, confidence: risk.ai?.confidence ?? null, reasoning: risk.ai?.reasoning ?? '',
      concerns: risk.ai?.concerns ?? [], reduced: Boolean(risk.reduced), plan: risk.plan || null,
    },
    entrySnapshot: run?.entrySnapshot || null,
  }
}

// ----------------------------------------------------------------------- metrics

/**
 * Numbers about the open trade, handed to the model as inputs. `candles` are 5M bars (any window); the excursions are
 * measured only over bars that closed after entry (plus the current price).
 */
export function computeTradeMetrics({ trade, price, candles = [], now = Date.now() }) {
  const sign = sideSign(trade)
  const entry = Number(trade.entryPrice)
  const initialStop = finiteOrNull(trade.initialStopLoss) ?? finiteOrNull(trade.stopLoss)
  const initialTakeProfit = finiteOrNull(trade.initialTakeProfit) ?? finiteOrNull(trade.takeProfit)
  const stop = finiteOrNull(trade.stopLoss)
  const takeProfit = finiteOrNull(trade.takeProfit)
  const initialRisk = initialStop ? Math.abs(entry - initialStop) : 0
  const toR = (priceMove) => (initialRisk > 0 ? priceMove / initialRisk : null)

  const since = candles.filter((candle) => Number(candle.closeTime) > Number(trade.transactTime || 0))
  const highs = [price, ...since.map((candle) => Number(candle.high))].filter(Number.isFinite)
  const lows = [price, ...since.map((candle) => Number(candle.low))].filter(Number.isFinite)
  const bestPrice = sign === 1 ? Math.max(...highs) : Math.min(...lows)
  const worstPrice = sign === 1 ? Math.min(...lows) : Math.max(...highs)

  const notional = Number(trade.notional)
  const unrealizedPnl = Number.isFinite(notional) && entry > 0 ? (sign * (price - entry) / entry) * notional : null

  return {
    side: sign === 1 ? 'LONG' : 'SHORT',
    entryPrice: entry,
    price,
    initialStop,
    currentStop: stop,
    initialTakeProfit,
    currentTakeProfit: takeProfit,
    elapsedMinutes: round((now - Number(trade.transactTime || now)) / 60_000, 1),
    priceChangePct: round((sign * (price - entry) / entry) * 100, 3),
    rMultiple: round(toR(sign * (price - entry)), 2),
    unrealizedPnlUsdt: round(unrealizedPnl, 2),
    realizedPartialPnlUsdt: round(Number(trade.partialRealizedPnl || 0), 2),
    maxFavorableExcursionPct: round((sign * (bestPrice - entry) / entry) * 100, 3),
    maxFavorableExcursionR: round(toR(sign * (bestPrice - entry)), 2),
    maxAdverseExcursionPct: round((sign * (worstPrice - entry) / entry) * 100, 3),
    maxAdverseExcursionR: round(toR(sign * (worstPrice - entry)), 2),
    distanceToStopPct: stop ? round((sign * (price - stop) / price) * 100, 3) : null,
    distanceToStopR: stop ? round(toR(sign * (price - stop)), 2) : null,
    distanceToTargetPct: takeProfit ? round((sign * (takeProfit - price) / price) * 100, 3) : null,
    distanceToTargetR: takeProfit ? round(toR(sign * (takeProfit - price)), 2) : null,
    stopVsEntryR: stop ? round(toR(sign * (stop - entry)), 2) : null, // > 0 means the stop already sits beyond entry (profit locked)
    remainingPositionPct: round(trade.initialQuantity ? (Number(trade.quantity) / Number(trade.initialQuantity)) * 100 : 100, 1),
  }
}

// ------------------------------------------------------------------------ prompt

const DECISION_HELP = [
  'HOLD — the thesis is intact and there is no strong reason to interfere. Doing nothing is a valid trading decision; do not change the trade just because you were asked to review it.',
  'MOVE_TO_BREAKEVEN — protecting the original capital is now worth more than the original stop distance. You decide when; do not move too early and get a good trade stopped on a normal retracement.',
  'TIGHTEN_STOP — the trade is still valid but conditions weakened enough that the original risk is no longer justified. You choose the new stop (suggestedStop).',
  'LET_PROFIT_RUN — the original target now looks too conservative. Remove the take profit and protect the trade with a stop (suggestedStop, higher for a LONG / lower for a SHORT) so it can run beyond the old target.',
  'EXTEND_TAKE_PROFIT — replace the target with a more ambitious one (suggestedTakeProfit) because new evidence supports continuation; justify why the opportunity is larger than at entry. Pair it with a protective stop (suggestedStop) when appropriate. Do not extend merely because price is near the target.',
  'PARTIAL_TAKE_PROFIT — realize part of the position and keep the rest (partialClosePct, 1-99, your choice), optionally raising the stop on the remainder.',
  'EXIT_NOW — close the whole position at market. The stop is the maximum planned failure point, not a promise to wait for it: if the reason for the trade is gone, leaving early at -0.3R beats a full -1R.',
]

function formatReview(review) {
  const time = new Date(review.at).toISOString().slice(11, 16)
  const bits = [`${time} UTC: ${review.decision}`, `thesis ${review.thesisConfidence}%`]
  if (review.suggestedStop != null) bits.push(`stop ${review.suggestedStop}`)
  if (review.suggestedTakeProfit != null) bits.push(`target ${review.suggestedTakeProfit}`)
  if (review.partialClosePct != null) bits.push(`partial ${review.partialClosePct}%`)
  const outcome = review.executed === false ? ` (NOT executed: ${review.rejectedReason || 'rejected'})` : review.advisoryOnly ? ' (advisory only, not executed)' : ''
  return `${bits.join(', ')}${outcome}. Reason: ${review.reason} Expected next: ${review.expectedNext} Invalidation: ${review.invalidation}`
}

function changesSinceEntry(entry, snapshot, metrics, flowMetricsNow) {
  if (!entry) return ['Entry-time market state was not recorded for this trade, so compare against the thesis text above.']
  const now = snapshot.indicators
  const lines = []
  const pair = (label, before, after, digits = 2) => {
    if (before == null || after == null) return
    lines.push(`- ${label}: ${fx(before, digits)} -> ${fx(after, digits)}`)
  }
  lines.push(`- price: ${fx(entry.price, 4)} -> ${fx(snapshot.price, 4)} (${metrics.priceChangePct}% in the trade's favour)`)
  if (entry.regime && now.regime && entry.regime !== now.regime) lines.push(`- regime: ${entry.regime} -> ${now.regime}`)
  else if (now.regime) lines.push(`- regime: unchanged (${now.regime})`)
  pair('trend score', entry.trendScore, now.trendScore, 3)
  pair('1H ADX', entry.adx1h, now.adx1h, 1)
  pair('5M RSI', entry.rsi, now.rsi, 1)
  pair('RSI slope', entry.rsiSlope, now.rsiSlope, 3)
  pair('z-score', entry.zscore, now.zscore)
  pair('ATR % of price', entry.atrPct, snapshot.atrPct, 3)
  pair('latest volume vs 20-bar mean (x)', entry.relVol, now.relVol)
  pair('position in the 40-bar range', entry.rangePos, now.rangePos)
  pair('Bollinger band position', entry.bbPosition, now.bb?.position)
  if (entry.fundingRatePct != null && snapshot.fundingRate != null) lines.push(`- funding: ${fx(entry.fundingRatePct, 4)}% -> ${fx(snapshot.fundingRate * 100, 4)}%`)
  return lines
}

/**
 * Prompts for one review. `entryContext` comes from buildEntryContext (stored on the trade); `snapshot` is the current market
 * snapshot (pipeline.js buildMarketSnapshot); `flowMetrics` the current derivatives data (flow-data.js) or null.
 */
export function positionManagerPrompts({ trade, entryContext, metrics, snapshot, flowMetrics, previousReviews = [], testMode = false }) {
  const ctx = entryContext || {}
  const a = ctx.analyst
  const f = ctx.flow
  const c = ctx.critic
  const r = ctx.risk
  const shown = previousReviews.slice(0, PREVIOUS_REVIEWS_SHOWN).reverse()
  const m = metrics

  const systemPrompt = [
    'You are the Position Manager in a crypto perpetual-futures trading system: an AI trader who has INHERITED an already-open position after entry.',
    'Four other agents (Market Analyst, Market Flow, Critic, Risk Manager) decided to open it and set the original stop and target. You are not there merely to guard those numbers; you continuously reconsider how the open trade should be managed as new market information arrives.',
    'The software gives you information and executes your decision. It applies NO fixed trading rules: values such as R multiple, distance to stop/target, profit, drawdown, volatility and what changed since entry are inputs for your judgment, and you decide what they mean in context.',
    'Balance three goals: (1) minimize loss - if the original idea is deteriorating, reduce the loss or leave before the full stop is hit; (2) reach breakeven when appropriate, without choking a healthy trade too early; (3) maximize winners - if the thesis strengthens after entry, do not mechanically accept the original target.',
    'Entry confidence and position confidence are different: the Risk Manager answered "should we take this trade?"; you answer "now that we are in it, how healthy is the thesis and what should we do with the position?". Your thesis confidence should evolve with the trade.',
    'Safety limits enforced in code (they only stop you from adding risk or sending an invalid order; an action that breaks them is rejected and the trade keeps its current orders): a stop can only move toward profit and must sit on the protective side of the current price; a target can only be extended further out or removed; you can only reduce or close the position, never add to it.',
    testMode ? 'TEST MODE (testnet, fake money): this trade exists to exercise the whole system. Manage it exactly as you would any trade.' : '',
    'Respond with a single JSON object only, no prose outside it.',
  ].filter(Boolean).join(' ')

  const userPrompt = [
    `OPEN POSITION: ${m.side} ${trade.symbol} (USDT-margined perpetual), ${trade.leverage}x, ${trade.marginMode || 'ISOLATED'} margin.`,
    '',
    'ORIGINAL THESIS (why the trade was taken):',
    a ? `- Market Analyst: ${a.action} at ${a.confidence}%, regime "${a.regime}". Key factors: ${(a.keyFactors || []).join(' | ') || 'none given'}. ${a.reasoning}` : '- Market Analyst output not recorded.',
    f ? `- Market Flow: ${flowSummary({ verdict: f.verdict, crowding: f.crowding, flags: f.flags || [], reasoning: f.reasoning })}` : '- Market Flow output not recorded.',
    c ? `- Critic: ${c.verdict}. ${(c.objections || []).map((item) => `[${item.severity}] ${item.issue}`).join(' ') || 'No objections.'} ${c.reasoning}` : '- Critic output not recorded.',
    r ? `- Risk Manager (final entry approver): ${r.decision || 'approved'}${r.reduced ? ' (reduced size)' : ''} at ${r.confidence ?? ctx.entryConfidence ?? 'n/a'}% entry confidence. ${r.reasoning} Concerns: ${(r.concerns || []).join(' | ') || 'none'}.` : '- Risk Manager output not recorded.',
    '',
    'TRADE STATE (inputs, not rules):',
    `- Entry ${fx(m.entryPrice, 4)}; now ${fx(m.price, 4)} (${fx(m.priceChangePct, 3)}% in the trade's favour); elapsed ${fx(m.elapsedMinutes, 1)} min.`,
    `- Initial stop ${fx(m.initialStop, 4)}, current stop ${fx(m.currentStop, 4)} (stop vs entry: ${fx(m.stopVsEntryR)}R, positive = profit already locked).`,
    `- Initial take profit ${fx(m.initialTakeProfit, 4)}, current take profit ${m.currentTakeProfit == null ? 'NONE (open-ended)' : fx(m.currentTakeProfit, 4)}.`,
    `- Unrealized PnL ${fx(m.unrealizedPnlUsdt)} USDT${m.realizedPartialPnlUsdt ? `, already realized from partial closes ${fx(m.realizedPartialPnlUsdt)} USDT` : ''}; current R multiple ${fx(m.rMultiple)}R; position still open ${fx(m.remainingPositionPct, 1)}% of the original size.`,
    `- Max favorable excursion ${fx(m.maxFavorableExcursionPct, 3)}% (${fx(m.maxFavorableExcursionR)}R); max adverse excursion ${fx(m.maxAdverseExcursionPct, 3)}% (${fx(m.maxAdverseExcursionR)}R).`,
    `- Distance to stop ${fx(m.distanceToStopPct, 3)}% (${fx(m.distanceToStopR)}R); distance to target ${m.distanceToTargetPct == null ? 'n/a (no target)' : `${fx(m.distanceToTargetPct, 3)}% (${fx(m.distanceToTargetR)}R)`}.`,
    '',
    'CURRENT MARKET (closed candles only):',
    describeMarket(snapshot),
    ...(flowMetrics ? ['', 'CURRENT DERIVATIVES FLOW:', ...describeFlow(flowMetrics).map((line) => `- ${line}`)] : []),
    ...(f?.metrics ? ['', 'DERIVATIVES FLOW AT ENTRY (for comparison):', ...describeFlow(f.metrics).map((line) => `- ${line}`)] : []),
    '',
    'WHAT CHANGED SINCE ENTRY:',
    ...changesSinceEntry(ctx.entrySnapshot, snapshot, m, flowMetrics),
    '',
    shown.length ? 'YOUR PREVIOUS REVIEWS OF THIS TRADE (oldest first):' : 'This is your first review of this trade.',
    ...shown.map((review) => `- ${formatReview(review)}`),
    '',
    'Your available decisions:',
    ...DECISION_HELP.map((line) => `- ${line}`),
    '',
    'Decide fresh what should happen next. Use suggestedStop / suggestedTakeProfit as prices (or null to leave unchanged; suggestedTakeProfit may be "OPEN_ENDED" only to remove the target). Give partialClosePct only for PARTIAL_TAKE_PROFIT.',
    'Reply with exactly: {"decision":"HOLD|MOVE_TO_BREAKEVEN|TIGHTEN_STOP|LET_PROFIT_RUN|EXTEND_TAKE_PROFIT|PARTIAL_TAKE_PROFIT|EXIT_NOW","thesisConfidence":0-100,"suggestedStop":number|null,"suggestedTakeProfit":number|"OPEN_ENDED"|null,"partialClosePct":number|null,"reason":"brief, based on current market evidence","whatChanged":"what changed since the previous review","expectedNext":"what you expect if the thesis is correct","invalidation":"what would make you change this management decision"}',
  ].join('\n')

  return { systemPrompt, userPrompt }
}

// ------------------------------------------------------------------------ parse

/** Lenient about the optional fields; strict about the decision and the confidence. Price validity is the planner's job. */
export function parsePositionManagerOutput(json) {
  const decision = String(json?.decision || '').toUpperCase().replace(/[\s-]+/g, '_')
  if (!AI_POSITION_MANAGER_DECISIONS.includes(decision)) throw new Error(`Position Manager returned an invalid decision: ${json?.decision}`)
  const rawConfidence = json?.thesisConfidence
  const confidence = rawConfidence == null || rawConfidence === '' ? Number.NaN : Number(rawConfidence)
  if (!Number.isFinite(confidence)) throw new Error('Position Manager returned a non-numeric thesis confidence.')

  const takeProfitRaw = json?.suggestedTakeProfit
  const openEnded = typeof takeProfitRaw === 'string' && /^(open[\s_-]?ended|none|remove|no[\s_-]?target)$/i.test(takeProfitRaw.trim())
  return {
    decision,
    thesisConfidence: Math.min(Math.max(Math.round(confidence), 0), 100),
    suggestedStop: isNum(json?.suggestedStop) && Number(json.suggestedStop) > 0 ? Number(json.suggestedStop) : null,
    suggestedTakeProfit: openEnded ? 'OPEN_ENDED' : isNum(takeProfitRaw) && Number(takeProfitRaw) > 0 ? Number(takeProfitRaw) : null,
    partialClosePct: isNum(json?.partialClosePct) ? Number(json.partialClosePct) : null,
    reason: asText(json?.reason),
    whatChanged: asText(json?.whatChanged),
    expectedNext: asText(json?.expectedNext),
    invalidation: asText(json?.invalidation),
  }
}

// ------------------------------------------------------------------------- plan

const reject = (reason) => ({ ok: false, reason })

/**
 * Turns a parsed review into executable steps, or rejects it. Never trades judgment for a rule: it only checks that the
 * requested change is valid for the exchange and does not add risk.
 * @returns {{ ok: true, type: string, closeAll: boolean, partialPct: number|null, newStop: number|null, newTakeProfit: number|'REMOVE'|null, notes: string[] } | { ok: false, reason: string }}
 */
export function planPositionAction({ trade, review, price }) {
  const sign = sideSign(trade)
  const current = Number(price)
  if (!(current > 0)) return reject('No valid current price.')
  const stop = finiteOrNull(trade.stopLoss)
  const takeProfit = finiteOrNull(trade.takeProfit)
  const entry = Number(trade.entryPrice)
  const plan = { ok: true, type: review.decision, closeAll: false, partialPct: null, newStop: null, newTakeProfit: null, notes: [] }

  const checkStop = (candidate) => {
    if (!(candidate > 0)) return 'no valid stop price was given'
    if (sign * (current - candidate) < current * MIN_STOP_BUFFER) return `stop ${candidate} is not on the protective side of the current price ${fx(current, 4)} (it would trigger immediately)`
    if (stop != null && !(sign * (candidate - stop) > 1e-9 * current)) return `stop ${candidate} does not move toward profit from the current stop ${stop} (a stop can only be tightened)`
    return null
  }
  const withOptionalStop = () => {
    if (review.suggestedStop == null) return null
    const problem = checkStop(review.suggestedStop)
    if (problem) return problem
    plan.newStop = review.suggestedStop
    return null
  }

  switch (review.decision) {
    case 'HOLD':
      return plan
    case 'EXIT_NOW':
      plan.closeAll = true
      return plan
    case 'MOVE_TO_BREAKEVEN': {
      if (stop != null && sign * (stop - entry) >= 0) {
        plan.notes.push('The stop already sits at or beyond breakeven.')
        return plan
      }
      const problem = checkStop(entry)
      if (problem) return reject(`Breakeven not possible: ${problem}.`)
      plan.newStop = entry
      return plan
    }
    case 'TIGHTEN_STOP': {
      if (review.suggestedStop == null) return reject('TIGHTEN_STOP without a suggestedStop.')
      const problem = withOptionalStop()
      return problem ? reject(`Tighten rejected: ${problem}.`) : plan
    }
    case 'LET_PROFIT_RUN': {
      const problem = withOptionalStop()
      if (problem) return reject(`Let-profit-run rejected: ${problem}.`)
      if (takeProfit != null) plan.newTakeProfit = 'REMOVE'
      else if (plan.newStop == null) plan.notes.push('There is no target to remove and the stop is unchanged.')
      return plan
    }
    case 'EXTEND_TAKE_PROFIT': {
      const target = review.suggestedTakeProfit
      if (!(typeof target === 'number' && target > 0)) return reject('EXTEND_TAKE_PROFIT without a numeric suggestedTakeProfit.')
      if (!(sign * (target - current) > current * MIN_TARGET_BUFFER)) return reject(`Target ${target} is not beyond the current price ${fx(current, 4)}.`)
      if (takeProfit != null && !(sign * (target - takeProfit) > 0)) return reject(`Target ${target} is not further out than the current target ${takeProfit} (a target can only be extended).`)
      const problem = withOptionalStop()
      if (problem) return reject(`Extend rejected: ${problem}.`)
      plan.newTakeProfit = target
      return plan
    }
    case 'PARTIAL_TAKE_PROFIT': {
      const pct = review.partialClosePct
      if (!(pct >= 1 && pct <= 99)) return reject(`PARTIAL_TAKE_PROFIT needs a partialClosePct between 1 and 99 (got ${pct}).`)
      const problem = withOptionalStop()
      if (problem) return reject(`Partial rejected: ${problem}.`)
      plan.partialPct = pct
      return plan
    }
    default:
      return reject(`Unknown decision ${review.decision}.`)
  }
}

// ------------------------------------------------------------------ bookkeeping

/**
 * Records a partial close on the trade record: shrinks quantity / notional / margin to what remains and banks the closed
 * leg's PnL. The final close adds `partialRealizedPnl` (see closeTradeRecord in the server).
 */
export function applyPartialClose(trade, { quantity, price, at = Date.now(), orderId = null }) {
  const total = Number(trade.quantity)
  const closed = Math.min(Math.max(Number(quantity), 0), total)
  if (!(closed > 0) || !(total > 0)) return trade
  const fraction = closed / total
  const sign = sideSign(trade)
  const entry = Number(trade.entryPrice)
  const legPnl = Number.isFinite(price) && entry > 0 ? (sign * (price - entry) / entry) * Number(trade.notional) * fraction : 0
  const keep = 1 - fraction
  return {
    ...trade,
    initialQuantity: trade.initialQuantity ?? total,
    quantity: Number((total * keep).toFixed(8)),
    ...(trade.exchangeExecutedQuantity != null ? { exchangeExecutedQuantity: Number((Number(trade.exchangeExecutedQuantity) * keep).toFixed(8)) } : {}),
    notional: Number((Number(trade.notional) * keep).toFixed(8)),
    margin: Number((Number(trade.margin) * keep).toFixed(4)),
    maxLossPerTrade: Number((Number(trade.maxLossPerTrade) * keep).toFixed(4)),
    partialRealizedPnl: Number(((trade.partialRealizedPnl || 0) + legPnl).toFixed(2)),
    partialLastAt: at,
    // Kept as a string: Binance order ids now exceed 2^53, and Number() would round two different ids to the same value.
    partialCloseOrderIds: orderId ? [...(trade.partialCloseOrderIds || []), String(orderId)] : (trade.partialCloseOrderIds || []),
    partialCloses: [...(trade.partialCloses || []), { at, quantity: closed, price, pnl: Number(legPnl.toFixed(2)) }],
  }
}

/** Appends a review to the trade's log (newest first, capped) and stamps the review time. */
export function recordReview(trade, review, { at = Date.now(), metrics = null, executed = null, rejectedReason = null, advisoryOnly = false, applied = null } = {}) {
  const entry = {
    at,
    ...review,
    rMultiple: metrics?.rMultiple ?? null,
    price: metrics?.price ?? null,
    stopAtReview: metrics?.currentStop ?? null,
    takeProfitAtReview: metrics?.currentTakeProfit ?? null,
    ...(executed === false ? { executed: false, rejectedReason } : {}),
    ...(advisoryOnly ? { advisoryOnly: true } : {}),
    ...(applied ? { applied } : {}),
  }
  return { ...trade, managerLastReviewAt: at, managerReviews: [entry, ...(trade.managerReviews || [])].slice(0, MAX_STORED_REVIEWS) }
}
