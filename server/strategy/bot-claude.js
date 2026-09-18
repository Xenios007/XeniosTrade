// Bot 11 "Bot Claude" — the first of a planned family of LLM-driven bots
// (Bot Claude, then Bot GPT / Bot Gemini / Bot Grok) meant to compare how
// different frontier models trade the same market. Unlike Bots 1-10, there
// is no hand-coded technical rule set here: every decision comes from a
// live call to the Anthropic Claude API.
//
// Design constraints that shape this file:
//  - An LLM call is async network I/O with real per-call cost. The rest of
//    the scan/dispatch pipeline (buildSignalAnalysisSnapshot -> the
//    BOT5TO8_BUILDERS lookup) is synchronous by design and is called from
//    many places, some of them hot paths. Rather than making that whole
//    chain async, this module keeps a small in-memory (+ on-disk) decision
//    cache: `refreshBotClaudeDecisions()` is the only async entry point,
//    called once per wallet scan cycle (every 5 minutes, matching the
//    existing scheduled auto-trader) from mock-trading-server.js.
//    `buildBotClaudeSignalSnapshot()` — the function actually wired into
//    BOT5TO8_BUILDERS — stays synchronous and only ever reads that cache.
//  - Decisions are only ever refreshed once per symbol per closed 5M candle,
//    so a manual "Scan now" click can't multiply the live API spend.
//  - Claude is asked for a direction, a confidence score, and stop/target as
//    PERCENTAGES off the current close — never an absolute price — so a
//    hallucinated price level can't become a wildly wrong stop or target.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { indicatorBundle, notReady, sizeAndShape } from './shared-signals.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'bot-claude')
const DECISIONS_FILE = path.join(DATA_DIR, 'decisions.json')

// Only trade a decision Claude itself is reasonably confident about.
const MIN_CONFIDENCE = 60
const MIN_ENTRY_BARS = 90

// Raw JSON Schema (rather than a zod helper) to sidestep a zod-version
// dependency for one small object — matches the style already used by the
// existing OpenAI dashboard-trade-review structured-output call in
// mock-trading-server.js.
const TRADE_DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['LONG', 'SHORT', 'WAIT'] },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: '0-100. How confident you are in this specific call, not a general optimism score.',
    },
    stopLossPercent: {
      type: 'number',
      minimum: 0.1,
      maximum: 5,
      description: 'Stop-loss distance from the current close, as a percent. Always positive, always set even for WAIT.',
    },
    takeProfitPercent: {
      type: 'number',
      minimum: 0.1,
      maximum: 10,
      description: 'Take-profit distance from the current close, as a percent. Always positive, always set even for WAIT.',
    },
    reasoning: {
      type: 'string',
      description: '2-4 sentences on what drove this call. Be specific about which features mattered.',
    },
  },
  required: ['action', 'confidence', 'stopLossPercent', 'takeProfitPercent', 'reasoning'],
}

function parseTradeDecision(content) {
  const parsed = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Trade decision was not a JSON object.')
  }
  if (!['LONG', 'SHORT', 'WAIT'].includes(parsed.action)) {
    throw new Error(`Trade decision had an invalid action: ${parsed.action}`)
  }
  return parsed
}

const TRADE_DECISION_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: TRADE_DECISION_JSON_SCHEMA,
  parse: parseTradeDecision,
}

let anthropicClient = null
let missingApiKeyWarned = false

function getClient() {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!apiKey) {
    if (!missingApiKeyWarned) {
      missingApiKeyWarned = true
      console.warn('[bot-claude] ANTHROPIC_API_KEY is not set — Bot Claude will stay in "watching" state.')
    }
    return null
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey })
  }
  return anthropicClient
}

function getModelId() {
  return String(
    process.env.ANTHROPIC_BOT_CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  ).trim()
}

// symbol -> { action, confidence, stopLossPercent, takeProfitPercent, reasoning,
//             price, candleCloseTime, model, generatedAt }
const decisionCache = new Map()
let cacheLoaded = false
let cacheLoadPromise = null

async function ensureCacheLoaded() {
  if (cacheLoaded) return
  if (!cacheLoadPromise) {
    cacheLoadPromise = fs.readFile(DECISIONS_FILE, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          for (const [symbol, decision] of Object.entries(parsed)) {
            if (decision && typeof decision === 'object') {
              decisionCache.set(symbol, decision)
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        cacheLoaded = true
      })
  }
  await cacheLoadPromise
}

async function persistCache() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const snapshot = Object.fromEntries(decisionCache.entries())
    await fs.writeFile(DECISIONS_FILE, JSON.stringify(snapshot, null, 2), 'utf8')
  } catch (error) {
    console.warn('[bot-claude] Failed to persist decision cache:', error instanceof Error ? error.message : error)
  }
}

