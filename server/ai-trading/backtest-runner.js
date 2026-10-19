// Walks simulated time forward through historical candles, calling the REAL AI Trading pipeline (same
// runAiTradingPipeline, same strategy settings, same confidence floor / direction circuit breaker / position
// caps as live) at each closed entry-timeframe candle, exactly as the live auto-scan loop would. The only two
// things that differ from live trading: time comes from the historical data instead of the wall clock, and a
// trade's exit is decided mechanically against the stop/target (see checkExit below) instead of by the
// Position Manager agent - an LLM call per review, per open position, would multiply an already-long backtest
// many times over for a question (does the ENTRY strategy work) this already answers.
//
// Pure except for the three injected I/O seams (seriesFor, callAgent, the progress/trade callbacks), so the
// walk-forward logic itself is unit-testable with fake candles and a fake callAgent - see
// test/ai-trading-backtest-runner.test.js.

import { runAiTradingPipeline } from './pipeline.js'
import { directionCircuitBreaker } from './scan.js'
import { MAX_OPEN_POSITIONS, MAX_SAME_SIDE_OPEN_POSITIONS } from './execution.js'

/**
 * One candle's worth of exit check against an open simulated position. OHLC data alone can't say whether the
 * stop or the target was touched first when a single candle's range crosses both - the stop is assumed to win,
 * the standard conservative backtest assumption (never credits a trade with a target it might not have reached).
 */
export function checkExit(position, candle) {
  const isLong = position.side === 'BUY'
  if (isLong) {
    if (candle.low <= position.stopLoss) return { exitPrice: position.stopLoss, result: 'SL' }
    if (candle.high >= position.takeProfit) return { exitPrice: position.takeProfit, result: 'TP' }
  } else {
    if (candle.high >= position.stopLoss) return { exitPrice: position.stopLoss, result: 'SL' }
    if (candle.low <= position.takeProfit) return { exitPrice: position.takeProfit, result: 'TP' }
  }
  return null
}

/** Realized USDT P&L for a position's notional at a given exit price. */
export function positionPnl(position, exitPrice) {
  const sign = position.side === 'BUY' ? 1 : -1
  const notional = Number(position.notionalUsdt) || 0
  const entry = Number(position.entryPrice)
  if (!(entry > 0)) return 0
  return Math.round(sign * ((exitPrice - entry) / entry) * notional * 10_000) / 10_000
}

const forBreaker = (trade) => ({ side: trade.side, pnl: trade.pnl, aiTradingMode: 'backtest', closedAt: trade.closedAt })

/**
 * @param {object} args
 * @param {string[]} args.symbols
 * @param {number} args.startMs
 * @param {number} args.endMs
 * @param {number} args.stepMs  the entry timeframe's bar length (1H for swing)
 * @param {object} args.config  normalized AI Trading config (strategy/risk/execution/agents - agents should already be pointed at the backtest's chosen provider)
 * @param {Function} args.callAgent
 * @param {(symbol: string) => { atMs(nowMs: number): object }} args.seriesFor  per-symbol historical inputs, see backtest-data.js's loadBacktestSeries
 * @param {(event: object) => void} [args.onProgress]
 * @param {(trade: object) => void} [args.onTrade]
 * @param {() => boolean} [args.shouldStop]
 */
export async function runAiTradingBacktest({
  symbols, startMs, endMs, stepMs, config, callAgent, seriesFor,
  onProgress = () => {}, onTrade = () => {}, shouldStop = () => false,
}) {
  const open = new Map() // symbol -> position
  const closed = []
  const totalSteps = Math.max(1, Math.ceil((endMs - startMs) / stepMs)) * symbols.length
  let steps = 0

  for (let t = startMs; t <= endMs; t += stepMs) {
    if (shouldStop()) break
    for (const symbol of symbols) {
      steps += 1
      const inputs = seriesFor(symbol).atMs(t)
      const position = open.get(symbol)

      if (position) {
        const candle = inputs.entry.at(-1)
        if (candle && candle.closeTime > position.openedAt && candle.closeTime <= t) {
          const hit = checkExit(position, candle)
          if (hit) {
            const trade = { ...position, ...hit, closedAt: candle.closeTime, pnl: positionPnl(position, hit.exitPrice) }
            closed.push(trade)
            open.delete(symbol)
            onTrade(trade)
          }
        }
        onProgress({ steps, totalSteps, nowMs: t, symbol, phase: 'managing' })
        continue
      }

      const openList = [...open.values()]
      if (openList.length >= (MAX_OPEN_POSITIONS.testnet ?? Infinity)) {
        onProgress({ steps, totalSteps, nowMs: t, symbol, phase: 'skipped', reason: 'position cap' })
        continue
      }

      const directionBlock = directionCircuitBreaker({ trades: closed.map(forBreaker), mode: 'backtest' })

      let run
      try {
        run = await runAiTradingPipeline({
          symbol, config, now: () => t,
          getMarketInputs: async () => inputs,
          callAgent,
          directionBlock,
        })
      } catch (error) {
        onProgress({ steps, totalSteps, nowMs: t, symbol, phase: 'error', error: error instanceof Error ? error.message : String(error) })
        continue
      }

      onProgress({ steps, totalSteps, nowMs: t, symbol, phase: 'decided', outcome: run.final?.approved ? run.final.action : 'HOLD' })

      if (run.final?.approved && run.final.trade) {
        const side = run.final.action === 'LONG' ? 'BUY' : 'SELL'
        const sameSideOpen = openList.filter((item) => item.side === side).length
        if (sameSideOpen >= (MAX_SAME_SIDE_OPEN_POSITIONS.testnet ?? Infinity)) continue
        open.set(symbol, {
          symbol,
          side,
          entryPrice: run.final.trade.entryPrice,
          stopLoss: run.final.trade.stopLoss,
          takeProfit: run.final.trade.takeProfit,
          leverage: run.final.trade.leverage,
          notionalUsdt: run.final.trade.notionalUsdt,
          marginUsdt: run.final.trade.marginUsdt,
          confidence: run.final.confidence,
          openedAt: t,
          aiRunId: run.id,
        })
      }
    }
  }

  // Mark-to-last-close anything still open at the window's end, so the stats are not biased by only ever
  // counting trades that happened to finish inside the window.
  for (const [symbol, position] of open) {
    const last = seriesFor(symbol).atMs(endMs).entry.at(-1)
    if (!last) continue
    const trade = { ...position, exitPrice: last.close, result: 'END_OF_BACKTEST', closedAt: last.closeTime, pnl: positionPnl(position, last.close) }
    closed.push(trade)
    onTrade(trade)
  }

  return { trades: closed }
}
