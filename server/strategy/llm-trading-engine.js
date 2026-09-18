// Generic engine shared by every LLM-driven bot (Bot Claude, Bot GPT, Bot
// Gemini, Bot Grok, Bot OpenRouter). Each bot is a thin wrapper — see
// bot-claude.js / bot-gpt.js / bot-gemini.js / bot-grok.js / bot-openrouter.js
// — that only supplies how to call its provider; everything else (prompt
// content, caching, gating, position sizing) is identical across bots on
// purpose, so a head-to-head comparison is actually comparing the models'
// judgment on the same data, not different plumbing.
//
// Design constraints (apply to every bot built on this engine):
//  - An LLM call is async network I/O with real per-call cost. The rest of
//    the scan/dispatch pipeline (buildSignalAnalysisSnapshot -> the
//    BOT5TO8_BUILDERS lookup) is synchronous and called from hot paths, so
//    each bot keeps a small in-memory + on-disk decision cache: refreshDecisions
//    is the only async entry point, called once per wallet scan cycle (every
//    5 minutes) from mock-trading-server.js. buildSignalSnapshot stays
//    synchronous and only ever reads that cache.
//  - Decisions are only ever refreshed once per symbol per closed 5M candle.
//  - Stop/target are always PERCENTAGES off the current close, never an
//    absolute price, so a hallucinated price level can't become a wildly
//    wrong stop or target.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { indicatorBundle, notReady, sizeAndShape } from './shared-signals.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const LLM_TRADE_MIN_CONFIDENCE = 60
export const LLM_TRADE_MIN_ENTRY_BARS = 90

export const LLM_TRADE_DECISION_JSON_SCHEMA = {
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

export function parseTradeDecision(content) {
  const parsed = typeof content === 'string' ? JSON.parse(content) : content
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Trade decision was not a JSON object.')
  }
  if (!['LONG', 'SHORT', 'WAIT'].includes(parsed.action)) {
    throw new Error(`Trade decision had an invalid action: ${parsed.action}`)
  }
  if (!Number.isFinite(Number(parsed.confidence))) {
    throw new Error('Trade decision had a non-numeric confidence.')
  }
  return parsed
}

export function buildLlmTradeSystemPrompt(label) {
  return `You are ${label}, one of several frontier-model trading bots (alongside other Claude/GPT/Gemini/Grok/OpenRouter-routed variants) whose live decisions are being compared head-to-head on identical market data. Be rigorous and skeptical rather than eager to trade — a string of WAIT calls is a good outcome if the setup is not genuinely there. Respond with the trade decision JSON only.`
}

export function buildLlmTradeUserPrompt({ symbol, b, marketContext, recentCloses }) {
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
    'Respond with a single JSON object only, matching this shape exactly: {"action":"LONG|SHORT|WAIT","confidence":0-100,"stopLossPercent":number,"takeProfitPercent":number,"reasoning":"2-4 sentences"}. No prose outside the JSON.',
  ]
  return lines.join('\n')
}

function isDecisionFresh(decision, candleCloseTime) {
  return Boolean(decision) && Number(decision.candleCloseTime) === Number(candleCloseTime)
}

/**
 * @param {object} options
 * @param {string} options.id            unique slug, e.g. 'bot-claude' - used for the on-disk cache dir and log prefix.
 * @param {string} options.label         display label used in "not ready"/summary text, e.g. 'Bot Claude'.
 * @param {string} options.strategyFamily e.g. 'llm-claude'.
 * @param {() => boolean} options.isConfigured   true once the required API key (etc.) is present.
 * @param {() => string} options.resolveModelLabel  the model id actually in use, for bookkeeping/summary text.
 * @param {(args: { symbol: string, b: object, marketContext: object, recentCloses: number[], prompt: string }) => Promise<object|null>} options.requestDecision
 *   Calls the provider and returns a parsed { action, confidence, stopLossPercent, takeProfitPercent, reasoning } object, or null when not configured.
 */
