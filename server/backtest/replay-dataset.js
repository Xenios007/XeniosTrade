// Historical-replay AI-dataset harness.
//
// Pulls months of Binance klines, steps bar-by-bar, runs the REAL
// analyzeSymbolStrategy at each step, and every time a bot would have entered,
// simulates the trade forward to TP/SL and writes a closed-trade record in the
// same format the live system produces. The rows land in
// server/data/backtest-history.json, which getPreferredLearningBotDataset()
// merges into the training set (they never touch account balances).
//
//   npm run backtest:dataset -- --months 6 --bots model-1,model-2,model-3,model-4
//
// Flags:
//   --months N            history depth (default 6)
//   --bots a,b,c          signal models to replay (default: all non-blank)
//   --symbols preferred|X,Y   symbol list (default: current preferredSymbols)
//   --step 5m             evaluation cadence (default 5m)
//   --fee-bps 5           taker fee per side in bps (default 5)
//   --slippage-bps 2      slippage per side in bps (default 2)
//   --max-hold-hours 48   force-close after N hours (default 48)
//   --strict-context      zero the order-book/funding context instead of proxying
//   --append              add to existing backtest-history.json instead of replacing
//   --no-train            write the file but do not launch training
//   --out <path>          output file (default server/data/backtest-history.json,
//                         or server/data/backtest-runs/<run-id>.json when --run-id
//                         is given without --out)
//   --money-stop-usd N    intrabar -N USDT hard stop applied to every bot (0=off)
//   --sl-mult F           scale stop-loss distance from entry by F (1=untouched)
//   --tp-mult F           scale take-profit distance from entry by F (1=untouched)
//   --run-id <slug>       stable id for the run registry / report .md
//   --label "text"        human label shown in the Backtests UI
//   --conclusion "text"   free-text takeaway recorded with the run
//
// Every run is recorded in server/data/backtest-runs.json with a matching
// server/backtest/runs/<id>.md report (see run-registry.js).

// MUST run before the server module is loaded so its HTTP listener / timers
// stay off. Static `import` is hoisted, so the server module is pulled in via
// dynamic import() below, after this assignment.
process.env.XENIOS_SERVER_AUTOSTART = 'off'

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SIGNAL_MODELS, getSignalModelName, getEffectiveSignalModelStrategy } from '../../src/lib/signalModels.js'
import { DEFAULT_PREFERRED_SYMBOLS } from '../../src/lib/tradingConfig.js'
import {
  fetchHistoricalKlines,
  fetchFundingRateHistory,
  fundingRateAt,
} from './historical-data.js'
import {
  RUNS_DATA_DIR,
  dataDir as registryDataDir,
  upsertRun,
  writeRunMarkdown,
} from './run-registry.js'

// Dynamic (not hoisted) so XENIOS_SERVER_AUTOSTART is already set — keeps the
// server module's HTTP listener and background timers off.
const {
  analyzeSymbolStrategy,
  toCandleData,
  getSettings,
  normalizeLearningBotSettings,
  refreshLearningBotDatasetArtifact,
  launchLearningBotTraining,
} = await import('../mock-trading-server.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')

