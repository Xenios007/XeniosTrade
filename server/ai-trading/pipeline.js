// AI Trading pipeline — five agents, one verdict:
//
//   Market data -> Market Analyst -> Market Flow Agent -> Critic -> Risk Manager -> Decision Agent -> Trade / No Trade
//
// This is advisory only. Nothing here talks to an exchange, a wallet or the
// auto-trade loop; the result is a report. Design rules:
//
//  - All five agents call an LLM. The Market Flow Agent reads derivatives
//    positioning and order flow (flow-data.js) that the Analyst cannot see.
//    Backtest statistics are background context for the Risk Manager and
//    Decision Agent only — no longer an agent and no longer a gate.
//  - Fail closed. A stage that errors or has no provider yields HOLD, never a trade.
//  - The Decision Agent can confirm or downgrade, never override. Approval
//    requires every deterministic gate (see evaluateGates) to pass first, and
//    the LLM is not even asked when a gate has already blocked the trade.
//  - The Risk Manager (an LLM) owns stop / size / leverage; the Analyst only
//    proposes stop and target percentages. Whatever the Risk Manager answers is
//    then clamped by deterministic code to the fixed risk ceilings
//    (reviewRiskProposal / runRiskManager), so the model can be stricter than
//    the limits but never looser.

import { AI_TRADING_AGENTS, AI_TRADING_TEST_MODE_MIN_LEVERAGE } from '../../src/lib/aiTrading.js'
import { indicatorBundle } from '../strategy/shared-signals.js'
import { describeFlow } from './flow-data.js'
import { lookupQuantEdge } from './quant-stats.js'

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

