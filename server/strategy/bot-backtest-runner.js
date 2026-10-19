// Walks historical 5-minute candles forward, calling the REAL per-bot signal check
// (analyzeSymbolStrategy, exported from mock-trading-server.js) and the REAL exit simulation
// (simulateExitPolicy, server/backtest/exit-policy.js) at every bar - the same two pure
// functions server/backtest/replay-worker.js uses for its research dataset, just without that
// tool's feature-vector / regime / train-split machinery, which this UI-triggered backtest has
// no use for. No LLM calls are involved (unlike the AI Trading backtest), so this runs in
// seconds to low minutes per symbol rather than requiring unattended multi-day runs.
//
// Pure except for the injected I/O seams (seriesFor, the bot-check function, the progress/trade
// callbacks), matching the ai-trading/backtest-runner.js shape so both are unit-testable the
// same way - see test/bot-backtest-runner.test.js.

const STRIDE_DEFAULT = 1

/**
 * @param {object} args
 * @param {string[]} args.bots  signal model ids (model-1..model-8) to backtest
 * @param {string[]} args.symbols
 * @param {(symbol: string) => { entryRows: Array, atIndex(i: number): object }} args.seriesFor  see bot-backtest-data.js's loadBotBacktestSeries
 * @param {(args: { symbol: string, botId: string, biasCandles: object[], setupCandles: object[], entryCandles: object[], marketContext: object }) => object|null} args.analyze  wraps analyzeSymbolStrategy with the strategy/settings already bound
 * @param {(args: { side: string, entryPrice: number, stopLoss: number, takeProfit: number, notional: number, isBot4: boolean, entryBarIndex: number, entryTfRaw: Array }) => object|null} args.simulateExit  wraps simulateExitPolicy
 * @param {number} [args.warmupBars]
 * @param {number} [args.stride]
 */
export async function runBotBacktest({
  bots, symbols, seriesFor, analyze, simulateExit, warmupBars = 220, stride = STRIDE_DEFAULT,
  onProgress = () => {}, onTrade = () => {}, shouldStop = () => false,
}) {
  const trades = []
  const totalSteps = symbols.length

  for (const symbol of symbols) {
    if (shouldStop()) break
    const series = seriesFor(symbol)
    const entryRows = series.entryRows
    // symbol+bot -> the raw-array index a new signal may next be considered at (busy until its
    // simulated position closes) - mirrors replay-worker.js's openUntil[botId].
    const openUntil = {}
    let sinceYield = 0

    for (let i = warmupBars; i < entryRows.length - 1; i += stride) {
      if (shouldStop()) break
      if ((sinceYield += 1) >= 2000) {
        sinceYield = 0
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve))
        onProgress({ symbol, bar: i, totalBars: entryRows.length, trades: trades.length })
      }

      const { entryCandles, setupCandles, biasCandles, marketContext } = series.atIndex(i)
      if (entryCandles.length < 2 || setupCandles.length < 10 || biasCandles.length < 10) continue

      for (const botId of bots) {
        if (openUntil[botId] !== undefined && i < openUntil[botId]) continue

        let analysis
        try {
          analysis = analyze({ symbol, botId, biasCandles, setupCandles, entryCandles, marketContext })
        } catch { analysis = null }
        if (!analysis || !analysis.entryPrice || !analysis.stopLoss || !analysis.takeProfit) continue

        const side = analysis.side === 'SELL' || analysis.direction === 'SHORT' ? 'SELL' : 'BUY'
        const entryPrice = Number(analysis.entryPrice)
        const stopLoss = Number(analysis.stopLoss)
        const takeProfit = Number(analysis.takeProfit)
        const notional = Number(analysis.positionNotional) || (Number(analysis.margin || 0) * Number(analysis.leverage || 1)) || entryPrice
        if (!(notional > 0)) continue

        const exit = simulateExit({ side, entryPrice, stopLoss, takeProfit, notional, isBot4: botId === 'model-4', entryBarIndex: i, entryTfRaw: entryRows })
        if (!exit) continue // ran out of candle history before an exit event - leave it out rather than guess

        const sign = side === 'BUY' ? 1 : -1
        const pnl = Math.round(sign * ((exit.price - entryPrice) / entryPrice) * notional * 100) / 100
        const openedAt = Number(entryRows[i][0])
        trades.push({
          symbol,
          signalModelId: botId,
          side,
          entryPrice: Math.round(entryPrice * 1e8) / 1e8,
          exitPrice: Math.round(exit.price * 1e8) / 1e8,
          stopLoss, takeProfit,
          notional: Math.round(notional * 100) / 100,
          leverage: Number(analysis.leverage) || null,
          confidence: Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : null,
          openedAt,
          closedAt: exit.time,
          result: exit.status === 'CLOSED_TP' ? 'TP' : 'SL',
          pnl,
        })
        onTrade(trades[trades.length - 1])

        let exitIdx = i + 1
        while (exitIdx < entryRows.length && Number(entryRows[exitIdx][6]) < exit.time) exitIdx += 1
        openUntil[botId] = exitIdx + 1
      }
    }
    onProgress({ symbol, bar: entryRows.length, totalBars: entryRows.length, trades: trades.length, symbolDone: true })
  }

  return { trades, totalSteps }
}