// ---- args ---------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i += 1
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const MONTHS = Number(args.months || 6)
const STEP = String(args.step || '5m')
const FEE_BPS = Number(args['fee-bps'] ?? 5)
const SLIPPAGE_BPS = Number(args['slippage-bps'] ?? 2)
const MAX_HOLD_MS = Number(args['max-hold-hours'] || 48) * 3_600_000
const STRIDE = Math.max(1, Number(args.stride || 1)) // evaluate every Nth entry bar
// Hard ceiling on trades kept per (symbol, bot) so a loose-rule bot can't blow
// up memory on a wide/long run. 500 x 70 symbols x 4 bots ~= 140k rows max.
const CAP_PER_SYMBOL_BOT = Math.max(20, Number(args['cap-per-symbol-bot'] || 500))
const STRICT_CONTEXT = Boolean(args['strict-context'])
// Per-trade hard money stop in USDT applied to EVERY bot in the run (0 = off).
// Models the Bot 4 style "-1 USDT and you're out" cut. Detected intrabar at the
// price where unrealized PnL crosses -N, so a tight dollar stop that maps to a
// sub-0.2% move is realistically hit on the first wobble against the trade.
const MONEY_STOP_USD = Math.max(0, Number(args['money-stop-usd'] || 0))
// "Give it room" experiment knobs (backtest-only): scale the signal engine's
// stop-loss and take-profit *distance from entry* by these factors before
// simulating the exit. 1 = untouched. Direction-agnostic (works for BUY & SELL
// because (entry - rawStop) carries the sign). configuredStopLossPercent is
// scaled by SL_MULT too so downstream risk / R math stays consistent.
const SL_MULT = Math.max(0.1, Number(args['sl-mult'] || 1))
const TP_MULT = Math.max(0.1, Number(args['tp-mult'] || 1))
const APPEND = Boolean(args.append)
const SKIP_TRAIN = Boolean(args['no-train'])
// Registry identity. --run-id gives a stable slug; otherwise derive one from the
// timestamp so every run is still recorded distinctly.
const RUN_LABEL = args.label ? String(args.label) : ''
const RUN_CONCLUSION = args.conclusion ? String(args.conclusion) : ''
const RUN_ID = String(
  args['run-id']
  || `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`,
).trim().replace(/[^A-Za-z0-9._-]/g, '-')
// Explicit --out wins. A run started with --run-id (and no --out) writes its own
// per-run data file; a bare run keeps the legacy shared backtest-history.json.
const OUT_PATH = args.out
  ? path.resolve(String(args.out))
  : (args['run-id']
    ? path.join(RUNS_DATA_DIR, `${RUN_ID}.json`)
    : path.join(dataDir, 'backtest-history.json'))
// Path stored in the registry, relative to server/data so the server can resolve it.
const OUT_PATH_REL = path.relative(registryDataDir, OUT_PATH)

const BIAS_TF = '1h'
const SETUP_TF = '15m'
const ENTRY_TF = STEP // evaluation + forward simulation cadence
const WARMUP_BARS = 220

// ---- helpers ----------------------------------------------------------

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const round2 = (n) => Math.round(Number(n) * 100) / 100

function sliceClosedBy(rawKlines, nowMs) {
  // rawKlines rows: [openTime, o, h, l, c, v, closeTime, ...] ascending.
  let hi = rawKlines.length
  while (hi > 0 && Number(rawKlines[hi - 1][6]) > nowMs) hi -= 1
  return rawKlines.slice(0, hi)
}

function takerImbalanceProxy(entryCandles) {
  const window = entryCandles.slice(-5)
  let buy = 0
  let sell = 0
  for (const candle of window) {
    buy += Number(candle.takerBuyBaseVolume || 0)
    sell += Number(candle.takerSellBaseVolume || 0)
  }
  if (sell <= 0) return buy > 0 ? 3 : 1
  return buy / sell
}

function tradePnl({ side, entryPrice, exitPrice, notional }) {
  const ratio = side === 'BUY'
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice
  return ratio * notional
}

// Forward-walk the entry-timeframe candles from just after entry; return the
// exit {price, time, status}. SL wins ties with TP (matches live close logic).
function simulateExit({ side, entryPrice, stopLoss, takeProfit, notional, isBot4, entryBarIndex, entryTfRaw }) {
  const entryTime = Number(entryTfRaw[entryBarIndex][0])
  // Effective money-stop threshold: the run-wide --money-stop-usd for any bot,
  // and always at least Bot 4's built-in 1 USDT for model-4.
  const moneyStopUsd = Math.max(MONEY_STOP_USD, isBot4 ? 1 : 0)
  // Price at which unrealized PnL == -moneyStopUsd (intrabar trigger).
  const moneyStopPrice = moneyStopUsd > 0 && notional > 0
    ? (side === 'BUY'
      ? entryPrice * (1 - moneyStopUsd / notional)
      : entryPrice * (1 + moneyStopUsd / notional))
    : null

  for (let i = entryBarIndex + 1; i < entryTfRaw.length; i += 1) {
    const row = entryTfRaw[i]
    const high = Number(row[2])
    const low = Number(row[3])
    const close = Number(row[4])
    const closeTime = Number(row[6])

    const hitTP = side === 'BUY' ? high >= takeProfit : low <= takeProfit
    const hitSL = side === 'BUY' ? low <= stopLoss : high >= stopLoss
    const hitMoneyStop = moneyStopPrice != null
      && (side === 'BUY' ? low <= moneyStopPrice : high >= moneyStopPrice)

    if (hitSL || hitMoneyStop) {
      // Whichever protective level is nearer to entry fills first.
      const stopFill = hitSL && (!hitMoneyStop
        || (side === 'BUY' ? stopLoss >= moneyStopPrice : stopLoss <= moneyStopPrice))
      return {
        price: stopFill ? stopLoss : moneyStopPrice,
        time: closeTime,
        status: 'CLOSED_SL',
      }
    }
    if (hitTP) {
      return { price: takeProfit, time: closeTime, status: 'CLOSED_TP' }
    }
    if (closeTime - entryTime >= MAX_HOLD_MS) {
      const pnl = tradePnl({ side, entryPrice, exitPrice: close, notional })
      return {
        price: close,
        time: closeTime,
        status: pnl >= 0 ? 'CLOSED_TP' : 'CLOSED_SL',
        timedOut: true,
      }
    }
  }
  return null // ran out of data before the trade resolved
}