function describeMarket(snapshot) {
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

export function parseDecisionOutput(json) {
  const decision = String(json?.decision || '').toUpperCase().replace('WAIT', 'HOLD')
  if (!['LONG', 'SHORT', 'HOLD'].includes(decision)) throw new Error(`Decision Agent returned an invalid decision: ${json?.decision}`)
  return { decision, confidence: requireConfidence(json?.confidence, 'Decision Agent'), reasoning: asText(json?.reasoning) }
}

export function parseRiskProposal(json) {
  const decision = String(json?.decision || '').toUpperCase().replace('REJECT', 'VETO')
  if (!['APPROVE', 'VETO'].includes(decision)) throw new Error(`Risk Manager returned an invalid decision: ${json?.decision}`)
  const number = (value) => (value == null || value === '' ? Number.NaN : Number(value))
  const proposal = {
    decision,
    stopLossPercent: number(json?.stopLossPercent),
    takeProfitPercent: number(json?.takeProfitPercent),
    riskPercent: number(json?.riskPercent),
    leverage: number(json?.leverage),
    concerns: asTextList(json?.concerns),
    reasoning: asText(json?.reasoning),
  }
  if (decision === 'APPROVE') {
    for (const key of ['stopLossPercent', 'takeProfitPercent', 'riskPercent', 'leverage']) {
      if (!(proposal[key] > 0)) throw new Error(`Risk Manager approved the trade without a positive ${key}.`)
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
 * Turns the AI Risk Manager's answer into the final risk result. A VETO stands as-is. An APPROVE is
 * re-run through runRiskManager with the model's numbers, capped at the configured limits: the model
 * may ask for less risk, lower leverage, a wider or tighter stop, but anything beyond a limit is clamped
 * (and noted) and a plan that still breaks a limit is vetoed.
 */
export function reviewRiskProposal({ proposal, side, price, atrPct, limits }) {
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

  return { ...result, adjustments: [...notes, ...result.adjustments], limits, ai: proposal }
}

// ------------------------------------------------------------------- prompts

const SYSTEM_PREAMBLE = 'You are one agent in a five-stage crypto perpetual-futures trade-vetting pipeline (Market Analyst, Market Flow, Critic, Risk Manager, Decision). Be rigorous and skeptical: HOLD / rejecting is a good outcome when the edge is not clear. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'

// Testnet pipeline-check wording (config.scan.testMode). Only the Analyst changes; Flow, Critic, Risk and Decision keep their
// full skepticism and the code ceilings still cap every number, so this only lets a modest lean reach them.
const TEST_MODE_PREAMBLE = 'You are one agent in a five-stage crypto perpetual-futures trade-vetting pipeline (Market Analyst, Market Flow, Critic, Risk Manager, Decision). TEST MODE (testnet, fake money): the goal right now is to exercise the whole pipeline, so do NOT default to HOLD. Later stages will still vet and can reject the trade. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
// Test mode also relaxes the Critic, or its ordinary objections (late entry, modest volume) block every run before the Risk
// Manager and Decision Agent are ever reached. It still lists every real objection; REJECT is kept for a clearly bad trade.
const TEST_MODE_CRITIC_PREAMBLE = 'You are one agent in a five-stage crypto perpetual-futures trade-vetting pipeline (Market Analyst, Market Flow, Critic, Risk Manager, Decision). TEST MODE (testnet, fake money): this run exists to exercise the whole pipeline. The Risk Manager and Decision Agent still vet the trade after you. No real orders are placed by you. Respond with a single JSON object only, no prose outside it.'
const TEST_MODE_CRITIC_INSTRUCTION = 'TEST MODE: still list every real objection with an honest severity, but use REJECT only for a serious flaw that makes the trade clearly bad (for example it fights strong trend or flow evidence, or the data is broken). Ordinary weaknesses such as a late entry, modest volume or a stretched but plausible range position are CAUTION.'
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

function flowSummary(flow) {
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

/** The configured ceilings, plus the leverage floor (and a ceiling to match) while testnet test mode is on. */
export function riskLimitsFor(config) {
  const limits = config.risk
  if (config.scan?.testMode !== true || config.execution?.mode !== 'testnet') return limits
  return {
    ...limits,
    minLeverage: AI_TRADING_TEST_MODE_MIN_LEVERAGE,
    maxLeverage: Math.max(limits.maxLeverage, AI_TRADING_TEST_MODE_MIN_LEVERAGE),
  }
}

function riskPrompts({ snapshot, analyst, flow, backtest, critic, limits }) {
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
    systemPrompt: `${SYSTEM_PREAMBLE} You are the Risk Manager. Your job is to protect capital: size the trade, set its stop and target, or veto it. You alone decide the risk for this trade — nobody sets it by hand. Fixed ceilings are enforced in code after you answer (numbers beyond them are clamped, and a plan that still breaks them is rejected), so choose the size that the setup deserves inside them and prefer less risk when unsure.`,
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
      limits.minLeverage > 1
        ? `- Leverage at least ${limits.minLeverage}x (test mode) and at most ${limits.maxLeverage}x`
        : `- Leverage at most ${limits.maxLeverage}x`,
      `- Stop distance between ${fx(atrFloorPct)}% (${limits.minStopAtrMultiple}x the current ATR of ${fx(snapshot.atrPct, 3)}%) and ${limits.maxStopLossPct}%`,
      `- Reward:risk at least ${limits.minRewardRisk}`,
      `For reference, the plain rule-based sizing of the Analyst's numbers would be: ${baseline.approved
        ? `stop ${baseline.plan.stopLossPct}%, target ${baseline.plan.takeProfitPct}%, ${baseline.plan.leverage}x, risking ${baseline.plan.maxLossUsdt} USDT`
        : `a veto (${baseline.vetoReasons.join(' ')})`}.`,
      '',
      'Decide APPROVE with your own stopLossPercent / takeProfitPercent (percent off the current close, placed beyond normal noise for this symbol), riskPercent (percent of equity you are willing to lose if stopped out) and leverage — or VETO if the trade does not deserve capital. Scale risk down for weak conviction, high volatility, a Critic CAUTION, or flow that is crowded or only weakly supportive.',
      'Reply with exactly: {"decision":"APPROVE|VETO","stopLossPercent":number,"takeProfitPercent":number,"riskPercent":number,"leverage":number,"concerns":["short bullets"],"reasoning":"2-3 sentences"}',
    ].join('\n'),
  }
}

function decisionPrompts({ snapshot, analyst, flow, backtest, critic, risk, minConfidence }) {
  return {
    systemPrompt: `${SYSTEM_PREAMBLE} You are the Decision Agent. You may confirm the Analyst's direction or downgrade to HOLD; you can never choose the opposite direction and you cannot override the Risk Manager.`,
    userPrompt: [
      `Symbol ${snapshot.symbol}, current close ${snapshot.price}.`,
      `Market Analyst: ${analyst.action}, ${analyst.confidence}% confidence. ${analyst.reasoning}`,
      `Market Flow Agent: ${flowSummary(flow)}`,
      backtestLine(backtest),
      `Critic: ${critic.verdict}. ${critic.objections.map((item) => `[${item.severity}] ${item.issue}`).join(' ') || 'No objections raised.'} ${critic.reasoning}`,
      `Risk Manager: approved. Stop ${risk.plan.stopLossPct}%, target ${risk.plan.takeProfitPct}% (R:R ${risk.plan.rewardRisk}), ${risk.plan.leverage}x, risking ${risk.plan.maxLossUsdt} USDT (${risk.plan.riskPctOfEquity}% of equity). ${risk.ai?.reasoning || ''}`,
      '',
      `Weigh all four. Approve (LONG/SHORT matching the Analyst) only if the combined case is strong; otherwise HOLD. Approval needs confidence of at least ${minConfidence}.`,
      'Reply with exactly: {"decision":"LONG|SHORT|HOLD","confidence":0-100,"reasoning":"2-4 sentences weighing the agents"}',
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
 * Every condition that must hold for a trade to be approved. The Decision
 * Agent's opinion is one gate among several, and the only non-deterministic one.
 */
export function evaluateGates({ analyst, flow, critic, risk, decision, config }) {
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
    gate('risk', 'Risk Manager approves sizing', risk?.approved, risk ? (risk.approved ? `${risk.plan.leverage}x, risking ${risk.plan.maxLossUsdt} USDT.` : risk.vetoReasons.join(' ')) : 'Risk stage did not run.'),
    gate('decision', 'Decision Agent confirms with enough confidence', decision && decision.decision === analyst?.action && decision.confidence >= config.risk.minConfidence, decision ? `${decision.decision} at ${decision.confidence}% (needs the Analyst's side and >= ${config.risk.minConfidence}%).` : 'Decision Agent did not run.'),
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
 * @param {object|null} args.backtestStats  aggregated backtest table (loadQuantStats) — background context only
 */
export async function runAiTradingPipeline({ symbol, config, getMarketInputs, getFlowData, callAgent, backtestStats, now = Date.now }) {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    run.stages.push(...['analyst', 'flow', 'critic', 'risk', 'decision'].map((id) => skipped(id, 'Market data unavailable.')))
    return hold(`Market data unavailable: ${message}`)
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
    run.stages.push(...['flow', 'critic', 'risk', 'decision'].map((id) => skipped(id, 'Market Analyst did not return a usable call.')))
    return hold(`Market Analyst failed: ${analystStage.error}`)
  }
  if (analyst.action === 'HOLD') {
    run.stages.push(...['flow', 'critic', 'risk', 'decision'].map((id) => skipped(id, 'Market Analyst returned HOLD — nothing to vet.')))
    return hold(analyst.reasoning || 'Market Analyst returned HOLD.', evaluateGates({ analyst, config }))
  }

  // Background context for the Risk Manager and Decision Agent; not a stage, not a gate.
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

  const flowGates = evaluateGates({ analyst, flow, critic: null, risk: null, decision: null, config })
  const flowBlockers = flowGates.filter((item) => ['analyst', 'flow'].includes(item.id) && !item.passed)
  if (flowBlockers.length) return skipRest(flowBlockers, ['critic', 'risk', 'decision'], flowGates)

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

  const earlyBlockers = evaluateGates({ analyst, flow, critic, risk: null, decision: null, config })
    .filter((item) => ['analyst', 'flow', 'critic'].includes(item.id) && !item.passed)
  if (earlyBlockers.length) return skipRest(earlyBlockers, ['risk', 'decision'], evaluateGates({ analyst, flow, critic, risk: null, decision: null, config }))

  // 4. Risk Manager (LLM proposes; code clamps to the configured limits)
  const riskLimits = riskLimitsFor(config)
  const riskStage = await runLlmStage({
    id: 'risk',
    agentConfig: config.agents.risk,
    callAgent,
    prompts: riskPrompts({ snapshot, analyst, flow, backtest, critic, limits: riskLimits }),
    parse: parseRiskProposal,
  })
  const riskProposal = riskStage.output
  const risk = riskProposal
    ? reviewRiskProposal({ proposal: riskProposal, side: analyst.action, price: snapshot.price, atrPct: snapshot.atrPct, limits: riskLimits })
    // No usable Risk Manager answer is a veto: sizing must never fall back to "unchecked".
    : { approved: false, vetoReasons: [`Risk Manager unavailable: ${riskStage.error}`], adjustments: [], plan: null, limits: riskLimits, ai: null }
  risk.backtest = backtest
  riskStage.output = risk
  riskStage.summary = riskProposal
    ? (risk.approved ? `Approved · ${risk.plan.leverage}x · risk ${risk.plan.maxLossUsdt} USDT` : `Veto · ${risk.vetoReasons[0]}`)
    : riskStage.summary
  run.stages.push(riskStage)

  // 5. Decision Agent — only consulted when no gate has already blocked the trade.
  const preGates = evaluateGates({ analyst, flow, critic, risk, decision: null, config })
  const blockers = preGates.filter((item) => item.id !== 'decision' && !item.passed)
  if (blockers.length) {
    run.stages.push({ ...baseStage('decision'), status: 'skipped', summary: 'Not consulted — a gate already blocked this trade.' })
    return hold(`Blocked before the Decision Agent — failed: ${blockers.map((item) => item.label).join('; ')}.`, preGates)
  }

  const decisionStage = await runLlmStage({
    id: 'decision',
    agentConfig: config.agents.decision,
    callAgent,
    prompts: decisionPrompts({ snapshot, analyst, flow, backtest, critic, risk, minConfidence: config.risk.minConfidence }),
    parse: parseDecisionOutput,
  })
  const decision = decisionStage.output
  if (decision) decisionStage.summary = `${decision.decision} · ${decision.confidence}%`
  run.stages.push(decisionStage)

  const gates = evaluateGates({ analyst, flow, critic, risk, decision, config })
  const approved = gates.every((item) => item.passed)

  if (!approved) {
    const failed = gates.find((item) => !item.passed)
    return hold(decision?.reasoning || decisionStage.error || `Blocked: ${failed?.label}.`, gates)
  }

  return finish({
    action: analyst.action,
    approved: true,
    confidence: decision.confidence,
    reason: decision.reasoning,
    gates,
    trade: risk.plan,
  })
}
