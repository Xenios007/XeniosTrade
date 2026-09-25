// AI Trading entry pipeline — four agents decide whether a trade should exist (a fifth, the Position Manager, manages it after entry;
// see position-manager.js):
//
//   Market data -> Market Analyst -> Market Flow Agent -> Critic -> Risk Manager (receives everything above, final judgment) -> Trade / No Trade
//
// This is advisory only. Nothing here talks to an exchange, a wallet or the
// auto-trade loop; the result is a report. Design rules:
//
//  - All four entry agents call an LLM. The Market Flow Agent reads derivatives
//    positioning and order flow (flow-data.js) that the Analyst cannot see.
//    Backtest statistics are background context for the Risk Manager only —
//    no longer an agent and no longer a gate.
//  - AI Trading, not bot trading: every stage always runs and reaches the Risk Manager (Flow AGAINST and
//    Critic REJECT are EVIDENCE in its prompt, not pass/fail checkpoints that skip it — a bot scores and
//    filters; this pipeline lets the AI that is actually built to weigh conflicting evidence see all of it).
//    Fail closed still applies to a genuine stage failure (no provider, an LLM/parse error, no flow data): that
//    stops the pipeline, because there is nothing to reason over, not because a verdict disagreed with something.
//  - There is no separate Decision Agent: the Risk Manager is the sole gate for entry — its own
//    APPROVE / REDUCE / VETO (see evaluateGates). No other stage's verdict and no confidence threshold in code
//    overrides that; a lower-confidence APPROVE still opens exactly as the Risk Manager sized it.
//  - The Risk Manager (an LLM) owns entry / stop / target / size / leverage outright — not "proposes, then code
//    clamps." Whatever it answers is what gets sized into a plan (buildRiskPlan does the $ arithmetic only: risk%
//    and stop% into notional, leverage into margin — it does not widen, tighten, cap or veto). The only checks
//    left are real external constraints, not opinions on trade quality: the exchange's minimum order size and the
//    wallet's actual available margin (reviewRiskProposal / fitPlanToExchangeMinimum), because those aren't a
//    ceiling on the AI's judgment, they're what can and cannot literally be submitted to Binance.
//  - config.risk (accountEquityUsdt, riskPerTradePct, maxLeverage, ...) is no longer enforced. It is shown to the
//    Risk Manager as reference numbers (what a rule-based bot would mechanically do, for contrast) and used to
//    convert its riskPercent into dollars; nothing in code clamps or vetoes against it anymore.
//  - Exceptions, each behind its own config.strategy switch (all off by default = everything above holds unchanged), added after
//    a 33-trade testnet run lost to fees with no entry edge (docs/AI_TRADING.md, "Strategy switches"):
//      timeframe 'swing'  1H entries, 4H trend, 1D confirmation instead of 5M / 1H scalps.
//      trendFilter        a code gate: only the higher-timeframe trend's direction may be traded (trendDirection / trendGate).
//      feeAware           a code veto on the final plan: target vs fee, reward:risk after fees, stop vs ATR (feeAwareProblems).
//      lean               3 agents: no Flow / Critic calls; the Analyst reads the flow data and the Risk Manager plays Critic.
//      makerEntry         execution only (maker-entry.js), nothing here.

import {
  AI_TRADING_AGENTS, AI_TRADING_MIN_NET_REWARD_RISK, AI_TRADING_MIN_TARGET_FEE_MULTIPLE, AI_TRADING_ROUND_TRIP_FEE_PCT,
  AI_TRADING_TEST_MODE_MIN_LEVERAGE, AI_TRADING_TIMEFRAMES, AI_TRADING_TREND_THRESHOLD, aiStrategyTag, getAiTradingTimeframe,
} from '../../src/lib/aiTrading.js'
import { indicatorBundle } from '../strategy/shared-signals.js'
import { describeFlow } from './flow-data.js'
import { lookupQuantEdge } from './quant-stats.js'
import { fitPlanToExchangeMinimum } from './exchange-fit.js'
import { RISK_MANAGER_SYSTEM_PROMPT, riskManagerPipelineNotes } from './risk-manager-prompt.js'
import { describeRiskEvidence } from './risk-evidence.js'

export const MIN_ENTRY_BARS = 90
export const MIN_BIAS_BARS = 40

const AGENT_BY_ID = Object.fromEntries(AI_TRADING_AGENTS.map((agent) => [agent.id, agent]))
const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const fx = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a')

// ---------------------------------------------------------------- market data

/** Turns raw candle windows into the snapshot the Analyst/Critic reason over. */
export function buildMarketSnapshot({ symbol, entry: rawEntry, bias: rawBias, higher: rawHigher = [], regime: rawRegime = null, timeframe = AI_TRADING_TIMEFRAMES.scalp, marketContext = {}, nowMs = Date.now() }) {
  // Exchange kline feeds end with the still-forming candle (a few seconds of volume, partial wicks), which
  // reads as "volume collapsed to 0.00x" and a fake reversal. Everything the agents see must be closed.
  const closedOnly = (candles) => candles.filter((candle) => !(candle.closeTime > nowMs))
  const entry = closedOnly(rawEntry)
  const bias = closedOnly(rawBias)
  const higher = closedOnly(rawHigher)
  // The classifier's higher-timeframe confirmation: the swing profile passes daily candles; the scalp profile never had one here.
  const regimeCandles = Array.isArray(rawRegime) ? closedOnly(rawRegime) : (marketContext?.regime4hCandles || null)

  if (entry.length < MIN_ENTRY_BARS || bias.length < MIN_BIAS_BARS) {
    throw new Error(`Not enough candle history for ${symbol} (${entry.length} ${timeframe.entry.label} / ${bias.length} ${timeframe.bias.label} bars).`)
  }

  const b = indicatorBundle(entry, bias, regimeCandles)
  // The last 24 hours of the bias series, whatever its bar length.
  const last24h = bias.slice(-Math.max(1, Math.round(1440 / timeframe.bias.minutes)))
  const funding = Number(marketContext?.fundingRate)

  return {
    symbol,
    price: b.price,
    atrPct: b.price > 0 ? (b.atr / b.price) * 100 : 0,
    fundingRate: Number.isFinite(funding) ? funding : null,
    indicators: b,
    recentCandles: entry.slice(-10).map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
    hourly: {
      high24h: Math.max(...last24h.map((c) => c.high)),
      low24h: Math.min(...last24h.map((c) => c.low)),
      closes: bias.slice(-8).map((c) => c.close),
    },
    fifteenMinuteCloses: higher.slice(-8).map((c) => c.close), // the timeframe's `context` series (15M for scalp, 1D for swing)
    candleCloseTime: Number(entry.at(-1)?.closeTime ?? 0),
    entryCandles: entry, // closed entry-timeframe bars
    timeframe,
  }
}

export function describeMarket(snapshot) {
  const b = snapshot.indicators
  const tf = snapshot.timeframe || AI_TRADING_TIMEFRAMES.scalp
  const E = tf.entry.label
  const B = tf.bias.label
  const pct = (value) => `${(value * 100).toFixed(3)}%`
  return [
    `Symbol: ${snapshot.symbol} (USDT-margined perpetual futures), current close ${snapshot.price}`,
    `Regime (${B}${tf.regime ? `/${tf.regime.label}` : '/4H'} classifier): ${b.regime}, trend score ${fx(b.trendScore, 3)} (range -4..+4); ${B} ADX14 ${fx(b.adx1h, 1)}; ${B} EMA20-EMA50 gap ${pct(b.biasTrendGap)}`,
    `${E} momentum: RSI14 ${fx(b.rsi, 1)} (slope ${fx(b.rsiSlope, 3)}), z-score vs 20-bar mean ${fx(b.zscore)}, EMA20 distance ${pct(b.emaDist)}, VWAP distance ${pct(b.vwapDist)}`,
    `${E} volatility: ATR14 ${fx(b.atr, 6)} (${fx(snapshot.atrPct, 3)}% of price, ${b.atrExpanding ? 'expanding' : b.atrCompressed ? 'compressed' : 'steady'}), Bollinger(20,2) width ${fx(b.bb.width, 4)}, band position ${fx(b.bb.position)}, squeeze ${b.squeeze ? 'yes' : 'no'}`,
    `Volume: latest is ${fx(b.relVol)}x the 20-bar mean (previous bar ${fx(b.relVolPrev)}x)`,
    `Structure: 40-bar ${E} range ${b.recentLow} to ${b.recentHigh} (price at ${fx(b.rangePos)} of range, width ${pct(b.rangeBandPct)}); 24h ${B} range ${snapshot.hourly.low24h} to ${snapshot.hourly.high24h}`,
    `Latest closed ${E} candle: body/range ${fx(b.bodyRange)}, lower wick ${fx(b.lowerWick)}, upper wick ${fx(b.upperWick)}, bull reclaim ${b.bullReclaim}, bear reject ${b.bearReject}`,
    `Funding rate: ${snapshot.fundingRate == null ? 'unavailable' : `${(snapshot.fundingRate * 100).toFixed(4)}%`}`,
    `Last 8 ${B} closes: ${snapshot.hourly.closes.join(', ')}`,
    `Last 8 ${tf.context.label} closes: ${snapshot.fifteenMinuteCloses.join(', ') || 'n/a'}`,
    `Last 10 closed ${E} candles (o/h/l/c/vol, oldest to newest):`,
    ...snapshot.recentCandles.map((c) => `  ${c.o}/${c.h}/${c.l}/${c.c}/${fx(c.v, 1)}`),
  ].join('\n')
}

