// AI Trading entry pipeline — four agents decide whether a trade should exist (a fifth, the Position Manager, manages it after entry;
// see position-manager.js):
//
//   Market data -> Market Analyst -> Market Flow Agent -> Critic -> Risk Manager (final entry approver) -> Trade / No Trade
//
// This is advisory only. Nothing here talks to an exchange, a wallet or the
// auto-trade loop; the result is a report. Design rules:
//
//  - All four entry agents call an LLM. The Market Flow Agent reads derivatives
//    positioning and order flow (flow-data.js) that the Analyst cannot see.
//    Backtest statistics are background context for the Risk Manager only —
//    no longer an agent and no longer a gate.
//  - Fail closed. A stage that errors or has no provider yields HOLD, never a trade.
//  - There is no separate Decision Agent: the Risk Manager is the final AI for entry
//    (APPROVE / REDUCE / VETO plus a confidence). Approval requires every deterministic
//    gate (see evaluateGates) to pass, and later LLMs are not asked once a gate blocked the trade.
//  - The Risk Manager (an LLM) owns stop / size / leverage; the Analyst only
//    proposes stop and target percentages. Whatever the Risk Manager answers is
//    then clamped by deterministic code to the fixed risk ceilings
//    (reviewRiskProposal / runRiskManager), so the model can be stricter than
//    the limits but never looser.

import { AI_TRADING_AGENTS, AI_TRADING_TEST_MODE_MIN_LEVERAGE } from '../../src/lib/aiTrading.js'
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
export function buildMarketSnapshot({ symbol, entry: rawEntry, bias: rawBias, higher: rawHigher = [], marketContext = {}, nowMs = Date.now() }) {
  // Exchange kline feeds end with the still-forming candle (a few seconds of volume, partial wicks), which
  // reads as "volume collapsed to 0.00x" and a fake reversal. Everything the agents see must be closed.
  const closedOnly = (candles) => candles.filter((candle) => !(candle.closeTime > nowMs))
  const entry = closedOnly(rawEntry)
  const bias = closedOnly(rawBias)
  const higher = closedOnly(rawHigher)

  if (entry.length < MIN_ENTRY_BARS || bias.length < MIN_BIAS_BARS) {
    throw new Error(`Not enough candle history for ${symbol} (${entry.length} 5M / ${bias.length} 1H bars).`)
  }

  const b = indicatorBundle(entry, bias, marketContext?.regime4hCandles || null)
  const last24h = bias.slice(-24)
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
    fifteenMinuteCloses: higher.slice(-8).map((c) => c.close),
    candleCloseTime: Number(entry.at(-1)?.closeTime ?? 0),
    entryCandles: entry, // closed 5M bars, reused by the Market Flow Agent's price-vs-OI comparison
  }
}