function buildPrompt({ symbol, b, marketContext, recentCloses }) {
  const funding = Number.isFinite(Number(marketContext?.fundingRate)) ? Number(marketContext.fundingRate) : null
  const lines = [
    `Symbol: ${symbol} (USDT-margined perpetual futures)`,
    `Current close: ${b.price}`,
    '',
    'Multi-timeframe feature snapshot (all from closed candles only):',
    `- Regime (1H/4H classifier): ${b.regime}, trend score ${b.trendScore.toFixed(3)}`,
    `- 5M RSI14: ${b.rsi.toFixed(1)} (slope ${b.rsiSlope.toFixed(3)})`,
    `- 5M ATR14: ${b.atr.toFixed(6)} (${b.atrExpanding ? 'expanding' : b.atrCompressed ? 'compressed' : 'steady'})`,
    `- Z-score vs 20-bar mean: ${b.zscore.toFixed(2)}, ATR-normalised stretch: ${b.atrStretch.toFixed(2)}`,
    `- Bollinger(20,2) width: ${b.bb.width.toFixed(4)}, position in band: ${b.bb.position.toFixed(2)}`,
    `- VWAP distance: ${(b.vwapDist * 100).toFixed(3)}%`,
    `- EMA20 distance: ${(b.emaDist * 100).toFixed(3)}%, 1H EMA20-EMA50 gap: ${(b.biasTrendGap * 100).toFixed(3)}%`,
    `- Relative volume (vs 20-bar mean): ${b.relVol.toFixed(2)}x`,
    `- 40-bar range position: ${b.rangePos.toFixed(2)} (0=low, 1=high), range width ${(b.rangeBandPct * 100).toFixed(2)}%`,
    `- 1H ADX14: ${b.adx1h.toFixed(1)}`,
    `- Latest closed 5M candle: body/range ${b.bodyRange.toFixed(2)}, lower wick ${b.lowerWick.toFixed(2)}, upper wick ${b.upperWick.toFixed(2)}, bull reclaim ${b.bullReclaim}, bear reject ${b.bearReject}`,
    `- Funding rate: ${funding == null ? 'unavailable for this period' : `${(funding * 100).toFixed(4)}%`}`,
    `- Last ${recentCloses.length} closed 5M closes (oldest to newest): ${recentCloses.map((v) => v.toFixed(6)).join(', ')}`,
    '',
    'Decide LONG, SHORT, or WAIT for the NEXT 5M candle on this symbol.',
    'Only pick LONG or SHORT when the snapshot gives you a genuine edge — WAIT is a fully valid, often correct answer.',
    'Set stopLossPercent and takeProfitPercent as sane percentages off the current close for THIS symbol\'s volatility (use the ATR/range figures above as a sanity check); still provide both even when you choose WAIT.',
    'This trades real (testnet, no real money) capital on a small, fixed risk budget — be honest about your confidence rather than optimistic.',
  ]
  return lines.join('\n')
}

async function requestDecision({ symbol, b, marketContext, recentCloses }) {
  const client = getClient()
  if (!client) return null

  const prompt = buildPrompt({ symbol, b, marketContext, recentCloses })
  const response = await client.beta.messages.parse({
    model: getModelId(),
    max_tokens: 1024,
    system: 'You are one of several frontier-model trading bots (alongside GPT, Gemini, and Grok variants) whose live decisions are being compared head-to-head on identical market data. Be rigorous and skeptical rather than eager to trade — a string of WAIT calls is a good outcome if the setup is not genuinely there. Respond with the trade decision JSON only.',
    messages: [{ role: 'user', content: prompt }],
    output_format: TRADE_DECISION_OUTPUT_FORMAT,
  })

  if (!response.parsed) {
    throw new Error('Claude returned an unparseable trade decision.')
  }

  return response.parsed
}

function isDecisionFresh(decision, candleCloseTime) {
  return Boolean(decision) && Number(decision.candleCloseTime) === Number(candleCloseTime)
}