/**
 * The market state at the moment of entry, compact and stored on the run so the Position Manager can show the model what
 * has changed since. Numbers only; nothing here interprets them.
 */
export function summarizeEntrySnapshot(snapshot, at = Date.now()) {
  const b = snapshot.indicators
  return {
    at,
    price: snapshot.price,
    regime: b.regime,
    trendScore: round(b.trendScore, 3),
    adx1h: round(b.adx1h, 1),
    rsi: round(b.rsi, 1),
    rsiSlope: round(b.rsiSlope, 3),
    zscore: round(b.zscore, 2),
    vwapDistPct: round(b.vwapDist * 100, 3),
    atrPct: round(snapshot.atrPct, 3),
    atrState: b.atrExpanding ? 'expanding' : b.atrCompressed ? 'compressed' : 'steady',
    bbPosition: round(b.bb.position, 2),
    relVol: round(b.relVol, 2),
    rangePos: round(b.rangePos, 2),
    fundingRatePct: snapshot.fundingRate == null ? null : round(snapshot.fundingRate * 100, 4),
  }
}

// ------------------------------------------------------------------- parsing

const asText = (value, max = 600) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const asTextList = (value, maxItems = 6, maxLen = 240) => (Array.isArray(value)
  ? value.map((item) => asText(item, maxLen)).filter(Boolean).slice(0, maxItems)
  : [])

function requireConfidence(value, label) {
  // Number(null) and Number('') are 0 — a missing confidence must be an error, not a silent 0.
  const confidence = value == null || value === '' ? Number.NaN : Number(value)
  if (!Number.isFinite(confidence)) throw new Error(`${label} returned a non-numeric confidence.`)
  return clamp(Math.round(confidence), 0, 100)
}

export function parseAnalystOutput(json) {
  const action = String(json?.action || '').toUpperCase().replace('WAIT', 'HOLD')
  if (!['LONG', 'SHORT', 'HOLD'].includes(action)) throw new Error(`Analyst returned an invalid action: ${json?.action}`)
  const stopLossPercent = Number(json?.stopLossPercent)
  const takeProfitPercent = Number(json?.takeProfitPercent)
  if (action !== 'HOLD' && !(stopLossPercent > 0 && takeProfitPercent > 0)) {
    throw new Error('Analyst proposed a trade without a positive stop-loss and take-profit percentage.')
  }
  return {
    action,
    confidence: requireConfidence(json?.confidence, 'Analyst'),
    regime: asText(json?.regime, 60) || 'UNCLEAR',
    stopLossPercent: Number.isFinite(stopLossPercent) ? clamp(stopLossPercent, 0.05, 20) : null,
    takeProfitPercent: Number.isFinite(takeProfitPercent) ? clamp(takeProfitPercent, 0.05, 40) : null,
    keyFactors: asTextList(json?.keyFactors),
    reasoning: asText(json?.reasoning),
  }
}

export function parseCriticOutput(json) {
  const verdict = String(json?.verdict || '').toUpperCase()
  if (!['PASS', 'CAUTION', 'REJECT'].includes(verdict)) throw new Error(`Critic returned an invalid verdict: ${json?.verdict}`)
  const objections = Array.isArray(json?.objections)
    ? json.objections
      .map((item) => ({
        issue: asText(item?.issue, 300),
        severity: ['low', 'medium', 'high'].includes(String(item?.severity).toLowerCase()) ? String(item.severity).toLowerCase() : 'medium',
      }))
      .filter((item) => item.issue)
      .slice(0, 6)
    : []
  return { verdict, objections, reasoning: asText(json?.reasoning) }
}

export function parseFlowOutput(json) {
  const verdict = String(json?.verdict || '').toUpperCase()
  if (!['SUPPORTS', 'NEUTRAL', 'AGAINST'].includes(verdict)) throw new Error(`Market Flow Agent returned an invalid verdict: ${json?.verdict}`)
  const crowding = String(json?.crowding || '').toUpperCase()
  const flags = Array.isArray(json?.flags)
    ? json.flags
      .map((item) => ({
        issue: asText(item?.issue, 300),
        severity: ['low', 'medium', 'high'].includes(String(item?.severity).toLowerCase()) ? String(item.severity).toLowerCase() : 'medium',
      }))
      .filter((item) => item.issue)
      .slice(0, 6)
    : []
  return { verdict, crowding: ['LOW', 'MEDIUM', 'HIGH'].includes(crowding) ? crowding : null, flags, reasoning: asText(json?.reasoning) }
}

export function parseRiskProposal(json) {
  const decision = String(json?.decision || '').toUpperCase().replace('REJECT', 'VETO')
  if (!['APPROVE', 'REDUCE', 'VETO'].includes(decision)) throw new Error(`Risk Manager returned an invalid decision: ${json?.decision}`)
  const number = (value) => (value == null || value === '' ? Number.NaN : Number(value))
  const riskLevel = String(json?.riskLevel || '').toUpperCase()
  const proposal = {
    decision,
    // The Risk Manager's own classification of how much it is risking, driven by its confidence in this specific setup (not a fixed
    // rule) - see riskPrompts. Informational, not a gate: an older/omitted value never blocks a trade.
    riskLevel: ['LOW', 'MEDIUM', 'HIGH'].includes(riskLevel) ? riskLevel : null,
    stopLossPercent: number(json?.stopLossPercent),
    takeProfitPercent: number(json?.takeProfitPercent),
    riskPercent: number(json?.riskPercent),
    leverage: number(json?.leverage),
    // The Risk Manager is the final entry approver, so its confidence is the entry confidence (gated in evaluateGates).
    confidence: decision === 'VETO' && (json?.confidence == null || json?.confidence === '') ? null : requireConfidence(json?.confidence, 'Risk Manager'),
    concerns: asTextList(json?.concerns),
    reasoning: asText(json?.reasoning),
  }
  if (decision !== 'VETO') {
    for (const key of ['stopLossPercent', 'takeProfitPercent', 'riskPercent', 'leverage']) {
      if (!(proposal[key] > 0)) throw new Error(`Risk Manager ${decision === 'REDUCE' ? 'reduced' : 'approved'} the trade without a positive ${key}.`)
    }
  }
  return proposal
}

// ------------------------------------------------------------ trend filter

/**
 * strategy.trendFilter: the higher-timeframe classifier (bias candles + regime confirmation) picks the only direction allowed. Score >=
 * +threshold -> LONG only, <= -threshold -> SHORT only, anything in between -> no trade at all (and no model is called).
 */
export function trendDirection(snapshot, threshold = AI_TRADING_TREND_THRESHOLD) {
  const score = Number(snapshot?.indicators?.trendScore)
  if (!Number.isFinite(score)) return null
  if (score >= threshold) return 'LONG'
  if (score <= -threshold) return 'SHORT'
  return null
}

// ----------------------------------------------------------- fee-aware rules

/**
 * strategy.feeAware: rules checked in code on the Risk Manager's final stop/target (and told to it up front). A plan that fails one is
 * vetoed with the reason, like an exchange constraint - a trade whose expected reward is mostly eaten by fees, or whose stop sits inside
 * ordinary noise, is not worth opening however confident the model is.
 * @returns {string[]} the broken rules (empty = the plan passes)
 */
