// Historical-replay AI-dataset harness (v2 — 8 bots, 5-year run, multi-core).
//
// Spawns a pool of worker_threads (replay-worker.js); each worker owns one CPU
// core and processes symbols end-to-end: load cached klines, step the 5m bars,
// run the REAL analyzeSymbolStrategy, capture a LEAKAGE-FREE entry-time feature
// vector + BTC/ETH context + regime + chronological split tag, simulate the exit
// (SL wins same-bar ties; Bot 4 money stop; force-close after --max-hold-hours),
// and flush the symbol's rows to RUN_DIR/<symbol>.ndjson. This main process just
// feeds symbols, tracks progress, then merges the per-symbol NDJSON into one run
// JSON + registry entry + markdown, and optionally launches training.
//
// Resumable: a completed symbol is recorded in RUN_DIR/_manifest.json and
// skipped with --resume. The full multi-symbol dataset is never in memory at once.
//
//   node server/backtest/replay-dataset.js --months 60 --stride 2 --concurrency 3 \
//     --bots model-1,model-2,model-3,model-4,model-5,model-6,model-7,model-8 \
//     --symbols universe --run-id primary-8bot-5yr --no-train
//
// Flags: --months --bots --symbols(universe|preferred|X,Y) --stride --concurrency
//        --fee-bps --slippage-bps --max-hold-hours --cap-per-symbol-bot
//        --strict-context --no-eth-context --no-train --run-id --resume
//        --label --conclusion

process.env.XENIOS_SERVER_AUTOSTART = 'off'

import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { SIGNAL_MODELS, getSignalModelName, getSignalModel, getEffectiveSignalModelStrategy } from '../../src/lib/signalModels.js'
import { DEFAULT_PREFERRED_SYMBOLS, BACKTEST_UNIVERSE } from '../../src/lib/tradingConfig.js'
import { FEATURE_VERSION } from './feature-lib.js'
import { SPLIT_EMBARGO_MS } from './splits.js'
import { concatNdjson, iterateRowsNdjson } from './ndjson.js'
import {
  RUNS_DATA_DIR, dataDir as registryDataDir, upsertRun, writeRunMarkdown,
} from './run-registry.js'

const { getSettings, normalizeLearningBotSettings, refreshLearningBotDatasetArtifact, launchLearningBotTraining } = await import('../mock-trading-server.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const k = t.slice(2)
      const n = argv[i + 1]
      if (n === undefined || n.startsWith('--')) a[k] = true
      else { a[k] = n; i += 1 }
    } else a._.push(t)
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const MONTHS = Number(args.months || 60)
const FEE_BPS = Number(args['fee-bps'] ?? 5)
const SLIPPAGE_BPS = Number(args['slippage-bps'] ?? 2)
const MAX_HOLD_MS = Number(args['max-hold-hours'] || 48) * 3_600_000
const STRIDE = Math.max(1, Number(args.stride || 2))
const CONCURRENCY = Math.min(Math.max(1, os.cpus().length - 1), Math.max(1, Number(args.concurrency || 3)))
const CAP_PER_SYMBOL_BOT = Math.max(20, Number(args['cap-per-symbol-bot'] || 400))
const STRICT_CONTEXT = Boolean(args['strict-context'])
const ETH_CONTEXT = args['no-eth-context'] === undefined
// --no-features: skip the 263-value entry-time feature vector + BTC/ETH context
// (still tags marketRegime). For validation/cost-stress runs that never train —
// halves per-symbol time and shrinks the output ~10x.
const NO_FEATURES = Boolean(args['no-features'])
const SKIP_TRAIN = Boolean(args['no-train'])
const RESUME = Boolean(args.resume)
const RUN_LABEL = args.label ? String(args.label) : ''
const RUN_CONCLUSION = args.conclusion ? String(args.conclusion) : ''
const RUN_ID = String(args['run-id'] || `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`)
  .trim().replace(/[^A-Za-z0-9._-]/g, '-')