export function createLlmTradingBot({
  id,
  label,
  strategyFamily,
  isConfigured,
  resolveModelLabel,
  requestDecision,
}) {
  const DATA_DIR = path.join(__dirname, '..', 'data', id)
  const DECISIONS_FILE = path.join(DATA_DIR, 'decisions.json')

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
      console.warn(`[${id}] Failed to persist decision cache:`, error instanceof Error ? error.message : error)
    }
  }

  // Called once per wallet scan cycle (see mock-trading-server.js), BEFORE the
  // synchronous per-symbol dispatch runs. Only calls the live API for symbols
  // whose cached decision is stale relative to the latest closed 5M candle.
  async function refreshDecisions({ symbols = [], getSymbolInputs } = {}) {
    if (!isConfigured()) return
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
      if (entry.length < LLM_TRADE_MIN_ENTRY_BARS || bias.length < 40) return

      const regime4h = marketInputs?.marketContext?.regime4hCandles || null
      const b = indicatorBundle(entry, bias, regime4h)
      const latestEntry = entry.at(-1)
      const candleCloseTime = Number(latestEntry.closeTime ?? latestEntry.openTime ?? 0)
      const recentCloses = entry.slice(-12).map((c) => c.close)
      const prompt = buildLlmTradeUserPrompt({ symbol, b, marketContext: marketInputs?.marketContext || {}, recentCloses })

      try {
        const decision = await requestDecision({ symbol, b, marketContext: marketInputs?.marketContext || {}, recentCloses, prompt })
        if (!decision) return

        decisionCache.set(symbol, {
          ...decision,
          price: b.price,
          candleCloseTime,
          model: resolveModelLabel(),
          generatedAt: Date.now(),
        })
        cacheChanged = true
      } catch (error) {
        console.warn(`[${id}] Decision request failed for ${symbol}:`, error instanceof Error ? error.message : error)
      }
    }))

    if (cacheChanged) {
      await persistCache()
    }
  }

  // Synchronous — reads only from the cache populated by refreshDecisions above.
  // Matches the same snapshot shape every other bot builder returns.
  function buildSignalSnapshot({ symbol, signalModel, effectiveStrategy, closedEntryTimeframe = [] }) {
    const latestEntry = closedEntryTimeframe.at(-1)
    const price = latestEntry?.close ?? null

    if (!isConfigured()) {
      return notReady(symbol, signalModel, effectiveStrategy, price, `${label} requires its API key to be configured on the server.`)
    }

    const candleCloseTime = latestEntry ? Number(latestEntry.closeTime ?? latestEntry.openTime ?? 0) : null
    const decision = decisionCache.get(symbol)

    if (!decision || !candleCloseTime) {
      return notReady(symbol, signalModel, effectiveStrategy, price, `${label} is waiting for its next live API decision on ${symbol}.`)
    }

    if (!isDecisionFresh(decision, candleCloseTime)) {
      return notReady(symbol, signalModel, effectiveStrategy, price, `${label}'s cached decision for ${symbol} is stale; waiting for the next scan to refresh it.`)
    }

    if (decision.action === 'WAIT' || !Number.isFinite(Number(decision.confidence)) || Number(decision.confidence) < LLM_TRADE_MIN_CONFIDENCE) {
      return notReady(
        symbol,
        signalModel,
        effectiveStrategy,
        price,
        `${label}: ${decision.action} at ${Math.round(Number(decision.confidence) || 0)}% confidence (needs >= ${LLM_TRADE_MIN_CONFIDENCE}% to trade). ${decision.reasoning || ''}`.trim(),
      )
    }

    const direction = decision.action === 'LONG' ? 'LONG' : 'SHORT'
    const resolvedPrice = Number(decision.price) > 0 ? Number(decision.price) : price
    if (!resolvedPrice) {
      return notReady(symbol, signalModel, effectiveStrategy, price, `${label}: no valid price to size the decision against.`)
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
    const summary = `${label} ${direction.toLowerCase()} (${confidence}% confidence, ${decision.model || resolveModelLabel()}): ${decision.reasoning || 'No reasoning returned.'}`

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
      strategyFamily,
      setupFamily: direction === 'LONG' ? `${label} long call` : `${label} short call`,
      aiFeatures: {
        confidence,
        stopLossPercent,
        takeProfitPercent,
        model: decision.model || resolveModelLabel(),
      },
    })
  }

  return { refreshDecisions, buildSignalSnapshot }
}