export function feeAwareProblems({ stopLossPct, takeProfitPct, atrPct, minStopAtrMultiple = 1, feePct = AI_TRADING_ROUND_TRIP_FEE_PCT }) {
  const problems = []
  const minTarget = AI_TRADING_MIN_TARGET_FEE_MULTIPLE * feePct
  if (!(takeProfitPct >= minTarget)) {
    problems.push(`Target ${fx(takeProfitPct)}% is under ${AI_TRADING_MIN_TARGET_FEE_MULTIPLE}x the ~${fx(feePct)}% round-trip fee (${fx(minTarget)}%): fees would take too much of the win.`)
  }
  const netRewardRisk = (takeProfitPct - feePct) / (stopLossPct + feePct)
  if (!(netRewardRisk >= AI_TRADING_MIN_NET_REWARD_RISK)) {
    problems.push(`Reward:risk after fees is ${fx(netRewardRisk)} ((target ${fx(takeProfitPct)}% - fee) / (stop ${fx(stopLossPct)}% + fee)); at least ${fx(AI_TRADING_MIN_NET_REWARD_RISK)} is required.`)
  }
  const minStop = minStopAtrMultiple * Number(atrPct)
  if (Number.isFinite(minStop) && minStop > 0 && !(stopLossPct >= minStop)) {
    problems.push(`Stop ${fx(stopLossPct)}% sits inside normal noise: it must be at least ${fx(minStopAtrMultiple, 1)}x the entry-timeframe ATR (${fx(minStop)}%).`)
  }
  return problems
}

// -------------------------------------------------------------- Risk Manager

/**
 * What a rule-based bot would mechanically do with this stop/target: widen to the ATR floor, tighten to the max
 * stop, reject a thin reward:risk, cap leverage/notional at the configured ceiling, floor leverage in test mode,
 * veto if liquidation sits too close to the stop. Used ONLY to build the reference line shown to the Risk Manager
 * in its prompt (riskPrompts' "plain rule-based sizing" line) — a deliberate contrast, since that mechanical
 * formula is exactly what a bot's signal model does and this pipeline exists to do something else. Not applied
 * to the AI's own plan; see buildRiskPlan for that.
 */
export function mechanicalBaselinePlan({ side, price, atrPct, stopLossPct, takeProfitPct, limits }) {
  const vetoReasons = []
  const adjustments = []
  const {
    accountEquityUsdt, riskPerTradePct, maxLeverage, maxStopLossPct, minStopAtrMultiple, minRewardRisk,
  } = limits
  // Only test mode sets a floor (see riskLimitsFor); everywhere else leverage may be as low as 1x.
  const minLeverage = Math.min(Math.max(Math.floor(limits.minLeverage) || 1, 1), maxLeverage)

  if (!(price > 0) || !(stopLossPct > 0) || !(takeProfitPct > 0)) {
    return { approved: false, vetoReasons: ['Missing a valid price, stop-loss or take-profit to size against.'], adjustments, plan: null, limits }
  }

  const atrFloorPct = minStopAtrMultiple * atrPct
  let stopPct = stopLossPct

  if (atrFloorPct > maxStopLossPct) {
    vetoReasons.push(`Volatility too high: the ${fx(minStopAtrMultiple, 1)}x ATR stop floor (${fx(atrFloorPct)}%) exceeds the ${fx(maxStopLossPct)}% max stop distance.`)
  } else {
    if (stopPct < atrFloorPct) {
      adjustments.push(`Stop widened from ${fx(stopPct)}% to ${fx(atrFloorPct)}% (minimum ${fx(minStopAtrMultiple, 1)}x ATR).`)
      stopPct = atrFloorPct
    }
    if (stopPct > maxStopLossPct) {
      adjustments.push(`Stop tightened from ${fx(stopPct)}% to the ${fx(maxStopLossPct)}% maximum.`)
      stopPct = maxStopLossPct
    }
  }

  const rewardRisk = takeProfitPct / stopPct
  if (rewardRisk < minRewardRisk) {
    vetoReasons.push(`Reward:risk ${fx(rewardRisk)} is below the ${fx(minRewardRisk)} minimum.`)
  }

  const intendedRiskUsdt = (accountEquityUsdt * riskPerTradePct) / 100
  let notional = intendedRiskUsdt / (stopPct / 100)
  const maxNotional = accountEquityUsdt * maxLeverage
  if (notional > maxNotional) {
    notional = maxNotional
    adjustments.push(`Position capped at ${maxLeverage}x leverage (${fx(maxNotional, 0)} USDT notional); risk reduced below target.`)
  }

  const sizedLeverage = clamp(Math.ceil(notional / accountEquityUsdt), 1, maxLeverage)
  const leverage = Math.max(sizedLeverage, minLeverage)
  if (leverage > sizedLeverage) {
    adjustments.push(`Test mode: leverage set to the ${minLeverage}x minimum (position size is unchanged, so the margin is notional / ${minLeverage}).`)
  }
  const liquidationDistancePct = (100 / leverage) * 0.9
  if (stopPct >= liquidationDistancePct) {
    vetoReasons.push(`Stop distance ${fx(stopPct)}% is not safely inside the ~${fx(liquidationDistancePct)}% liquidation distance at ${leverage}x.`)
  }

  const isLong = side === 'LONG'
  const plan = {
    side,
    entryPrice: price,
    stopLoss: price * (isLong ? 1 - stopPct / 100 : 1 + stopPct / 100),
    takeProfit: price * (isLong ? 1 + takeProfitPct / 100 : 1 - takeProfitPct / 100),
    stopLossPct: round(stopPct),
    takeProfitPct: round(takeProfitPct),
    rewardRisk: round(rewardRisk),
    notionalUsdt: round(notional),
    marginUsdt: round(notional / leverage),
    leverage,
    quantity: notional / price,
    maxLossUsdt: round(notional * (stopPct / 100)),
    riskPctOfEquity: round(((notional * (stopPct / 100)) / accountEquityUsdt) * 100),
  }

  return { approved: vetoReasons.length === 0, vetoReasons, adjustments, plan: vetoReasons.length ? null : plan, limits }
}

/**
 * Turns the Risk Manager AI's own stop/target/riskPercent/leverage into a dollar trade plan. Pure arithmetic —
 * translates percentages into notional, margin and quantity — with no ceiling, floor or veto of its own: the
 * numbers are used exactly as the AI chose them. (There used to be a mechanicalBaselinePlan-style clamp here;
 * removed on purpose — see the file header. The Risk Manager's APPROVE/REDUCE/VETO is the only gate.)
 */
export function buildRiskPlan({ side, price, stopLossPct, takeProfitPct, riskPercent, leverage, accountEquityUsdt }) {
  if (!(price > 0) || !(stopLossPct > 0) || !(takeProfitPct > 0) || !(riskPercent > 0) || !(leverage > 0)) return null
  const isLong = side === 'LONG'
  const roundedLeverage = Math.max(1, Math.round(leverage))
  const intendedRiskUsdt = (accountEquityUsdt * riskPercent) / 100
  const notional = intendedRiskUsdt / (stopLossPct / 100)
  return {
    side,
    entryPrice: price,
    stopLoss: price * (isLong ? 1 - stopLossPct / 100 : 1 + stopLossPct / 100),
    takeProfit: price * (isLong ? 1 + takeProfitPct / 100 : 1 - takeProfitPct / 100),
    stopLossPct: round(stopLossPct),
    takeProfitPct: round(takeProfitPct),
    rewardRisk: round(takeProfitPct / stopLossPct),
    notionalUsdt: round(notional),
    marginUsdt: round(notional / roundedLeverage),
    leverage: roundedLeverage,
    quantity: notional / price,
    maxLossUsdt: round(notional * (stopLossPct / 100)),
    riskPctOfEquity: round(riskPercent),
  }
}

/**
 * Turns the AI Risk Manager's answer into the final risk result. A VETO stands as-is. An APPROVE/REDUCE is sized
 * by buildRiskPlan using the AI's own numbers — nothing here second-guesses stop, target, risk% or leverage. The
 * only reason a plan can still fail past this point is a real exchange constraint (fitPlanToExchangeMinimum,
 * below): the wallet's actual margin and Binance's minimum order size, not an opinion about the trade.
 */