// ---- main ------------------------------------------------------------

async function main() {
  const settings = await getSettings()

  const activeBots = String(args.bots || '')
    ? String(args.bots).split(',').map((s) => s.trim()).filter(Boolean)
    : SIGNAL_MODELS.filter((m) => m.status !== 'blank').map((m) => m.id)

  let symbols
  if (!args.symbols || args.symbols === 'preferred') {
    symbols = Array.from(new Set([
      ...(settings.strategy.preferredSymbols || []),
      ...DEFAULT_PREFERRED_SYMBOLS,
    ])).filter(Boolean)
  } else {
    symbols = String(args.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  }

  const endMs = Date.now()
  const startMs = endMs - MONTHS * 30 * 86_400_000

  console.log('=== Backtest replay dataset ===')
  console.log(`range      : ${isoDay(startMs)} → ${isoDay(endMs)} (${MONTHS} months)`)
  console.log(`bots       : ${activeBots.join(', ')}`)
  console.log(`symbols    : ${symbols.length} (${symbols.slice(0, 8).join(', ')}${symbols.length > 8 ? ', …' : ''})`)
  console.log(`step       : ${STEP} (stride ${STRIDE})   friction: ${FEE_BPS + SLIPPAGE_BPS} bps/side x2   context: ${STRICT_CONTEXT ? 'strict/zero' : 'proxied'}`)
  console.log(`cap        : ${CAP_PER_SYMBOL_BOT} kept per (symbol,bot), reservoir-sampled across the range`)
  if (MONEY_STOP_USD > 0) console.log(`money stop  : -${MONEY_STOP_USD} USDT per trade, intrabar, ALL bots in this run`)
  if (SL_MULT !== 1 || TP_MULT !== 1) console.log(`give-it-room : stop x${SL_MULT}  TP x${TP_MULT}  (distance from entry)`)
  console.log(`output     : ${OUT_PATH}${APPEND ? ' (append)' : ''}`)
  console.log('')

  // Effective per-bot strategy (leverage / margin / mode) — analyzeSymbolStrategy
  // does not echo these back, so pull them the same way the live scan does.
  const effStrategy = {}
  for (const botId of activeBots) {
    effStrategy[botId] = getEffectiveSignalModelStrategy(settings.strategy, botId, { runningBalance: 1000 })
  }

  const runConfig = {
    months: MONTHS,
    step: STEP,
    stride: STRIDE,
    bots: activeBots,
    symbolCount: symbols.length,
    capPerSymbolBot: CAP_PER_SYMBOL_BOT,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    maxHoldHours: MAX_HOLD_MS / 3_600_000,
    moneyStopUsd: MONEY_STOP_USD,
    slMult: SL_MULT,
    tpMult: TP_MULT,
    strictContext: STRICT_CONTEXT,
    append: APPEND,
    rangeStart: isoDay(startMs),
    rangeEnd: isoDay(endMs),
  }
  const signalsUsed = activeBots.map((botId) => {
    const eff = effStrategy[botId] || {}
    const lev = eff.leverage ?? '?'
    const sl = eff.stopLossPercent ?? eff.stopLoss ?? '?'
    const mode = eff.marginMode || settings.strategy.marginMode || 'ISOLATED'
    return `${getSignalModelName(botId)} — lev ${lev}x / SL ${sl}% / ${mode}`
  })

  const runStartedAt = Date.now()
  await upsertRun({
    id: RUN_ID,
    label: RUN_LABEL || RUN_ID,
    status: 'running',
    startedAt: runStartedAt,
    finishedAt: null,
    config: runConfig,
    signalsUsed,
    conclusion: RUN_CONCLUSION,
    dataFile: OUT_PATH_REL,
    mdFile: `runs/${RUN_ID}.md`,
    progress: { symbolsDone: 0, symbolsTotal: symbols.length, currentSymbol: null, etaSeconds: null },
    summary: null,
  }).catch((error) => console.warn('registry upsert (start) failed:', error?.message || error))

  const rows = []

  for (let s = 0; s < symbols.length; s += 1) {
    const symbol = symbols[s]
    const elapsedS = (Date.now() - runStartedAt) / 1000
    const etaSeconds = s > 0 ? Math.round((elapsedS / s) * (symbols.length - s)) : null
    await upsertRun({
      id: RUN_ID,
      status: 'running',
      progress: { symbolsDone: s, symbolsTotal: symbols.length, currentSymbol: symbol, etaSeconds },
    }).catch(() => {})
    process.stdout.write(`[${s + 1}/${symbols.length}] ${symbol} … fetching`)

    let entryTfRaw
    let setupTfRaw
    let biasTfRaw
    let funding
    try {
      ;[biasTfRaw, setupTfRaw, entryTfRaw, funding] = await Promise.all([
        fetchHistoricalKlines(symbol, BIAS_TF, startMs, endMs),
        fetchHistoricalKlines(symbol, SETUP_TF, startMs, endMs),
        fetchHistoricalKlines(symbol, ENTRY_TF, startMs, endMs),
        STRICT_CONTEXT ? Promise.resolve([]) : fetchFundingRateHistory(symbol, startMs, endMs),
      ])
    } catch (error) {
      console.log(`  — skipped (${error instanceof Error ? error.message : error})`)
      continue
    }

    if (entryTfRaw.length < WARMUP_BARS + 20) {
      console.log(`  — skipped (only ${entryTfRaw.length} ${ENTRY_TF} bars)`)
      continue
    }
    process.stdout.write(`  ${entryTfRaw.length} ${ENTRY_TF} bars … replaying`)

    // Convert every timeframe ONCE, then pass bounded trailing windows into the
    // signal engine each step (keeps every iteration O(1), not O(n)).
    const entryC = toCandleData(entryTfRaw)
    const setupC = toCandleData(setupTfRaw)
    const biasC = toCandleData(biasTfRaw)
    const ENTRY_WIN = 280
    const SETUP_WIN = 140
    const BIAS_WIN = 140

    // one open sim-trade per (bot, symbol) at a time.
    // Per (symbol, bot) we reservoir-sample down to CAP_PER_SYMBOL_BOT so a
    // loose-rule bot can't blow up memory, while the kept sample still spans
    // the whole date range (not just the first N trades). Once a bot has seen
    // 6x the cap we stop evaluating it for this symbol to bound CPU too.
    const openUntil = {}   // botId -> entry-tf bar index the trade resolves at
    const reservoir = {}   // botId -> kept records (<= cap)
    const seenCount = {}    // botId -> qualifying trades seen
    const HARD_SEEN = CAP_PER_SYMBOL_BOT * 6
    let symbolRows = 0
    let setupIdx = 0
    let biasIdx = 0

    for (let i = WARMUP_BARS; i < entryTfRaw.length - 1; i += STRIDE) {
      if (activeBots.every((b) => (seenCount[b] || 0) >= HARD_SEEN)) break
      const nowMs = entryC[i].closeTime // this bar's close time
      while (setupIdx + 1 < setupC.length && setupC[setupIdx + 1].closeTime <= nowMs) setupIdx += 1
      while (biasIdx + 1 < biasC.length && biasC[biasIdx + 1].closeTime <= nowMs) biasIdx += 1
      if (setupIdx < 40 || biasIdx < 26) continue

      const entryCandles = entryC.slice(Math.max(0, i - ENTRY_WIN), i + 1)
      const setupCandles = setupC.slice(Math.max(0, setupIdx - SETUP_WIN), setupIdx + 1)
      const biasCandles = biasC.slice(Math.max(0, biasIdx - BIAS_WIN), biasIdx + 1)

      const marketContext = STRICT_CONTEXT
        ? { orderBookImbalance: 0, fundingRate: 0 }
        : {
          orderBookImbalance: takerImbalanceProxy(entryCandles),
          fundingRate: fundingRateAt(funding, nowMs),
        }

      for (const botId of activeBots) {
        if ((seenCount[botId] || 0) >= HARD_SEEN) continue
        if (openUntil[botId] !== undefined && i < openUntil[botId]) continue

        let analysis
        try {
          analysis = analyzeSymbolStrategy(
            symbol,
            biasCandles,
            setupCandles,
            entryCandles,
            settings.strategy,
            botId,
            marketContext,
            [],
          )
        } catch {
          analysis = null
        }
        if (!analysis || !analysis.entryPrice || !analysis.stopLoss || !analysis.takeProfit) continue

        const eff = effStrategy[botId]
        const leverage = Number(analysis.leverage || eff.leverage || 0)
        const margin = Number(analysis.margin || eff.marginPerTrade || 0)
        const side = analysis.side === 'SELL' || analysis.direction === 'SHORT' ? 'SELL' : 'BUY'
        const entryPrice = Number(analysis.entryPrice)
        const notional = Number(analysis.positionNotional)
          || (margin * leverage)
          || entryPrice
        // Widen (or tighten) stop / TP distance from entry. (entry - raw) keeps
        // the sign so this is correct for both BUY and SELL.
        const rawStop = Number(analysis.stopLoss)
        const rawTp = Number(analysis.takeProfit)
        const stopLoss = SL_MULT === 1 ? rawStop : entryPrice - (entryPrice - rawStop) * SL_MULT
        const takeProfit = TP_MULT === 1 ? rawTp : entryPrice - (entryPrice - rawTp) * TP_MULT
        const configuredStopLossPercent = Number(analysis.configuredStopLossPercent || 0) * SL_MULT
        const exit = simulateExit({
          side,
          entryPrice,
          stopLoss,
          takeProfit,
          notional,
          isBot4: botId === 'model-4',
          entryBarIndex: i,
          entryTfRaw,
        })
        if (!exit) continue

        const friction = notional * ((FEE_BPS + SLIPPAGE_BPS) / 10_000) * 2
        const grossPnl = tradePnl({ side, entryPrice, exitPrice: exit.price, notional })
        const pnl = round2(grossPnl - friction)
        const entryTime = nowMs

        const idSuffix = MONEY_STOP_USD > 0 ? `-ms${MONEY_STOP_USD}` : ''
        const rec = {
          id: `auto_backtest-${botId}${idSuffix}-${symbol}-${entryTime}`,
          symbol,
          side,
          type: 'MARKET',
          quantity: round2(notional / entryPrice),
          entryPrice: round2(entryPrice),
          exitPrice: round2(exit.price),
          stopLoss: round2(stopLoss),
          takeProfit: round2(takeProfit),
          notional: round2(notional),
          margin: round2(margin),
          marginMode: eff.marginMode || settings.strategy.marginMode || 'ISOLATED',
          leverage,
          status: exit.status,
          result: exit.status === 'CLOSED_TP' ? 'TP' : 'SL',
          mode: 'backtest',
          source: 'AUTO_BACKTEST',
          signalSummary: String(analysis.summary || ''),
          signalModelId: botId,
          signalModelName: getSignalModelName(botId),
          configuredStopLossPercent,
          moneyStopUsd: MONEY_STOP_USD > 0 ? MONEY_STOP_USD : undefined,
          slMult: SL_MULT !== 1 ? SL_MULT : undefined,
          tpMult: TP_MULT !== 1 ? TP_MULT : undefined,
          patternScore: Number(analysis.patternScore || 0),
          aiDecision: null,
          aiReview: null,
          pnl,
          transactTime: entryTime,
          closedAt: exit.time,
          tradeDateKey: isoDay(entryTime),
          closedDateKey: isoDay(exit.time),
          timedOut: Boolean(exit.timedOut),
          walletId: null,
          walletName: `Backtest ${getSignalModelName(botId)}`,
          backtest: true,
        }

        seenCount[botId] = (seenCount[botId] || 0) + 1
        const buf = (reservoir[botId] ||= [])
        if (buf.length < CAP_PER_SYMBOL_BOT) {
          buf.push(rec)
        } else {
          const j = Math.floor(Math.random() * seenCount[botId])
          if (j < CAP_PER_SYMBOL_BOT) buf[j] = rec
        }
        symbolRows += 1

        // block re-entry for this bot until the trade's exit bar
        let exitIdx = i + 1
        while (exitIdx < entryTfRaw.length && Number(entryTfRaw[exitIdx][6]) < exit.time) exitIdx += 1
        openUntil[botId] = exitIdx + 1
      }
    }

    let kept = 0
    for (const botId of activeBots) {
      const buf = reservoir[botId] || []
      kept += buf.length
      for (const rec of buf) rows.push(rec)
    }
    console.log(`  → ${symbolRows} setups → kept ${kept}`)
  }

  // ---- write + summarise ----
  let finalRows = rows
  if (APPEND) {
    try {
      const existing = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'))
      if (Array.isArray(existing)) {
        const seen = new Set(rows.map((r) => r.id))
        finalRows = [...existing.filter((r) => !seen.has(r.id)), ...rows]
      }
    } catch { /* no existing file */ }
  }
  // newest first, matching trade-history.json ordering
  finalRows.sort((a, b) => Number(b.transactTime) - Number(a.transactTime))
  await fs.writeFile(OUT_PATH, JSON.stringify(finalRows, null, 2))

  console.log('')
  console.log('=== Summary (this run) ===')
  const byBot = {}
  const sideSeed = () => ({ n: 0, wins: 0, pnl: 0 })
  for (const r of rows) {
    const b = (byBot[r.signalModelId] ||= { n: 0, wins: 0, pnl: 0, timedOut: 0, BUY: sideSeed(), SELL: sideSeed() })
    b.n += 1
    if (r.pnl > 0) b.wins += 1
    if (r.timedOut) b.timedOut += 1
    b.pnl += r.pnl
    const side = r.side === 'SELL' ? 'SELL' : 'BUY'
    b[side].n += 1
    if (r.pnl > 0) b[side].wins += 1
    b[side].pnl += r.pnl
  }
  const perBotSummary = []
  for (const botId of Object.keys(byBot)) {
    const b = byBot[botId]
    const wr = b.n ? (b.wins / b.n) * 100 : 0
    const avg = b.n ? b.pnl / b.n : 0
    console.log(
      `${getSignalModelName(botId).padEnd(7)}  rows ${String(b.n).padStart(5)}`
      + `  win ${wr.toFixed(1).padStart(5)}%`
      + `  total ${b.pnl.toFixed(2).padStart(10)} USDT`
      + `  avg/trade ${avg.toFixed(3).padStart(8)}`
      + `  timedOut ${b.timedOut}`,
    )
    const sideStat = (x) => ({
      rows: x.n,
      winRate: x.n ? (x.wins / x.n) * 100 : 0,
      totalUsd: round2(x.pnl),
      avgPerTrade: x.n ? x.pnl / x.n : 0,
    })
    perBotSummary.push({
      botId,
      botName: getSignalModelName(botId),
      rows: b.n,
      winRate: wr,
      totalUsd: round2(b.pnl),
      avgPerTrade: avg,
      timedOut: b.timedOut,
      buy: sideStat(b.BUY),
      sell: sideStat(b.SELL),
    })
  }
  console.log(`\nwrote ${rows.length} new rows (${finalRows.length} total) → ${OUT_PATH}`)

  await upsertRun({
    id: RUN_ID,
    status: 'complete',
    finishedAt: Date.now(),
    dataFile: OUT_PATH_REL,
    progress: { symbolsDone: symbols.length, symbolsTotal: symbols.length, currentSymbol: null, etaSeconds: 0 },
    summary: { perBot: perBotSummary, totalRows: rows.length, fileTotalRows: finalRows.length },
  }).catch((error) => console.warn('registry upsert (complete) failed:', error?.message || error))
  try {
    const { readRegistry } = await import('./run-registry.js')
    const entry = (await readRegistry()).find((r) => r.id === RUN_ID)
    if (entry) await writeRunMarkdown(entry)
  } catch (error) {
    console.warn('run markdown write failed:', error?.message || error)
  }

  // ---- optional training ----
  if (SKIP_TRAIN) {
    console.log('\n--no-train set. Run AI training from the AI Training page when ready.')
    return
  }
  console.log('\n=== Launching AI training on the merged dataset ===')
  const freshSettings = await getSettings()
  const config = normalizeLearningBotSettings(freshSettings.learningBot)
  if (!config.aiTrainer.enabled) {
    console.log('AI Trainer is disabled in Learning Bot settings — skipping training. File is written.')
    return
  }
  const { dataset } = await refreshLearningBotDatasetArtifact(config)
  console.log(`training on ${dataset.length} rows …`)
  const result = await launchLearningBotTraining({ config, dataset })
  console.log('training launch result:', JSON.stringify(result?.status || result, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('\nbacktest failed:', error)
    await upsertRun({
      id: RUN_ID,
      status: 'failed',
      finishedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
    process.exit(1)
  })