// Called once per wallet scan cycle (see mock-trading-server.js), BEFORE the
// synchronous per-symbol dispatch runs. Only calls the live API for symbols
// whose cached decision is stale relative to the latest closed 5M candle.
export async function refreshBotClaudeDecisions({ symbols = [], getSymbolInputs } = {}) {
  if (!getClient()) return
  await ensureCacheLoaded()

  const staleSymbols = []
  const inputsBySymbol = {}

  for (const symbol of symbols) {
    try {
      const marketInputs = await getSymbolInputs(symbol)
      inputsBySymbol[symbol] = marketInputs
      const closedEntryTimeframe = marketInputs?.entry || []
      const latestEntry = closedEntryTimeframe.at(-1)
      if (!latestEntry) continue
      const candleCloseTime = Number(latestEntry.closeTime ?? latestEntry.openTime ?? 0)
      const cached = decisionCache.get(symbol)
      if (!isDecisionFresh(cached, candleCloseTime)) {
        staleSymbols.push(symbol)
      }
    } catch {
      // Market data fetch failed; leave the existing cached decision (if any) in place.
    }
  }

  if (staleSymbols.length === 0) return

  let cacheChanged = false
  await Promise.allSettled(staleSymbols.map(async (symbol) => {
    const marketInputs = inputsBySymbol[symbol]
    const entry = marketInputs?.entry || []
    const bias = marketInputs?.bias || []
    if (entry.length < MIN_ENTRY_BARS || bias.length < 40) return

    const regime4h = marketInputs?.marketContext?.regime4hCandles || null
    const b = indicatorBundle(entry, bias, regime4h)
    const latestEntry = entry.at(-1)
    const candleCloseTime = Number(latestEntry.closeTime ?? latestEntry.openTime ?? 0)
    const recentCloses = entry.slice(-12).map((c) => c.close)

    try {
      const decision = await requestDecision({
        symbol,
        b,
        marketContext: marketInputs?.marketContext || {},
        recentCloses,
      })
      if (!decision) return

      decisionCache.set(symbol, {
        ...decision,
        price: b.price,
        candleCloseTime,
        model: getModelId(),
        generatedAt: Date.now(),
      })
      cacheChanged = true
    } catch (error) {
      console.warn(`[bot-claude] Decision request failed for ${symbol}:`, error instanceof Error ? error.message : error)
    }
  }))

  if (cacheChanged) {
    await persistCache()
  }
}

// Synchronous — reads only from the cache populated by refreshBotClaudeDecisions
// above. Matches the same snapshot shape every other bot builder returns.
export function buildBotClaudeSignalSnapshot({ symbol, signalModel, effectiveStrategy, closedEntryTimeframe = [] }) {
  const latestEntry = closedEntryTimeframe.at(-1)
  const price = latestEntry?.close ?? null

  if (!getClientConfigured()) {
    return notReady(symbol, signalModel, effectiveStrategy, price, 'Bot Claude requires ANTHROPIC_API_KEY to be configured on the server.')
  }

  const candleCloseTime = latestEntry ? Number(latestEntry.closeTime ?? latestEntry.openTime ?? 0) : null
  const decision = decisionCache.get(symbol)

  if (!decision || !candleCloseTime) {
    return notReady(symbol, signalModel, effectiveStrategy, price, `Bot Claude is waiting for its next live Claude API decision on ${symbol}.`)
  }

  if (!isDecisionFresh(decision, candleCloseTime)) {
    return notReady(symbol, signalModel, effectiveStrategy, price, `Bot Claude's cached decision for ${symbol} is stale; waiting for the next scan to refresh it.`)
  }

  if (decision.action === 'WAIT' || !Number.isFinite(Number(decision.confidence)) || Number(decision.confidence) < MIN_CONFIDENCE) {
    return notReady(
      symbol,
      signalModel,
      effectiveStrategy,
      price,
      `Bot Claude: ${decision.action} at ${Math.round(Number(decision.confidence) || 0)}% confidence (needs >= ${MIN_CONFIDENCE}% to trade). ${decision.reasoning || ''}`.trim(),
    )
  }

  const direction = decision.action === 'LONG' ? 'LONG' : 'SHORT'
  const resolvedPrice = Number(decision.price) > 0 ? Number(decision.price) : price
  if (!resolvedPrice) {
    return notReady(symbol, signalModel, effectiveStrategy, price, 'Bot Claude: no valid price to size the decision against.')
  }

  const stopLossPercent = Math.max(Number(decision.stopLossPercent) || 0, 0.1)
  const takeProfitPercent = Math.max(Number(decision.takeProfitPercent) || 0, 0.1)
  const stopLoss = direction === 'LONG'
    ? resolvedPrice * (1 - stopLossPercent / 100)
    : resolvedPrice * (1 + stopLossPercent / 100)
  const takeProfit = direction === 'LONG'
    ? resolvedPrice * (1 + takeProfitPercent / 100)
    : resolvedPrice * (1 - takeProfitPercent / 100)

  const confidence = Math.round(Number(decision.confidence))
  const summary = `Bot Claude ${direction.toLowerCase()} (${confidence}% confidence, ${decision.model || getModelId()}): ${decision.reasoning || 'No reasoning returned.'}`

  return sizeAndShape({
    symbol,
    signalModel,
    effectiveStrategy,
    direction,
    entryPrice: resolvedPrice,
    stopLoss,
    takeProfit,
    score: confidence,
    maxScore: 100,
    summary,
    strategyFamily: 'llm-claude',
    setupFamily: direction === 'LONG' ? 'Claude long call' : 'Claude short call',
    aiFeatures: {
      confidence,
      stopLossPercent,
      takeProfitPercent,
      model: decision.model || getModelId(),
    },
  })
}

function getClientConfigured() {
  return Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim())
}