export function reviewRiskProposal({ proposal, side, price, limits, constraints = null, atrPct = null }) {
  if (proposal.decision === 'VETO') {
    return {
      approved: false,
      vetoReasons: [proposal.reasoning || 'The Risk Manager vetoed this trade.'],
      adjustments: [],
      plan: null,
      limits,
      ai: proposal,
    }
  }

  const plan = buildRiskPlan({
    side,
    price,
    stopLossPct: proposal.stopLossPercent,
    takeProfitPct: proposal.takeProfitPercent,
    riskPercent: proposal.riskPercent,
    leverage: proposal.leverage,
    accountEquityUsdt: limits.accountEquityUsdt,
  })

  if (!plan) {
    return { approved: false, vetoReasons: ['The Risk Manager did not return a usable plan (missing price, stop, target, risk% or leverage).'], adjustments: [], plan: null, limits, ai: proposal }
  }

  // strategy.feeAware (limits.feeAware, set by riskLimitsFor): the one deliberate exception to "the AI's numbers are final" - see feeAwareProblems.
  if (limits.feeAware) {
    const problems = feeAwareProblems({ stopLossPct: plan.stopLossPct, takeProfitPct: plan.takeProfitPct, atrPct, minStopAtrMultiple: limits.minStopAtrMultiple })
    if (problems.length) {
      return { approved: false, vetoReasons: [`Fee-aware rules: ${problems.join(' ')}`], adjustments: [], plan: null, limits, ai: proposal, feeRuleVeto: true }
    }
  }

  const reviewed = { approved: true, vetoReasons: [], adjustments: [], plan, limits, ai: proposal, reduced: proposal.decision === 'REDUCE' }

  // The wallet margin cap can shrink the position below the exchange's minimum order — a real Binance constraint,
  // not an opinion about the trade. Leverage can make up the difference (the executor applies the same rule), so
  // say so here, and veto now, with the reason, when even a generous leverage stretch cannot reach it. maxLeverage
  // here bounds only this stretch (config.risk.maxLeverage, kept for this one purpose); it never caps the AI's own
  // chosen leverage above — that was already applied unclamped in buildRiskPlan.
  if (reviewed.approved && reviewed.plan && constraints?.minOrderUsdt > 0) {
    const fit = fitPlanToExchangeMinimum({
      planNotional: reviewed.plan.notionalUsdt,
      planLeverage: reviewed.plan.leverage,
      marginCap: constraints.marginCapUsdt,
      minOrderUsdt: constraints.minOrderUsdt,
      maxLeverage: Math.max(limits.maxLeverage, reviewed.plan.leverage),
      stopLossPct: reviewed.plan.stopLossPct,
    })
    reviewed.exchangeFit = fit
    if (!fit.ok) return { ...reviewed, approved: false, plan: null, vetoReasons: [fit.reason] }
    if (fit.changed) {
      reviewed.adjustments.push(`Exchange minimum order ${fx(fit.minOrderUsdt)} USDT: leverage raised to ${fit.leverage}x (position ${fx(fit.notional)} USDT, margin ${fx(fit.margin)} USDT).`)
    }
  }
  return reviewed
}

// ------------------------------------------------------------------- prompts

const SYSTEM_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). Be rigorous and skeptical: HOLD / rejecting is a good outcome when the edge is not clear. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'

// Testnet pipeline-check wording (config.scan.testMode). Only the Analyst changes here; Flow keeps its full
// skepticism — its verdict is evidence for the Risk Manager either way, not something this wording needs to soften.
// The Critic's preamble is deliberately NOT the skeptical one the other stages share ("HOLD / rejecting is a good outcome"): a Critic told
// that, and told its only job is to reject, rejected 27 of 27 setups in normal mode. It is an adversarial reviewer, not a veto machine.
const CRITIC_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'

const TEST_MODE_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). TEST MODE (testnet, fake money): the goal right now is to exercise the whole pipeline, so do NOT default to HOLD. Later stages will still vet and can reject the trade. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
// Test mode also relaxes the Critic, or its ordinary objections (late entry, modest volume) would otherwise read as reasons to REJECT
// on every run. It still lists every real objection; REJECT is kept for a clearly bad trade, and the Risk Manager still sees it either way.
const TEST_MODE_CRITIC_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). TEST MODE (testnet, fake money): this run exists to exercise the whole pipeline. The Risk Manager still vets the trade after you. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
const TEST_MODE_CRITIC_INSTRUCTION = 'TEST MODE: still list every real objection with an honest severity, but use REJECT only for a serious flaw that makes the trade clearly bad (for example it fights strong trend or flow evidence, or the data is broken). Ordinary weaknesses such as a late entry, modest volume or a stretched but plausible range position are CAUTION.'
// Risk Manager in test mode: without this it vetoes almost every modest setup (negative backtest
// background, a Critic CAUTION), so the run never reaches the testnet order.
const TEST_MODE_RISK_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). TEST MODE (testnet, fake money): this run exists to exercise the whole pipeline through to a testnet order. Your own stop/target/size/leverage are used exactly as you set them; no code ceiling or gate sits around you. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
const TEST_MODE_RISK_INSTRUCTION = 'TEST MODE: VETO only if the trade is clearly unacceptable or you cannot form any defensible plan. A weak edge, the negative backtest background, a Critic CAUTION or crowded flow are reasons to size SMALL (for example a low riskPercent and 1-2x leverage), not to veto. Report the confidence you actually hold that the trade should be taken.'
const TEST_MODE_INSTRUCTION = 'TEST MODE: choose the direction the data leans toward even if the edge is modest; return HOLD only if the data is genuinely balanced with no lean at all. Be honest about weak leans: give them a modest confidence (about 55-65) rather than inflating it, and propose a realistic stop and target.'

// Active profile (config.scan.activeMode): the persistent, real-money-capable counterpart of test mode. It changes wording only (never a
// code gate or daily limit): the Analyst takes a modest lean instead of defaulting to HOLD, Market Flow needs two independent adverse
// signals before AGAINST is warranted (a lopsided long/short ratio alone is what blocked most uptrend longs), and the Risk Manager
// REDUCES an extended-but-valid entry instead of vetoing it. The Critic already reserves REJECT for fatal flaws, so it needs no separate wording.
const ACTIVE_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). ACTIVE MODE: the account owner wants this pipeline to find tradable setups rather than default to HOLD. Later stages still vet the trade. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
const ACTIVE_ANALYST_INSTRUCTION = 'ACTIVE MODE: choose the direction the data leans toward even if the edge is modest; return HOLD only if the data is genuinely balanced with no lean at all. Be honest about weak leans: give them a modest confidence (about 55-65) rather than inflating it. Propose stopLossPercent and takeProfitPercent as percentages off the current close, sized to this symbol ATR and realistic for the next few 5M candles.'
const ACTIVE_FLOW_INSTRUCTION = 'ACTIVE MODE: AGAINST needs at least two independent adverse signals (for example open interest moving against the trade, taker flow against it, or extreme funding or basis). A persistently lopsided long/short account ratio on its own is NOT enough: report crowding HIGH if it is, but the verdict is NEUTRAL (or SUPPORTS) unless something else is also against the trade.'
const ACTIVE_RISK_INSTRUCTION = 'ACTIVE MODE: an extended or late entry in a valid trend is a reason to REDUCE (smaller size, tighter stop, nearer target), not to VETO. VETO only for a clearly unacceptable trade: no defensible stop, a fatal flaw the Critic raised, liquidation too close to the stop, broken data, or negative evidence specific to this setup. Background statistics from unrelated bots are weak evidence, not a veto.'