const RUN_DIR = path.join(RUNS_DATA_DIR, RUN_ID)
// Merged dataset is NDJSON — a full-feature 5yr/20-symbol/8-bot set is ~600 MB,
// past V8's max string length so it can never be a single JSON.stringify array.
const OUT_PATH = path.join(RUNS_DATA_DIR, `${RUN_ID}.ndjson`)
const OUT_PATH_REL = path.relative(registryDataDir, OUT_PATH)
const MANIFEST_PATH = path.join(RUN_DIR, '_manifest.json')

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const round2 = (n) => Math.round(Number(n) * 100) / 100
const gitSha = () => { try { return execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..', '..') }).toString().trim() } catch { return 'unknown' } }

// ---- worker pool -------------------------------------------------------

function runWorkerPool(symbols, workerData, size, onProgress, onSymbolDone) {
  return new Promise((resolve, reject) => {
    const results = {}
    let cursor = 0
    let active = 0
    const workerPath = path.join(__dirname, 'replay-worker.js')
    const workers = []
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
      for (const w of workers) w.postMessage({ type: 'shutdown' })
      resolve(results)
    }

    const feed = (w) => {
      if (cursor >= symbols.length) {
        active -= 1
        if (active === 0) finish()
        return
      }
      const symbol = symbols[cursor]
      cursor += 1
      w.postMessage({ type: 'symbol', symbol })
    }

    for (let k = 0; k < size; k += 1) {
      const w = new Worker(workerPath, { workerData })
      workers.push(w)
      active += 1
      w.on('message', (msg) => {
        if (msg.type === 'ready') feed(w)
        else if (msg.type === 'progress') onProgress(msg)
        else if (msg.type === 'done') {
          results[msg.symbol] = msg.result
          onSymbolDone(msg.symbol, msg.result).finally(() => feed(w))
        }
      })
      w.on('error', (err) => { finished = true; reject(err) })
      w.on('exit', (code) => { if (code !== 0 && !finished) reject(new Error(`worker exited ${code}`)) })
    }
  })
}

// ---- main ------------------------------------------------------------

async function main() {
  await fs.mkdir(RUN_DIR, { recursive: true })
  const settings = await getSettings()

  const activeBots = String(args.bots || '')
    ? String(args.bots).split(',').map((s) => s.trim()).filter(Boolean)
    : SIGNAL_MODELS.filter((m) => m.status !== 'blank').map((m) => m.id)

  let symbols
  if (!args.symbols || args.symbols === 'universe') symbols = [...BACKTEST_UNIVERSE]
  else if (args.symbols === 'preferred') symbols = Array.from(new Set([...(settings.strategy.preferredSymbols || []), ...DEFAULT_PREFERRED_SYMBOLS])).filter(Boolean)
  else symbols = String(args.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)

  const endMs = Date.now()
  const startMs = endMs - MONTHS * 30 * 86_400_000

  let manifest = { runId: RUN_ID, symbolsDone: [], perSymbol: {}, startedAt: Date.now() }
  if (RESUME) {
    try {
      const ex = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
      if (ex && Array.isArray(ex.symbolsDone)) manifest = ex
    } catch { /* fresh */ }
  }
  const todo = symbols.filter((s) => !manifest.symbolsDone.includes(s))

  const effStrategy = {}
  for (const botId of activeBots) effStrategy[botId] = getEffectiveSignalModelStrategy(settings.strategy, botId, { runningBalance: 1000 })

  const sha = gitSha()
  console.log('=== Backtest replay dataset v2 (8-bot, multi-core) ===')
  console.log(`run id     : ${RUN_ID}   git ${sha.slice(0, 10)}`)
  console.log(`range      : ${isoDay(startMs)} → ${isoDay(endMs)} (${MONTHS} months requested)`)
  console.log(`bots       : ${activeBots.join(', ')}`)
  console.log(`symbols    : ${symbols.length} total, ${todo.length} to do${RESUME ? ` (resume: ${manifest.symbolsDone.length} done)` : ''}`)
  console.log(`stride ${STRIDE}   workers ${CONCURRENCY} / ${os.cpus().length} cores   friction ${FEE_BPS + SLIPPAGE_BPS} bps/side x2   cap ${CAP_PER_SYMBOL_BOT}/(sym,bot)`)
  console.log(`feature v  : ${FEATURE_VERSION}   ETH context: ${ETH_CONTEXT ? 'on' : 'off'}   context: ${STRICT_CONTEXT ? 'strict/zero' : 'proxied'}`)
  console.log(`out dir    : ${RUN_DIR}\n`)

  const runConfig = {
    schemaVersion: 2, months: MONTHS, step: '5m', stride: STRIDE, concurrency: CONCURRENCY,
    bots: activeBots, symbolCount: symbols.length, capPerSymbolBot: CAP_PER_SYMBOL_BOT,
    feeBps: FEE_BPS, slippageBps: SLIPPAGE_BPS, maxHoldHours: MAX_HOLD_MS / 3_600_000,
    strictContext: STRICT_CONTEXT, ethContext: ETH_CONTEXT, noFeatures: NO_FEATURES, featureVersion: FEATURE_VERSION, gitSha: sha,
    rangeStart: isoDay(startMs), rangeEnd: isoDay(endMs), embargoMs: SPLIT_EMBARGO_MS,
    splitFractions: [0.6, 0.2, 0.2], randomSeed: 7, device: 'cpu-replay-workers',
    node: process.version, platform: process.platform, cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model, totalMemGb: Number((os.totalmem() / 1e9).toFixed(1)),
  }
  const signalsUsed = activeBots.map((botId) => {
    const eff = effStrategy[botId] || {}
    const m = getSignalModel(botId)
    return `${getSignalModelName(botId)} [${m.strategyFamily || 'legacy'}] — lev ${eff.leverage ?? '?'}x / SL ${eff.stopLossPercent ?? '?'}% / ${eff.marginMode || 'ISOLATED'}`
  })

  const runStartedAt = Date.now()
  await upsertRun({
    id: RUN_ID, label: RUN_LABEL || RUN_ID, status: 'running', startedAt: runStartedAt, finishedAt: null,
    config: runConfig, signalsUsed, conclusion: RUN_CONCLUSION, dataFile: OUT_PATH_REL, mdFile: `runs/${RUN_ID}.md`,
    progress: { symbolsDone: manifest.symbolsDone.length, symbolsTotal: symbols.length, currentSymbol: null, etaSeconds: null },
    summary: null,
  }).catch((e) => console.warn('registry upsert (start) failed:', e?.message || e))

  const workerData = {
    RUN_DIR, MONTHS, STRIDE, FEE_BPS, SLIPPAGE_BPS, MAX_HOLD_MS, CAP_PER_SYMBOL_BOT,
    STRICT_CONTEXT, ETH_CONTEXT, NO_FEATURES, RUN_ID, activeBots,
  }

  let doneCount = manifest.symbolsDone.length
  const progressBySymbol = {}
  const HEARTBEAT_PATH = path.join(RUN_DIR, '_heartbeat.json')
  const beat = () => fs.writeFile(HEARTBEAT_PATH, JSON.stringify({ pid: process.pid, updatedAt: Date.now(), doneCount })).catch(() => {})
  await beat()
  const beatTimer = setInterval(beat, 15_000)
  beatTimer.unref?.()
  await runWorkerPool(
    todo, workerData, Math.min(CONCURRENCY, todo.length || 1),
    (p) => {
      progressBySymbol[p.symbol] = p
      beat()
      process.stdout.write(`\r  [${doneCount}/${symbols.length} done] ${Object.values(progressBySymbol).map((x) => `${x.symbol} ${x.pct}%`).join('  ')}          `)
    },
    async (symbol, result) => {
      delete progressBySymbol[symbol]
      manifest.symbolsDone.push(symbol)
      manifest.perSymbol[symbol] = result
      doneCount += 1
      const elapsed = (Date.now() - runStartedAt) / 1000
      const perDone = doneCount - (manifest.symbolsDone.length - todo.length)
      const eta = perDone > 0 ? Math.round((elapsed / perDone) * (symbols.length - doneCount)) : null
      console.log(`\n  ✓ ${symbol}: ${result.rows ?? 0} rows / ${result.qualifying ?? 0} setups`
        + `${result.error ? ` — ERROR ${result.error.slice(0, 200)}` : ''}`
        + `${result.skipped ? ` — skipped (${result.skipped})` : ''}`
        + `  [${result.seconds ?? '?'}s]  eta ${eta ?? '?'}s`)
      await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
      await beat()
      await upsertRun({ id: RUN_ID, status: 'running', progress: { symbolsDone: doneCount, symbolsTotal: symbols.length, currentSymbol: symbol, etaSeconds: eta } }).catch(() => {})
    },
  )
  clearInterval(beatTimer)

  // ---- merge per-symbol NDJSON (stream — never buffer the full dataset) ----
  const sources = symbols.map((s) => path.join(RUN_DIR, `${s}.ndjson`))
  await concatNdjson(OUT_PATH, sources)

  // ---- summarise by streaming the merged file row-by-row ----
  const byBot = {}
  const byRegime = {}
  const bySplit = {}
  const bySymbol = {}
  let totalRows = 0
  for await (const r of iterateRowsNdjson(OUT_PATH)) {
    totalRows += 1
    const b = (byBot[r.signalModelId] ||= { rows: 0, wins: 0, net: 0, family: r.strategyFamily })
    b.rows += 1
    if (r.label?.win) b.wins += 1
    b.net += Number(r.label?.pnl || 0)
    byRegime[r.marketRegime] = (byRegime[r.marketRegime] || 0) + 1
    bySplit[r.split] = (bySplit[r.split] || 0) + 1
    bySymbol[r.symbol] = (bySymbol[r.symbol] || 0) + 1
  }
  console.log('\n\n=== Summary ===')
  for (const botId of Object.keys(byBot)) {
    const b = byBot[botId]
    console.log(`${getSignalModelName(botId).padEnd(7)} [${String(b.family || 'legacy').padEnd(18)}] rows ${String(b.rows).padStart(6)}  win ${(b.rows ? (b.wins / b.rows) * 100 : 0).toFixed(1).padStart(5)}%  net ${b.net.toFixed(1).padStart(9)} USDT`)
  }
  console.log('by regime :', JSON.stringify(byRegime))
  console.log('by split  :', JSON.stringify(bySplit))
  console.log(`\nwrote ${totalRows} rows -> ${OUT_PATH}`)

  const perBotSummary = Object.keys(byBot).map((botId) => {
    const b = byBot[botId]
    return { botId, botName: getSignalModelName(botId), strategyFamily: b.family, rows: b.rows, winRate: b.rows ? (b.wins / b.rows) * 100 : 0, totalUsd: round2(b.net), avgPerTrade: b.rows ? b.net / b.rows : 0 }
  })
  await upsertRun({
    id: RUN_ID, status: 'complete', finishedAt: Date.now(), dataFile: OUT_PATH_REL,
    progress: { symbolsDone: symbols.length, symbolsTotal: symbols.length, currentSymbol: null, etaSeconds: 0 },
    summary: {
      perBot: perBotSummary, totalRows, byRegime, bySplit, bySymbol,
      perSymbolHistory: Object.fromEntries(Object.entries(manifest.perSymbol).map(([s, v]) => [s, { start: v.historyStart, end: v.historyEnd, candles: v.candles, rows: v.rows, seconds: v.seconds }])),
    },
  }).catch((e) => console.warn('registry upsert (complete) failed:', e?.message || e))
  try {
    const { readRegistry } = await import('./run-registry.js')
    const entry = (await readRegistry()).find((r) => r.id === RUN_ID)
    if (entry) await writeRunMarkdown(entry)
  } catch (e) { console.warn('run markdown write failed:', e?.message || e) }

  if (SKIP_TRAIN) { console.log('\n--no-train set. Train from the AI Training page / train script when ready.'); return }
  console.log('\n=== Launching AI training on the merged dataset ===')
  const freshSettings = await getSettings()
  const config = normalizeLearningBotSettings(freshSettings.learningBot)
  if (!config.aiTrainer.enabled) { console.log('AI Trainer disabled — skipping. Files written.'); return }
  const { dataset } = await refreshLearningBotDatasetArtifact(config)
  console.log(`training on ${dataset.length} rows …`)
  const result = await launchLearningBotTraining({ config, dataset })
  console.log('training launch result:', JSON.stringify(result?.status || result, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('\nbacktest failed:', error)
    await upsertRun({ id: RUN_ID, status: 'failed', finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }).catch(() => {})
    process.exit(1)
  })