export function describeMarket(snapshot) {
  const b = snapshot.indicators
  const pct = (value) => `${(value * 100).toFixed(3)}%`
  return [
    `Symbol: ${snapshot.symbol} (USDT-margined perpetual futures), current close ${snapshot.price}`,
    `Regime (1H/4H classifier): ${b.regime}, trend score ${fx(b.trendScore, 3)}; 1H ADX14 ${fx(b.adx1h, 1)}; 1H EMA20-EMA50 gap ${pct(b.biasTrendGap)}`,
    `5M momentum: RSI14 ${fx(b.rsi, 1)} (slope ${fx(b.rsiSlope, 3)}), z-score vs 20-bar mean ${fx(b.zscore)}, EMA20 distance ${pct(b.emaDist)}, VWAP distance ${pct(b.vwapDist)}`,
    `5M volatility: ATR14 ${fx(b.atr, 6)} (${fx(snapshot.atrPct, 3)}% of price, ${b.atrExpanding ? 'expanding' : b.atrCompressed ? 'compressed' : 'steady'}), Bollinger(20,2) width ${fx(b.bb.width, 4)}, band position ${fx(b.bb.position)}, squeeze ${b.squeeze ? 'yes' : 'no'}`,
    `Volume: latest is ${fx(b.relVol)}x the 20-bar mean (previous bar ${fx(b.relVolPrev)}x)`,
    `Structure: 40-bar 5M range ${b.recentLow} to ${b.recentHigh} (price at ${fx(b.rangePos)} of range, width ${pct(b.rangeBandPct)}); 24h 1H range ${snapshot.hourly.low24h} to ${snapshot.hourly.high24h}`,
    `Latest closed 5M candle: body/range ${fx(b.bodyRange)}, lower wick ${fx(b.lowerWick)}, upper wick ${fx(b.upperWick)}, bull reclaim ${b.bullReclaim}, bear reject ${b.bearReject}`,
    `Funding rate: ${snapshot.fundingRate == null ? 'unavailable' : `${(snapshot.fundingRate * 100).toFixed(4)}%`}`,
    `Last 8 1H closes: ${snapshot.hourly.closes.join(', ')}`,
    `Last 8 15M closes: ${snapshot.fifteenMinuteCloses.join(', ') || 'n/a'}`,
    `Last 10 closed 5M candles (o/h/l/c/vol, oldest to newest):`,
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
  const proposal = {
    decision,
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

// -------------------------------------------------------------- Risk Manager

/**
 * Deterministic limit enforcement. Takes a proposed direction/stop/target and either
 * returns a sized trade plan inside the configured limits or vetoes it. This is the
 * code that has the final word; the AI Risk Manager's numbers are fed through it
 * (see reviewRiskProposal) and are never used unchecked.
 */
export function runRiskManager({ side, price, atrPct, stopLossPct, takeProfitPct, limits }) {
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
    adjustments.push(`${limits.fixedLeverage ? 'Fixed leverage' : 'Test mode'}: leverage set to the ${minLeverage}x ${limits.fixedLeverage ? 'setting' : 'minimum'} (position size is unchanged, so the margin is notional / ${minLeverage}).`)
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
 * Turns the AI Risk Manager's answer into the final risk result. A VETO stands as-is. An APPROVE is
 * re-run through runRiskManager with the model's numbers, capped at the configured limits: the model
 * may ask for less risk, lower leverage, a wider or tighter stop, but anything beyond a limit is clamped
 * (and noted) and a plan that still breaks a limit is vetoed.
 */
export function reviewRiskProposal({ proposal, side, price, atrPct, limits, constraints = null }) {
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

  const notes = []
  const riskPerTradePct = Math.min(proposal.riskPercent, limits.riskPerTradePct)
  if (proposal.riskPercent > limits.riskPerTradePct) {
    notes.push(`Risk Manager asked to risk ${fx(proposal.riskPercent)}% of equity; capped at the ${fx(limits.riskPerTradePct)}% limit.`)
  }
  const maxLeverage = Math.min(Math.max(Math.floor(proposal.leverage), Math.floor(limits.minLeverage) || 1, 1), limits.maxLeverage)
  if (proposal.leverage > limits.maxLeverage) {
    notes.push(`Risk Manager asked for ${fx(proposal.leverage, 0)}x leverage; capped at the ${limits.maxLeverage}x limit.`)
  }

  const result = runRiskManager({
    side,
    price,
    atrPct,
    stopLossPct: proposal.stopLossPercent,
    takeProfitPct: proposal.takeProfitPercent,
    limits: { ...limits, riskPerTradePct, maxLeverage },
  })

  const reviewed = { ...result, adjustments: [...notes, ...result.adjustments], limits, ai: proposal, reduced: proposal.decision === 'REDUCE' }

  // The wallet margin cap can shrink the position below the exchange's minimum order. Leverage can make up the difference (the
  // executor applies the same rule), so say so here, and veto now, with the reason, when even the ceiling cannot reach it.
  if (reviewed.approved && reviewed.plan && constraints?.minOrderUsdt > 0) {
    const fit = fitPlanToExchangeMinimum({
      planNotional: reviewed.plan.notionalUsdt,
      planLeverage: reviewed.plan.leverage,
      marginCap: constraints.marginCapUsdt,
      minOrderUsdt: constraints.minOrderUsdt,
      maxLeverage: limits.maxLeverage,
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

// Testnet pipeline-check wording (config.scan.testMode). Only the Analyst changes here; Flow keeps its
// full skepticism and the code ceilings still cap every number, so this only lets a modest lean reach them.
const TEST_MODE_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). TEST MODE (testnet, fake money): the goal right now is to exercise the whole pipeline, so do NOT default to HOLD. Later stages will still vet and can reject the trade. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
// Test mode also relaxes the Critic, or its ordinary objections (late entry, modest volume) block every run before the Risk
// Manager is ever reached. It still lists every real objection; REJECT is kept for a clearly bad trade.
const TEST_MODE_CRITIC_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). TEST MODE (testnet, fake money): this run exists to exercise the whole pipeline. The Risk Manager still vets the trade after you. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
const TEST_MODE_CRITIC_INSTRUCTION = 'TEST MODE: still list every real objection with an honest severity, but use REJECT only for a serious flaw that makes the trade clearly bad (for example it fights strong trend or flow evidence, or the data is broken). Ordinary weaknesses such as a late entry, modest volume or a stretched but plausible range position are CAUTION.'
// Risk Manager in test mode: without this it vetoes almost every modest setup (negative backtest
// background, a Critic CAUTION), so the run never reaches the testnet order. The code ceilings and gates after them are unchanged.
const TEST_MODE_RISK_PREAMBLE = 'You are one agent in a four-stage crypto perpetual-futures trade-entry pipeline (Market Analyst, Market Flow, Critic, Risk Manager, the final approver). TEST MODE (testnet, fake money): this run exists to exercise the whole pipeline through to a testnet order. Fixed ceilings and gates are enforced in code around you. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
const TEST_MODE_RISK_INSTRUCTION = 'TEST MODE: VETO only if the trade is clearly unacceptable or you cannot form any plan inside the fixed ceilings. A weak edge, the negative backtest background, a Critic CAUTION or crowded flow are reasons to size SMALL (for example a low riskPercent and 1-2x leverage), not to veto. Choose a stop at or beyond the ATR floor and a target that gives at least the required reward:risk. Report the confidence you actually hold that the trade should be taken.'
const TEST_MODE_INSTRUCTION = 'TEST MODE: choose the direction the data leans toward even if the edge is modest; return HOLD only if the data is genuinely balanced with no lean at all. Be honest about weak leans: give them a modest confidence (about 55-65) rather than inflating it, and propose a realistic stop and target.'

function analystPrompts(snapshot, testMode = false) {
  return {
    systemPrompt: `${testMode ? TEST_MODE_PREAMBLE : SYSTEM_PREAMBLE} You are the Market Analyst.`,
    userPrompt: [
      describeMarket(snapshot),
      '',
      'Read the candles, indicators, volume, structure and regime, then decide LONG, SHORT or HOLD for the next few 5M candles.',
      testMode ? TEST_MODE_INSTRUCTION : 'Only choose LONG/SHORT when the data gives a genuine edge. Propose stopLossPercent and takeProfitPercent as percentages off the current close, sized to this symbol\'s ATR (they are always required, even for HOLD). A downstream Risk Manager may widen, tighten or veto them.',
      'Reply with exactly: {"action":"LONG|SHORT|HOLD","confidence":0-100,"regime":"short label","stopLossPercent":number,"takeProfitPercent":number,"keyFactors":["up to 5 short bullets"],"reasoning":"2-4 sentences"}',
    ].join('\n'),
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

function flowPrompts(snapshot, analyst, metrics) {
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
      'Reply with exactly: {"verdict":"SUPPORTS|NEUTRAL|AGAINST","crowding":"LOW|MEDIUM|HIGH","flags":[{"issue":"specific observation with the number","severity":"low|medium|high"}],"reasoning":"2-3 sentences"}',
    ].join('\n'),
  }
}

function criticPrompts(snapshot, analyst, flow, testMode = false) {
  return {
    systemPrompt: `${testMode ? TEST_MODE_CRITIC_PREAMBLE : SYSTEM_PREAMBLE} You are the Critic. Your only job is to find reasons this trade should be rejected. Do not argue in its favour.`,
    userPrompt: [
      describeMarket(snapshot),
      '',
      `Analyst proposal: ${analyst.action} at ${analyst.confidence}% confidence, regime "${analyst.regime}", stop ${fx(analyst.stopLossPercent)}%, target ${fx(analyst.takeProfitPercent)}%.`,
      `Analyst reasoning: ${analyst.reasoning}`,
      `Analyst key factors: ${analyst.keyFactors.join(' | ') || 'none given'}`,
      `Market Flow Agent: ${flowSummary(flow)}`,
      '',
      'Attack the setup: contradicting indicators, chasing an extended move, low volume, range-bound/chop, funding or crowding risk, timeframe disagreement.',
      'The stop and target above are only the Analyst\'s provisional proposal: the Risk Manager sets the final stop, size and leverage after you, so do not REJECT because the proposed stop or target looks too tight or too wide. Judge the setup itself (direction, timing, structure, positioning).',
      'Verdict PASS = you found nothing material; CAUTION = real but survivable concerns; REJECT = the trade should not be taken.',
      ...(testMode ? [TEST_MODE_CRITIC_INSTRUCTION] : []),
      'Reply with exactly: {"verdict":"PASS|CAUTION|REJECT","objections":[{"issue":"specific objection","severity":"low|medium|high"}],"reasoning":"2-3 sentences"}',
    ].join('\n'),
  }
}

/**
 * The configured ceilings, plus:
 *  - real money with a fixed leverage set (execution.realFixedLeverage >= 1): leverage is exactly that, whatever the ceiling says (the
 *    account owner's decision); everything else (margin, loss, liquidation) follows from it;
 *  - testnet test mode: the leverage floor (and a ceiling to match).
 */
export function riskLimitsFor(config) {
  const limits = config.risk
  const fixed = Math.floor(Number(config.execution?.realFixedLeverage))
  if (config.execution?.mode === 'real' && fixed >= 1) {
    return { ...limits, minLeverage: fixed, maxLeverage: fixed, fixedLeverage: fixed }
  }
  if (config.scan?.testMode !== true || config.execution?.mode !== 'testnet') return limits
  return {
    ...limits,
    minLeverage: AI_TRADING_TEST_MODE_MIN_LEVERAGE,
    maxLeverage: Math.max(limits.maxLeverage, AI_TRADING_TEST_MODE_MIN_LEVERAGE),
  }
}

/** With a fixed leverage, the numbers that follow from it (position, margin, loss at the Analyst's stop, liquidation), so the Risk Manager plans around them. */
function fixedLeverageLines({ limits, constraints, baseline, analyst }) {
  const leverage = limits.fixedLeverage
  if (!(leverage >= 1)) return []
  const lines = [
    `- Leverage is FIXED at ${leverage}x for this wallet (the account owner's setting): the code uses exactly ${leverage}x, so return leverage ${leverage}. Isolated liquidation is about ${fx(100 / leverage, 1)}% from entry, so any stop must stay inside ~${fx((100 / leverage) * 0.9, 1)}%.`,
  ]
  const cap = constraints?.marginCapUsdt
  if (cap > 0) {
    const largest = cap * leverage
    lines.push(`- With up to ${fx(cap)} USDT of margin the largest position is ${fx(largest)} USDT (margin x ${leverage}); the position actually opened is the smaller of that and the size your riskPercent and stop imply.`)
    const plan = baseline?.plan
    if (plan) {
      const position = Math.min(largest, plan.notionalUsdt)
      const loss = position * (analyst.stopLossPercent / 100)
      const wallet = Number(constraints.availableUsdt)
      lines.push(`- At the Analyst's ${fx(analyst.stopLossPercent)}% stop, a position of about ${fx(position)} USDT (${fx(position / leverage)} USDT margin) would lose about ${fx(loss)} USDT if the stop is hit${wallet > 0 ? ` (${fx((loss / wallet) * 100, 1)}% of the wallet's ${fx(wallet)} USDT)` : ''} and gain about ${fx(position * (analyst.takeProfitPercent / 100))} USDT at its ${fx(analyst.takeProfitPercent)}% target, before fees. Choose your own stop and riskPercent knowing this.`)
    }
  }
  return lines
}

/** The wallet's balance and open AI positions, so the Risk Manager can weigh portfolio exposure (empty when unknown). */
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
    `- If your sized position is below that minimum, the code raises leverage to reach it: only as far as needed, up to the ${limits.maxLeverage}x ceiling, never beyond the position you sized, and only while your stop stays safely inside the liquidation distance. If that is impossible the trade is vetoed. Choose riskPercent, stop and leverage knowing the position has to clear the minimum.`,
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

function riskPrompts({ snapshot, analyst, flow, backtest, critic, limits, testMode = false, constraints = null, flowMetrics = null }) {
  const atrFloorPct = limits.minStopAtrMultiple * snapshot.atrPct
  const baseline = runRiskManager({
    side: analyst.action,
    price: snapshot.price,
    atrPct: snapshot.atrPct,
    stopLossPct: analyst.stopLossPercent,
    takeProfitPct: analyst.takeProfitPercent,
    limits,
  })
  return {
    // The role text is the project owner's Risk Manager prompt (risk-manager-prompt.js); the notes after it say how this pipeline uses the answer.
    systemPrompt: `${testMode ? `${TEST_MODE_RISK_PREAMBLE}\n\n` : ''}${RISK_MANAGER_SYSTEM_PROMPT.trim()}\n\n${riskManagerPipelineNotes({ testMode, fixedLeverage: limits.fixedLeverage })}`,
    userPrompt: [
      describeMarket(snapshot),
      '',
      `Analyst proposal: ${analyst.action} at ${analyst.confidence}% confidence, stop ${fx(analyst.stopLossPercent)}%, target ${fx(analyst.takeProfitPercent)}%. ${analyst.reasoning}`,
      `Market Flow Agent: ${flowSummary(flow)}`,
      backtestLine(backtest),
      `Critic: ${critic.verdict}. ${critic.objections.map((item) => `[${item.severity}] ${item.issue}`).join(' ') || 'No objections.'}`,
      '',
      'Fixed ceilings (enforced in code; the choice within them is yours):',
      `- Account equity ${limits.accountEquityUsdt} USDT; risk per trade at most ${limits.riskPerTradePct}% of equity`,
      limits.fixedLeverage
        ? `- Leverage is fixed at ${limits.fixedLeverage}x (the account owner's setting; the code uses exactly that)`
        : limits.minLeverage > 1
          ? `- Leverage at least ${limits.minLeverage}x (test mode) and at most ${limits.maxLeverage}x`
          : `- Leverage at most ${limits.maxLeverage}x`,
      `- Stop distance between ${fx(atrFloorPct)}% (${limits.minStopAtrMultiple}x the current ATR of ${fx(snapshot.atrPct, 3)}%) and ${limits.maxStopLossPct}%`,
      `- Reward:risk at least ${limits.minRewardRisk}`,
      ...fixedLeverageLines({ limits, constraints, baseline, analyst }),
      ...constraintLines({ constraints, baseline, limits, symbol: snapshot.symbol }),
      `For reference, the plain rule-based sizing of the Analyst's numbers would be: ${baseline.approved
        ? `stop ${baseline.plan.stopLossPct}%, target ${baseline.plan.takeProfitPct}%, ${baseline.plan.leverage}x, risking ${baseline.plan.maxLossUsdt} USDT`
        : `a veto (${baseline.vetoReasons.join(' ')})`}.`,
      ...portfolioLines({ constraints }),
      ...describeRiskEvidence({ evidence: constraints?.evidence, side: analyst.action, stopPct: analyst.stopLossPercent, targetPct: analyst.takeProfitPercent, flowMetrics, maxLeverage: limits.maxLeverage }),
      '',
      'Decide APPROVE with your own stopLossPercent / takeProfitPercent (percent off the current close, placed beyond normal noise for this symbol), riskPercent (percent of equity you are willing to lose if stopped out) and leverage — or REDUCE (open it, but deliberately smaller than the setup would normally earn, when the case is real but weaker), or VETO if the trade does not deserve capital. Scale risk down for weak conviction, high volatility, a Critic CAUTION, or flow that is crowded or only weakly supportive.',
      ...(testMode ? [TEST_MODE_RISK_INSTRUCTION] : []),
      `confidence (0-100) is your final confidence that this trade should be taken; opening needs at least ${limits.minConfidence}. A VETO may omit it.`,
      'Reply with exactly: {"decision":"APPROVE|REDUCE|VETO","confidence":0-100,"stopLossPercent":number,"takeProfitPercent":number,"riskPercent":number,"leverage":number,"concerns":["short bullets"],"reasoning":"2-3 sentences"}',
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
 * Every condition that must hold for a trade to be approved. The Risk Manager's answer is the final AI judgment; the code
 * gates around it (and its clamped plan) are deterministic.
 */
export function evaluateGates({ analyst, flow, critic, risk, config }) {
  const gate = (id, label, passed, detail) => ({ id, label, passed: Boolean(passed), detail })
  const directional = analyst && analyst.action !== 'HOLD'

  return [
    gate('analyst', 'Analyst sees a directional setup', directional, analyst ? `${analyst.action} at ${analyst.confidence}% confidence.` : 'Analyst stage did not complete.'),
    gate(
      'flow',
      'Market flow does not contradict the trade',
      flow && flow.verdict !== 'AGAINST',
      flow ? `${flow.verdict}${flow.crowding ? `, crowding ${flow.crowding}` : ''}${flow.flags.length ? ` — ${flow.flags.length} flag(s)` : ''}.` : 'Market Flow stage did not run or complete.',
    ),
    gate('critic', 'Critic does not reject', critic && critic.verdict !== 'REJECT', critic ? `${critic.verdict}${critic.objections.length ? ` — ${critic.objections.length} objection(s)` : ''}.` : 'Critic stage did not complete.'),
    gate(
      'risk',
      'Risk Manager approves the entry with enough confidence',
      risk?.approved && risk.ai && risk.ai.confidence >= config.risk.minConfidence,
      risk
        ? (risk.approved
          ? `${risk.reduced ? 'Reduced' : 'Approved'} at ${risk.ai?.confidence ?? 'n/a'}% confidence (needs >= ${config.risk.minConfidence}%), ${risk.plan.leverage}x, risking ${risk.plan.maxLossUsdt} USDT.`
          : risk.vetoReasons.join(' '))
        : 'Risk stage did not run.',
    ),
  ]
}

// --------------------------------------------------------------- orchestrator

/**
 * @param {object} args
 * @param {string} args.symbol
 * @param {object} args.config       normalized AI Trading config (agent assignments + fixed risk ceilings)
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
    price: null,
    config: { agents: config.agents, risk: config.risk },
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

  // 1. Market Analyst
  const analystStage = await runLlmStage({
    id: 'analyst',
    agentConfig: config.agents.analyst,
    callAgent,
    prompts: analystPrompts(snapshot, config.scan?.testMode === true),
    parse: parseAnalystOutput,
  })
  const analyst = analystStage.output
  if (analyst) analystStage.summary = `${analyst.action} · ${analyst.confidence}% · ${analyst.regime}`
  run.stages.push(analystStage)

  if (!analyst) {
    run.stages.push(...['flow', 'critic', 'risk'].map((id) => skipped(id, 'Market Analyst did not return a usable call.')))
    return hold(`Market Analyst failed: ${analystStage.error}`)
  }
  if (analyst.action === 'HOLD') {
    run.stages.push(...['flow', 'critic', 'risk'].map((id) => skipped(id, 'Market Analyst returned HOLD — nothing to vet.')))
    return hold(analyst.reasoning || 'Market Analyst returned HOLD.', evaluateGates({ analyst, config }))
  }

  // Background context for the Risk Manager; not a stage, not a gate.
  const backtest = lookupQuantEdge(backtestStats, {
    symbol,
    side: analyst.action,
    stopLossPct: analyst.stopLossPercent,
    takeProfitPct: analyst.takeProfitPercent,
  })

  // The LLM stages after a blocked gate cost money for nothing, so they are skipped rather than consulted.
  const skipRest = (blockers, ids, gates) => {
    for (const id of ids) {
      run.stages.push({ ...baseStage(id), status: 'skipped', summary: 'Not consulted — a gate already blocked this trade.' })
    }
    return hold(`Blocked before the ${AGENT_BY_ID[ids[0]].name} — failed: ${blockers.map((item) => item.label).join('; ')}.`, gates)
  }

  // 2. Market Flow Agent (LLM over derivatives positioning and order flow)
  const flowStarted = Date.now()
  let flowStage
  let flowData = null
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
      prompts: flowPrompts(snapshot, analyst, flowData.metrics),
      parse: parseFlowOutput,
    })
    // Keep the evidence next to the verdict so the report is auditable.
    if (flowStage.output) flowStage.output = { ...flowStage.output, metrics: flowData.metrics, sources: flowData.sources }
  }
  const flow = flowStage.output
  if (flow) flowStage.summary = `${flow.verdict}${flow.crowding ? ` · crowding ${flow.crowding}` : ''} · ${flow.flags.length} flag(s)`
  run.stages.push(flowStage)

  const flowGates = evaluateGates({ analyst, flow, critic: null, risk: null, config })
  const flowBlockers = flowGates.filter((item) => ['analyst', 'flow'].includes(item.id) && !item.passed)
  if (flowBlockers.length) return skipRest(flowBlockers, ['critic', 'risk'], flowGates)

  // 3. Critic
  const criticStage = await runLlmStage({
    id: 'critic',
    agentConfig: config.agents.critic,
    callAgent,
    prompts: criticPrompts(snapshot, analyst, flow, config.scan?.testMode === true),
    parse: parseCriticOutput,
  })
  const critic = criticStage.output
  if (critic) criticStage.summary = `${critic.verdict} · ${critic.objections.length} objection(s)`
  run.stages.push(criticStage)

  const earlyBlockers = evaluateGates({ analyst, flow, critic, risk: null, config })
    .filter((item) => ['analyst', 'flow', 'critic'].includes(item.id) && !item.passed)
  if (earlyBlockers.length) return skipRest(earlyBlockers, ['risk'], evaluateGates({ analyst, flow, critic, risk: null, config }))

  // 4. Risk Manager (LLM proposes; code clamps to the configured limits)
  const riskLimits = riskLimitsFor(config)
  const riskStage = await runLlmStage({
    id: 'risk',
    agentConfig: config.agents.risk,
    callAgent,
    prompts: riskPrompts({ snapshot, analyst, flow, backtest, critic, limits: riskLimits, testMode: config.scan?.testMode === true, constraints, flowMetrics: flowData?.metrics }),
    parse: parseRiskProposal,
  })
  const riskProposal = riskStage.output
  const risk = riskProposal
    ? reviewRiskProposal({ proposal: riskProposal, side: analyst.action, price: snapshot.price, atrPct: snapshot.atrPct, limits: riskLimits, constraints })
    // No usable Risk Manager answer is a veto: sizing must never fall back to "unchecked".
    : { approved: false, vetoReasons: [`Risk Manager unavailable: ${riskStage.error}`], adjustments: [], plan: null, limits: riskLimits, ai: null }
  risk.backtest = backtest
  riskStage.output = risk
  riskStage.summary = riskProposal
    ? (risk.approved ? `Approved · ${risk.plan.leverage}x · risk ${risk.plan.maxLossUsdt} USDT` : `Veto · ${risk.vetoReasons[0]}`)
    : riskStage.summary
  run.stages.push(riskStage)

  // The Risk Manager is the final entry approver: every gate (including its own confidence) decides the verdict.
  const gates = evaluateGates({ analyst, flow, critic, risk, config })
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