function analystPrompts(snapshot, testMode = false, activeMode = false, { allowedDirection = null, flowMetrics = null, lean = false, feeAware = false } = {}) {
  const tf = snapshot.timeframe || AI_TRADING_TIMEFRAMES.scalp
  const actions = allowedDirection ? `${allowedDirection}|HOLD` : 'LONG|SHORT|HOLD'
  const lines = [
    describeMarket(snapshot),
  ]
  if (lean) {
    lines.push('', 'Derivatives positioning and order flow (you read this yourself; there is no separate flow agent):')
    lines.push(...(flowMetrics ? describeFlow(flowMetrics).map((line) => `- ${line}`) : ['- Flow data unavailable for this run.']))
  }
  lines.push('')
  if (allowedDirection) {
    lines.push(`TREND FILTER: the higher-timeframe trend is ${allowedDirection === 'LONG' ? 'UP' : 'DOWN'} (trend score ${fx(snapshot.indicators.trendScore, 0)}), so only ${allowedDirection} is allowed; the opposite side is never taken. Your job is to judge whether NOW is a good ${allowedDirection} entry within that trend (a pullback, a reclaim, a continuation with room left) or whether to wait: answer ${allowedDirection} or HOLD. HOLD is the right answer when the entry is extended, stretched into a barrier, or the timing is poor. The trade is meant to play out over ${tf.holdHint}.`)
  } else {
    lines.push(`Read the candles, indicators, volume, structure and regime, then decide LONG, SHORT or HOLD for ${tf.holdHint}.`)
  }
  lines.push(testMode ? TEST_MODE_INSTRUCTION : activeMode ? ACTIVE_ANALYST_INSTRUCTION : 'Only choose a direction when the data gives a genuine edge. Propose stopLossPercent and takeProfitPercent as percentages off the current close, sized to this symbol\'s ATR (they are always required, even for HOLD). A downstream Risk Manager may widen, tighten or veto them.')
  if (feeAware) {
    lines.push(`Costs: a round trip costs about ${fx(AI_TRADING_ROUND_TRIP_FEE_PCT)}% of the position, so a target under ${fx(AI_TRADING_MIN_TARGET_FEE_MULTIPLE * AI_TRADING_ROUND_TRIP_FEE_PCT)}% is not worth taking, and a stop inside one ${tf.entry.label} ATR (${fx(snapshot.atrPct, 3)}%) is inside normal noise.`)
  }
  lines.push(`Reply with exactly: {"action":"${actions}","confidence":0-100,"regime":"short label","stopLossPercent":number,"takeProfitPercent":number,"keyFactors":["up to 5 short bullets"],"reasoning":"2-4 sentences"}`)
  return {
    systemPrompt: `${testMode ? TEST_MODE_PREAMBLE : activeMode ? ACTIVE_PREAMBLE : SYSTEM_PREAMBLE} You are the Market Analyst.`,
    userPrompt: lines.join('\n'),
  }
}

export function flowSummary(flow) {
  return `${flow.verdict}${flow.crowding ? `, crowding ${flow.crowding}` : ''}. ${flow.flags.map((item) => `[${item.severity}] ${item.issue}`).join(' ') || 'No flags.'} ${flow.reasoning}`.trim()
}

// Background only: backtests of the rule-based Bots 1-4, not evidence about this setup.
function backtestLine(backtest) {
  return backtest.available
    ? `Backtest background (rule-based Bots 1-4, weak evidence — not this setup): ${backtest.sampleSize} similar trades, win rate ${fx(backtest.winRate * 100, 1)}%, payoff ${fx(backtest.payoffRatio)}, EV ${fx(backtest.expectedValueR)}R (conservative ${fx(backtest.conservativeEvR)}R); this trade needs a ${fx(backtest.breakEvenWinRate * 100, 1)}% win rate to break even.`
    : `Backtest background: ${backtest.note}`
}

function flowPrompts(snapshot, analyst, metrics, activeMode = false) {
  return {
    systemPrompt: `${SYSTEM_PREAMBLE} You are the Market Flow Agent. You judge derivatives positioning and order flow only — the Analyst already covers the chart, so do not restate it.`,
    userPrompt: [
      `Symbol: ${snapshot.symbol} (USDT-margined perpetual), current close ${snapshot.price}`,
      `Analyst proposal: ${analyst.action} at ${analyst.confidence}% confidence, stop ${fx(analyst.stopLossPercent)}%, target ${fx(analyst.takeProfitPercent)}%.`,
      '',
      'Positioning and flow data:',
      ...describeFlow(metrics).map((line) => `- ${line}`),
      '',
      'Judge whether this flow supports the proposed direction. Look for: crowding on the same side as the trade (stretched funding, lopsided long/short ratios) that risks a squeeze against it; whether open interest confirms the move (new positions) or contradicts it (covering/liquidation); aggressive taker flow or book depth leaning against the trade; and, for alts, whether BTC is moving against it. Ignore metrics marked unavailable rather than guessing them.',
      'SUPPORTS = flow confirms the trade; NEUTRAL = mixed or not informative; AGAINST = flow contradicts it or makes it dangerous.',
      ...(activeMode ? [ACTIVE_FLOW_INSTRUCTION] : []),
      'Reply with exactly: {"verdict":"SUPPORTS|NEUTRAL|AGAINST","crowding":"LOW|MEDIUM|HIGH","flags":[{"issue":"specific observation with the number","severity":"low|medium|high"}],"reasoning":"2-3 sentences"}',
    ].join('\n'),
  }
}

function criticPrompts(snapshot, analyst, flow, testMode = false) {
  return {
    systemPrompt: `${testMode ? TEST_MODE_CRITIC_PREAMBLE : CRITIC_PREAMBLE} You are the Critic. You are an adversarial reviewer, not a veto machine. Your job is to find what could make this trade wrong and to say honestly how serious each problem is. You are not the last line of defence: the Risk Manager still sizes the trade and can veto it after you, so reserve REJECT for problems that are clearly fatal. You may acknowledge what is sound about the setup, but your objections are the focus.`,
    userPrompt: [
      describeMarket(snapshot),
      '',
      `Analyst proposal: ${analyst.action} at ${analyst.confidence}% confidence, regime "${analyst.regime}", stop ${fx(analyst.stopLossPercent)}%, target ${fx(analyst.takeProfitPercent)}%.`,
      `Analyst reasoning: ${analyst.reasoning}`,
      `Analyst key factors: ${analyst.keyFactors.join(' | ') || 'none given'}`,
      `Market Flow Agent: ${flowSummary(flow)}`,
      '',
      'Attack the setup: contradicting indicators, chasing an extended move, low volume, range-bound/chop, funding or crowding risk, timeframe disagreement. Every objection must cite a specific number or level from the data above; an objection with no evidence behind it does not count.',
      'The stop and target above are only the Analyst\'s provisional proposal: the Risk Manager sets the final stop, size and leverage after you, so do not REJECT because the proposed stop or target looks too tight or too wide. Judge the setup itself (direction, timing, structure, positioning).',
      'Severity: high = potentially fatal, medium = a real concern the trade can survive, low = minor. Do not mark ordinary weaknesses high just because there are several of them.',
      'Verdict rules. PASS = nothing material. CAUTION = real but ordinary concerns the trade can survive; this is the default whenever your objections are the usual kind (a late or extended entry, nearby resistance or support, modest volume, chop, timeframe disagreement, crowded positioning), however many of them there are. REJECT = only a clearly fatal flaw: the trade fights strong trend or flow evidence, there is no room before an obvious barrier, the thesis is already invalidated, or the data is broken or contradictory. Expect most reasonable setups to end in PASS or CAUTION.',
      ...(testMode ? [TEST_MODE_CRITIC_INSTRUCTION] : []),
      'Reply with exactly: {"verdict":"PASS|CAUTION|REJECT","objections":[{"issue":"specific objection","severity":"low|medium|high"}],"reasoning":"2-3 sentences"}',
    ].join('\n'),
  }
}

/** config.risk's reference numbers (not enforced — see the file header), with the mechanical-baseline leverage floor raised while testnet test mode is on, so that reference plan looks like a real testnet trade. */
export function riskLimitsFor(config) {
  const limits = config.strategy?.feeAware ? { ...config.risk, feeAware: true, roundTripFeePct: AI_TRADING_ROUND_TRIP_FEE_PCT } : config.risk
  if (config.scan?.testMode !== true || config.execution?.mode !== 'testnet') return limits
  return {
    ...limits,
    minLeverage: AI_TRADING_TEST_MODE_MIN_LEVERAGE,
    maxLeverage: Math.max(limits.maxLeverage, AI_TRADING_TEST_MODE_MIN_LEVERAGE),
  }
}

/** The wallet's balance and open AI positions, so the Risk Manager can weigh portfolio exposure (empty when unknown). */
/**
 * Advisory only, never enforced: the account owner's target USDT profit on a winning trade (execution.targetProfitPerTradeUsdt,
 * 0 = no goal stated). Gives concrete numbers so the Risk Manager can reason toward it with its own sizing; it must never take
 * a bad setup just to reach this number.
 */
function profitGoalLines({ target, constraints, limits }) {
  if (!(target > 0)) return []
  const lines = [
    `- The account owner's goal is roughly ${fx(target)} USDT profit on a winning trade (after fees) - not a requirement. Do not take a setup you would otherwise reject just to reach it. When the setup allows it, size (riskPercent, leverage, takeProfitPercent) toward this rather than a much smaller profit; a weak or uncertain setup should still be sized small (or vetoed) even if that misses the goal.`,
  ]
  const cap = constraints?.marginCapUsdt
  if (cap > 0) {
    const largest = cap * limits.maxLeverage
    const neededPct = (target / largest) * 100
    lines.push(`- Example at up to ${limits.maxLeverage}x (a bot-baseline reference leverage, not a ceiling on you) and your ${fx(cap)} USDT margin cap (position ${fx(largest)} USDT): a ${fx(neededPct)}% take-profit would net about ${fx(target)} USDT. A smaller position or lower leverage needs a larger take-profit percent to reach the same USDT profit.`)
  }
  return lines
}

function portfolioLines({ constraints }) {
  if (!constraints) return []
  const lines = []
  if (Number.isFinite(Number(constraints.availableUsdt))) lines.push(`- Wallet available balance: ${fx(constraints.availableUsdt)} USDT.`)
  if (Array.isArray(constraints.openPositions)) {
    lines.push(constraints.openPositions.length
      ? `- Open AI positions in this wallet (portfolio exposure to weigh, including correlation): ${constraints.openPositions
        .map((position) => `${position.symbol} ${position.side} ${fx(position.notionalUsdt)} USDT notional at ${position.leverage}x${Number.isFinite(Number(position.maxLossUsdt)) ? `, max loss ${fx(position.maxLossUsdt)} USDT` : ''}`)
        .join('; ')}.`
      : '- Open AI positions in this wallet: none.')
  }
  return lines
}

/** What the Risk Manager is told about the exchange minimum order and the margin it may use (empty when unknown). */
function constraintLines({ constraints, baseline, limits, symbol }) {
  if (!(constraints?.minOrderUsdt > 0)) return []
  const lines = [
    `- Exchange minimum order for ${symbol}: ${fx(constraints.minOrderUsdt)} USDT of position size. Margin you may use on this trade: ${fx(constraints.marginCapUsdt)} USDT${constraints.mode === 'real' ? ' (the real-money margin cap / available balance)' : ''}.`,
    `- If your sized position is below that minimum, the code raises leverage to reach it: only as far as needed (at least ${limits.maxLeverage}x is available for this, and never less than the leverage you yourself chose), never beyond the position you sized, and only while your stop stays safely inside the liquidation distance. If that is impossible the trade is vetoed. Choose riskPercent, stop and leverage knowing the position has to clear the minimum.`,
  ]
  if (baseline.approved && baseline.plan) {
    const fit = fitPlanToExchangeMinimum({
      planNotional: baseline.plan.notionalUsdt,
      planLeverage: baseline.plan.leverage,
      marginCap: constraints.marginCapUsdt,
      minOrderUsdt: constraints.minOrderUsdt,
      maxLeverage: limits.maxLeverage,
      stopLossPct: baseline.plan.stopLossPct,
    })
    lines.push(fit.ok
      ? (fit.changed
        ? `- At the Analyst's numbers the order would be raised to ${fx(fit.notional)} USDT at ${fit.leverage}x leverage (${fx(fit.margin)} USDT margin).`
        : `- At the Analyst's numbers the order already clears the minimum (${fit.leverage}x leverage).`)
      : `- At the Analyst's numbers this trade could NOT be placed: ${fit.reason}`)
  }
  return lines
}

function riskPrompts({ snapshot, analyst, flow, backtest, critic, limits, testMode = false, activeMode = false, constraints = null, flowMetrics = null, targetProfitUsdt = 0, lean = false }) {
  const atrFloorPct = limits.minStopAtrMultiple * snapshot.atrPct
  const baseline = mechanicalBaselinePlan({
    side: analyst.action,
    price: snapshot.price,
    atrPct: snapshot.atrPct,
    stopLossPct: analyst.stopLossPercent,
    takeProfitPct: analyst.takeProfitPercent,
    limits,
  })
  return {
    // The role text is the project owner's Risk Manager prompt (risk-manager-prompt.js); the notes after it say how this pipeline uses the answer.
    systemPrompt: `${testMode ? `${TEST_MODE_RISK_PREAMBLE}\n\n` : ''}${RISK_MANAGER_SYSTEM_PROMPT.trim()}\n\n${riskManagerPipelineNotes({ testMode, activeMode: activeMode && !testMode })}`,
    userPrompt: [
      describeMarket(snapshot),
      '',
      `Analyst proposal: ${analyst.action} at ${analyst.confidence}% confidence, stop ${fx(analyst.stopLossPercent)}%, target ${fx(analyst.takeProfitPercent)}%. ${analyst.reasoning}`,
      ...(lean
        ? [
          'Derivatives positioning and order flow (raw data; there is no separate flow agent in this pipeline):',
          ...(flowMetrics ? describeFlow(flowMetrics).map((line) => `- ${line}`) : ['- Flow data unavailable for this run.']),
        ]
        : [`Market Flow Agent: ${flowSummary(flow)}`]),
      backtestLine(backtest),
      ...(lean
        ? ['You are also the Critic in this pipeline: before sizing anything, name the strongest reasons this trade could fail (the weakest part of the setup, a barrier in the way, crowded positioning, a move that is already extended, flow working against it) and VETO when they outweigh the case.']
        : [`Critic: ${critic.verdict}. ${critic.objections.map((item) => `[${item.severity}] ${item.issue}`).join(' ') || 'No objections.'}`]),
      ...(limits.feeAware
        ? [`HARD RULES checked in code on the numbers you return (a plan that breaks one is vetoed, not resized): target at least ${fx(AI_TRADING_MIN_TARGET_FEE_MULTIPLE * (limits.roundTripFeePct ?? AI_TRADING_ROUND_TRIP_FEE_PCT))}% (${AI_TRADING_MIN_TARGET_FEE_MULTIPLE}x the ~${fx(limits.roundTripFeePct ?? AI_TRADING_ROUND_TRIP_FEE_PCT)}% round-trip fee); reward:risk after fees, (target - fee) / (stop + fee), at least ${fx(AI_TRADING_MIN_NET_REWARD_RISK)}; stop at least ${fx(limits.minStopAtrMultiple, 1)}x the entry-timeframe ATR (${fx(limits.minStopAtrMultiple * snapshot.atrPct)}%). If the setup cannot meet them, VETO.`]
        : []),
      '',
      'Reference numbers (nothing below is enforced by code — you decide the trade fully; account equity is here so you can convert riskPercent into dollars):',
      `- Account equity ${limits.accountEquityUsdt} USDT; a rule-based bot here would risk at most ${limits.riskPerTradePct}% of equity per trade`,
      `- A rule-based bot here would use at most ${limits.maxLeverage}x leverage`,
      `- A rule-based bot would keep stop distance between ${fx(atrFloorPct)}% (${limits.minStopAtrMultiple}x the current ATR of ${fx(snapshot.atrPct, 3)}%) and ${limits.maxStopLossPct}%, and would require reward:risk of at least ${limits.minRewardRisk}`,
      ...constraintLines({ constraints, baseline, limits, symbol: snapshot.symbol }),
      `For reference, the plain rule-based sizing of the Analyst's numbers would be: ${baseline.approved
        ? `stop ${baseline.plan.stopLossPct}%, target ${baseline.plan.takeProfitPct}%, ${baseline.plan.leverage}x, risking ${baseline.plan.maxLossUsdt} USDT`
        : `a veto (${baseline.vetoReasons.join(' ')})`}. That is what a bot's fixed formula gives you; you are not a bot — use it as one data point, not a template.`,
      ...profitGoalLines({ target: targetProfitUsdt, constraints, limits }),
      ...portfolioLines({ constraints }),
      ...describeRiskEvidence({ evidence: constraints?.evidence, side: analyst.action, stopPct: analyst.stopLossPercent, targetPct: analyst.takeProfitPercent, flowMetrics, maxLeverage: limits.maxLeverage }),
      '',
      'Decide APPROVE with your own stopLossPercent / takeProfitPercent (percent off the current close, placed beyond normal noise for this symbol), riskPercent (percent of equity you are willing to lose if stopped out) and leverage — or REDUCE (open it, but deliberately smaller than the setup would normally earn, when the case is real but weaker), or VETO if the trade does not deserve capital. Scale risk down for weak conviction, high volatility, a Critic CAUTION, or flow that is crowded or only weakly supportive. Your numbers are used exactly as you give them — nothing in code widens a stop, caps leverage or resizes the position afterward, so choose numbers you would actually stake, not a maximum-allowed request.',
      'riskLevel: classify what you are actually about to risk — LOW, MEDIUM or HIGH — driven by how confident you genuinely are in THIS setup, not a fixed rule. HIGH only when the evidence is unusually strong and you would stake more of your own capital on it: a larger riskPercent and/or leverage. LOW when the case is real but you are not that confident, the evidence is mixed, or several factors are working against it: a small riskPercent and low leverage (1-2x). MEDIUM is the ordinary, decent setup. The tier must match the riskPercent/leverage you actually choose — do not call a trade HIGH and then size it small, or LOW and size it large.',
      ...(testMode ? [TEST_MODE_RISK_INSTRUCTION] : activeMode ? [ACTIVE_RISK_INSTRUCTION] : []),
      `confidence (0-100) is your final confidence that this trade should be taken. It is not gated by code at any threshold — whatever you state is used as-is (shown to the account owner) — so give your genuine assessment; a low-confidence APPROVE still opens exactly as you sized it, which is more reason to size it small rather than inflate the number. As a loose reference, past setups here typically wanted upward of ${limits.minConfidence}% conviction before opening. A VETO may omit it.`,
      'Reply with exactly: {"decision":"APPROVE|REDUCE|VETO","riskLevel":"LOW|MEDIUM|HIGH","confidence":0-100,"stopLossPercent":number,"takeProfitPercent":number,"riskPercent":number,"leverage":number,"concerns":["short bullets"],"reasoning":"2-3 sentences"}',
    ].join('\n'),
  }
}

// ------------------------------------------------------------ stage plumbing

function baseStage(id) {
  const agent = AGENT_BY_ID[id]
  return { id, name: agent.name, kind: agent.kind, status: 'skipped', durationMs: 0, summary: '', output: null, error: null }
}

const skipped = (id, reason) => ({ ...baseStage(id), status: 'skipped', summary: reason })

async function runLlmStage({ id, agentConfig, callAgent, prompts, parse }) {
  const stage = baseStage(id)
  const startedAt = Date.now()
  try {
    const { json, providerId, model } = await callAgent({
      providerId: agentConfig?.providerId || '',
      model: agentConfig?.model || '',
      ...prompts,
    })
    stage.provider = providerId
    stage.model = model
    stage.output = parse(json)
    stage.status = 'ok'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stage.status = error?.code === 'NOT_CONFIGURED' ? 'unconfigured' : 'error'
    stage.error = message
    stage.summary = message
    stage.provider = agentConfig?.providerId || null
  }
  stage.durationMs = Date.now() - startedAt
  return stage
}

// -------------------------------------------------------------------- gates

/**
 * The only two real decision points left, both the AI agents' own: did the Analyst see a directional setup at
 * all (if it said HOLD there is nothing to evaluate further), and did the Risk Manager approve or reduce (vs.
 * veto). Flow and Critic are not gates — their verdicts are evidence in the Risk Manager's prompt, and it is the
 * one agent whose job is to weigh them, not a piece of code checking a verdict string. No confidence threshold
 * either: the Risk Manager's own stated confidence stands, whatever it is.
 */
export function evaluateGates({ analyst, risk, trend = null }) {
  const gate = (id, label, passed, detail) => ({ id, label, passed: Boolean(passed), detail })
  const directional = analyst && analyst.action !== 'HOLD'

  return [
    // strategy.trendFilter only: the higher-timeframe trend picked a direction and the Analyst's call (if any) agrees with it.
    ...(trend ? [trendGate(trend, analyst)] : []),
    gate('analyst', 'Analyst sees a directional setup', directional, analyst ? `${analyst.action} at ${analyst.confidence}% confidence.` : 'Analyst stage did not complete.'),
    gate(
      'risk',
      'Risk Manager approves the entry',
      Boolean(risk?.approved),
      risk
        ? (risk.approved
          ? `${risk.reduced ? 'Reduced' : 'Approved'} at ${risk.ai?.confidence ?? 'n/a'}% confidence${risk.ai?.riskLevel ? `, ${risk.ai.riskLevel} risk` : ''}, ${risk.plan.leverage}x, risking ${risk.plan.maxLossUsdt} USDT.`
          : risk.vetoReasons.join(' '))
        : 'Risk stage did not run.',
    ),
  ]
}

/** @param {{ direction: 'LONG'|'SHORT'|null, score: number }} trend */
export function trendGate(trend, analyst = null) {
  const against = trend.direction && analyst && analyst.action !== 'HOLD' && analyst.action !== trend.direction
  const passed = Boolean(trend.direction) && !against
  const detail = !trend.direction
    ? `No clear higher-timeframe trend (score ${fx(trend.score, 0)}; needs ${AI_TRADING_TREND_THRESHOLD} or more either way).`
    : against
      ? `Analyst called ${analyst.action} against the ${trend.direction} trend (score ${fx(trend.score, 0)}).`
      : `${trend.direction} only (trend score ${fx(trend.score, 0)}).`
  return { id: 'trend', label: 'Trade with the higher-timeframe trend', passed, detail }
}

// --------------------------------------------------------------- orchestrator

/**
 * @param {object} args
 * @param {string} args.symbol
 * @param {object} args.config       normalized AI Trading config (agent assignments + reference risk numbers, not enforced — see the file header)
 * @param {(symbol: string) => Promise<{ entry: object[], bias: object[], higher?: object[], marketContext?: object }>} args.getMarketInputs
 * @param {(call: { providerId: string, model: string, systemPrompt: string, userPrompt: string }) => Promise<{ json: object, providerId: string, model: string }>} args.callAgent
 * @param {(symbol: string, snapshot: object) => Promise<{ metrics: object, sources: object }>} args.getFlowData  derivatives/order-flow evidence (flow-data.js); throwing fails the Market Flow stage closed
 * @param {(symbol: string, snapshot: object) => Promise<{ mode: string, minOrderUsdt: number, marginCapUsdt: number, availableUsdt: number } | null>} [args.getTradeConstraints]  exchange minimum order and the margin the wallet allows; lets the Risk Manager size for them
 * @param {object|null} args.backtestStats  aggregated backtest table (loadQuantStats) — background context only
 */
export async function runAiTradingPipeline({ symbol, config, getMarketInputs, getFlowData, getTradeConstraints, callAgent, backtestStats, now = Date.now }) {
  const startedAt = now()
  const run = {
    id: `ai-trading-${symbol}-${startedAt}`,
    symbol,
    startedAt,
    finishedAt: null,
    advisoryOnly: true,
    testMode: config.scan?.testMode === true,
    activeMode: config.scan?.activeMode === true,
    price: null,
    config: { agents: config.agents, risk: config.risk },
    // Which strategy variant produced this run (e.g. 'swing+trend+fee+lean+maker'); the shadow tracker scores each variant separately.
    strategy: aiStrategyTag(config.strategy),
    stages: [],
    final: null,
  }

  const finish = (final) => {
    run.final = final
    run.finishedAt = now()
    return run
  }
  const hold = (reason, gates = []) => finish({ action: 'HOLD', approved: false, confidence: 0, reason, gates, trade: null })

  // 0. Market data
  let snapshot
  try {
    const inputs = await getMarketInputs(symbol)
    snapshot = buildMarketSnapshot({ symbol, ...inputs })
    run.price = snapshot.price
    run.entrySnapshot = summarizeEntrySnapshot(snapshot, now())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    run.stages.push(...['analyst', 'flow', 'critic', 'risk'].map((id) => skipped(id, 'Market data unavailable.')))
    return hold(`Market data unavailable: ${message}`)
  }

  // 0b. Exchange constraints (minimum order, margin the wallet allows) so the Risk Manager can size for them. Optional, and never
  // fatal: without them the Risk Manager just is not told, and the executor still enforces the same rule.
  let constraints = null
  if (getTradeConstraints) {
    constraints = await Promise.resolve()
      .then(() => getTradeConstraints(symbol, snapshot))
      .catch(() => null)
    if (constraints) run.constraints = constraints
  }

  const strategy = config.strategy || {}
  const lean = strategy.lean === true
  run.timeframe = snapshot.timeframe?.id || 'scalp'

  // 0c. Trend filter (strategy.trendFilter): trade only in the higher-timeframe trend's direction. No trend -> no trade, and no model
  // is called at all (a free, instant HOLD).
  let trend = null
  if (strategy.trendFilter) {
    trend = { direction: trendDirection(snapshot), score: Number(snapshot.indicators.trendScore) }
    run.trend = trend
    if (!trend.direction) {
      const gate = trendGate(trend)
      run.stages.push(...['analyst', 'flow', 'critic', 'risk'].map((id) => skipped(id, `Trend filter: ${gate.detail}`)))
      return hold(`Trend filter: ${gate.detail}`, [gate])
    }
  }

  // 0d. 3-agent pipeline (strategy.lean): the Analyst reads the flow data itself, so fetch it first. Never fatal here - the prompts
  // say so when it is missing.
  let flowData = null
  if (lean && getFlowData) {
    flowData = await Promise.resolve().then(() => getFlowData(symbol, snapshot)).catch(() => null)
  }
  const notInLean = (id) => skipped(id, 'Not used in the 3-agent pipeline (the Analyst reads flow data, the Risk Manager plays Critic).')

  // 1. Market Analyst
  const analystStage = await runLlmStage({
    id: 'analyst',
    agentConfig: config.agents.analyst,
    callAgent,
    prompts: analystPrompts(snapshot, config.scan?.testMode === true, config.scan?.activeMode === true, {
      allowedDirection: trend?.direction || null,
      flowMetrics: flowData?.metrics || null,
      lean,
      feeAware: strategy.feeAware === true,
    }),
    parse: parseAnalystOutput,
  })
  const analyst = analystStage.output
  if (analyst) analystStage.summary = `${analyst.action} · ${analyst.confidence}% · ${analyst.regime}`
  run.stages.push(analystStage)

  const skipRest = (reason) => run.stages.push(...['flow', 'critic', 'risk'].map((id) => (lean && id !== 'risk' ? notInLean(id) : skipped(id, reason))))
  if (!analyst) {
    skipRest('Market Analyst did not return a usable call.')
    return hold(`Market Analyst failed: ${analystStage.error}`)
  }
  if (analyst.action === 'HOLD') {
    skipRest('Market Analyst returned HOLD — nothing to vet.')
    return hold(analyst.reasoning || 'Market Analyst returned HOLD.', evaluateGates({ analyst, risk: null, trend }))
  }
  if (trend && analyst.action !== trend.direction) {
    const gates = evaluateGates({ analyst, risk: null, trend })
    skipRest('Analyst call was against the higher-timeframe trend.')
    return hold(`Trend filter: ${gates[0].detail}`, gates)
  }

  // Background context for the Risk Manager; not a stage, not a gate.
  const backtest = lookupQuantEdge(backtestStats, {
    symbol,
    side: analyst.action,
    stopLossPct: analyst.stopLossPercent,
    takeProfitPct: analyst.takeProfitPercent,
  })

  let flow = null
  let critic = null
  if (lean) {
    run.stages.push(notInLean('flow'), notInLean('critic'))
  } else {
    // 2. Market Flow Agent (LLM over derivatives positioning and order flow)
    const flowStarted = Date.now()
    let flowStage
    try {
      if (!getFlowData) throw new Error('No flow data source is configured.')
      flowData = await getFlowData(symbol, snapshot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      flowStage = { ...baseStage('flow'), status: 'error', durationMs: Date.now() - flowStarted, error: message, summary: message }
    }
    if (!flowStage) {
      flowStage = await runLlmStage({
        id: 'flow',
        agentConfig: config.agents.flow,
        callAgent,
        prompts: flowPrompts(snapshot, analyst, flowData.metrics, config.scan?.activeMode === true),
        parse: parseFlowOutput,
      })
      // Keep the evidence next to the verdict so the report is auditable.
      if (flowStage.output) flowStage.output = { ...flowStage.output, metrics: flowData.metrics, sources: flowData.sources }
    }
    flow = flowStage.output
    if (flow) flowStage.summary = `${flow.verdict}${flow.crowding ? ` · crowding ${flow.crowding}` : ''} · ${flow.flags.length} flag(s)`
    run.stages.push(flowStage)

    // AI Trading, not bot trading: Flow's verdict — even AGAINST — is evidence handed to the Risk Manager (see
    // flowSummary in riskPrompts), not a checkpoint that skips it. Only a genuine stage failure stops the pipeline
    // here (fail closed): there is no flow evidence at all to hand forward.
    if (!flow) {
      run.stages.push(...['critic', 'risk'].map((id) => skipped(id, 'Market Flow Agent did not return a usable call.')))
      return hold(`Market Flow Agent failed: ${flowStage.error}`, evaluateGates({ analyst, risk: null }))
    }

    // 3. Critic
    const criticStage = await runLlmStage({
      id: 'critic',
      agentConfig: config.agents.critic,
      callAgent,
      prompts: criticPrompts(snapshot, analyst, flow, config.scan?.testMode === true),
      parse: parseCriticOutput,
    })
    critic = criticStage.output
    if (critic) criticStage.summary = `${critic.verdict} · ${critic.objections.length} objection(s)`
    run.stages.push(criticStage)

    // Same principle as Flow: the Critic's verdict — even REJECT — is evidence for the Risk Manager, not its own
    // checkpoint. Only a genuine stage failure stops the pipeline here.
    if (!critic) {
      run.stages.push(skipped('risk', 'Critic did not return a usable call.'))
      return hold(`Critic failed: ${criticStage.error}`, evaluateGates({ analyst, risk: null }))
    }
  }

  // 4. Risk Manager — receives everything above and makes the final AI judgment: APPROVE / REDUCE / VETO, and
  // its own entry / stop / target / size / leverage. The only remaining gate (evaluateGates, below).
  const riskLimits = riskLimitsFor(config)
  const riskStage = await runLlmStage({
    id: 'risk',
    agentConfig: config.agents.risk,
    callAgent,
    prompts: riskPrompts({ snapshot, analyst, flow, backtest, critic, limits: riskLimits, testMode: config.scan?.testMode === true, activeMode: config.scan?.activeMode === true, constraints, flowMetrics: flowData?.metrics, targetProfitUsdt: config.execution?.targetProfitPerTradeUsdt, lean }),
    parse: parseRiskProposal,
  })
  const riskProposal = riskStage.output
  const risk = riskProposal
    ? reviewRiskProposal({ proposal: riskProposal, side: analyst.action, price: snapshot.price, limits: riskLimits, constraints, atrPct: snapshot.atrPct })
    // No usable Risk Manager answer is a veto: sizing must never fall back to "unchecked".
    : { approved: false, vetoReasons: [`Risk Manager unavailable: ${riskStage.error}`], adjustments: [], plan: null, limits: riskLimits, ai: null }
  risk.backtest = backtest
  riskStage.output = risk
  riskStage.summary = riskProposal
    ? (risk.approved ? `Approved · ${risk.ai?.riskLevel ? `${risk.ai.riskLevel} · ` : ''}${risk.plan.leverage}x · risk ${risk.plan.maxLossUsdt} USDT` : `Veto · ${risk.vetoReasons[0]}`)
    : riskStage.summary
  run.stages.push(riskStage)

  // The Risk Manager is the sole gate for entry: its own APPROVE/REDUCE (vs VETO) is the verdict.
  const gates = evaluateGates({ analyst, risk, trend })
  const approved = gates.every((item) => item.passed)

  if (!approved) {
    const failed = gates.find((item) => !item.passed)
    return hold(risk.approved ? failed?.detail || `Blocked: ${failed?.label}.` : risk.vetoReasons[0] || `Blocked: ${failed?.label}.`, gates)
  }

  return finish({
    action: analyst.action,
    approved: true,
    confidence: risk.ai.confidence,
    reason: risk.ai.reasoning,
    gates,
    trade: risk.plan,
  })
}
