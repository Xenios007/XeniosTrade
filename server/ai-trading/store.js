// On-disk state for AI Trading: the agent/risk config and the last few pipeline
// runs. Kept out of settings.json on purpose — that file has revision
// counters, a recovery mirror and a self-heal that AI Trading has no business
// touching — and holds no secrets (provider keys stay in aiProviderCredentials).

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAiTradingConfig } from '../../src/lib/aiTrading.js'
import { mergeScanLog } from '../../src/lib/aiTradingHistory.js'
import { MAX_SHADOW_SIGNALS } from './shadow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'ai-trading')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const RUNS_FILE = path.join(DATA_DIR, 'runs.json')
const SHADOW_FILE = path.join(DATA_DIR, 'shadow-signals.json')
export const MAX_STORED_RUNS = 50

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

// tmp + rename so a crash mid-write can never leave a truncated file behind.
async function writeJsonAtomic(file, value) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function getAiTradingConfig() {
  return normalizeAiTradingConfig(await readJson(CONFIG_FILE, null))
}

export async function saveAiTradingConfig(raw) {
  const config = normalizeAiTradingConfig(raw)
  await writeJsonAtomic(CONFIG_FILE, config)
  return config
}

export async function getAiTradingRuns() {
  const runs = await readJson(RUNS_FILE, [])
  return Array.isArray(runs) ? runs : []
}

// Serialised so two runs finishing together can't drop one another's entry.
let appendQueue = Promise.resolve()

export function appendAiTradingRun(run) {
  appendQueue = appendQueue
    .then(async () => {
      const runs = await getAiTradingRuns()
      await writeJsonAtomic(RUNS_FILE, [run, ...runs].slice(0, MAX_STORED_RUNS))
    })
    .catch((error) => {
      console.warn('[ai-trading] Failed to persist run:', error instanceof Error ? error.message : error)
    })
  return appendQueue
}

/** Merges `patch` into a stored run (used to record which trade a run was executed as). */
export function patchAiTradingRun(runId, patch) {
  appendQueue = appendQueue
    .then(async () => {
      const runs = await getAiTradingRuns()
      if (!runs.some((run) => run.id === runId)) return
      await writeJsonAtomic(RUNS_FILE, runs.map((run) => (run.id === runId ? { ...run, ...patch } : run)))
    })
    .catch((error) => {
      console.warn('[ai-trading] Failed to patch run:', error instanceof Error ? error.message : error)
    })
  return appendQueue
}

// ---- AI wallet ledger -------------------------------------------------------
// Trades opened from approved pipeline runs, in the same shape the bot
// trade-history uses (so the history table, journal calendar and account maths
// are shared) but in their own file: AI trades never mix into the bots' history.
const TRADES_FILE = path.join(DATA_DIR, 'trades.json')
export const MAX_STORED_AI_TRADES = 1000

export async function getAiTrades() {
  const trades = await readJson(TRADES_FILE, [])
  return Array.isArray(trades) ? trades : []
}

// Every read-modify-write goes through one queue so the open path, the monitor
// and a manual close can never overwrite each other's change.
let tradesQueue = Promise.resolve()

/** `mutate(currentTrades)` returns the next array, or undefined to leave the file untouched. */
export function updateAiTrades(mutate) {
  const result = tradesQueue.then(async () => {
    const current = await getAiTrades()
    const next = await mutate(current)
    if (!Array.isArray(next)) return current
    await writeJsonAtomic(TRADES_FILE, next.slice(0, MAX_STORED_AI_TRADES))
    return next
  })
  tradesQueue = result.catch(() => {})
  return result
}

// ---- Auto-scan status -------------------------------------------------------
// What the last scan cycles concluded per symbol, so the settings page can show it (and it survives a restart).
const SCAN_STATUS_FILE = path.join(DATA_DIR, 'scan-status.json')
const EMPTY_SCAN_STATUS = { running: false, lastStartedAt: null, lastFinishedAt: null, lastError: null, results: {} }

export async function getAiScanStatus() {
  const status = await readJson(SCAN_STATUS_FILE, null)
  return status && typeof status === 'object' && !Array.isArray(status) ? { ...EMPTY_SCAN_STATUS, ...status } : { ...EMPTY_SCAN_STATUS }
}

let scanStatusQueue = Promise.resolve()

/** `mutate(current)` returns the next status object. Serialised so overlapping updates cannot clobber each other. */
export function updateAiScanStatus(mutate) {
  const result = scanStatusQueue.then(async () => {
    const next = await mutate(await getAiScanStatus())
    await writeJsonAtomic(SCAN_STATUS_FILE, next)
    return next
  })
  scanStatusQueue = result.catch(() => {})
  return result
}

// ---- Auto-scan log ----------------------------------------------------------
// One light entry per symbol per scan cycle (including the Analyst HOLDs and errors that are not saved as runs), so
// Run History can show everything the scan did, not just the latest result per symbol. Capped; see mergeScanLog.
const SCAN_LOG_FILE = path.join(DATA_DIR, 'scan-log.json')

export async function getAiScanLog() {
  const log = await readJson(SCAN_LOG_FILE, [])
  return Array.isArray(log) ? log : []
}

let scanLogQueue = Promise.resolve()

/** `entries` are `{ at, symbol, outcome, detail, runId? }`, oldest first. Never throws: a log failure must not break a scan. */
export function appendAiScanLog(entries) {
  scanLogQueue = scanLogQueue
    .then(async () => {
      if (!entries.length) return
      await writeJsonAtomic(SCAN_LOG_FILE, mergeScanLog(await getAiScanLog(), entries))
    })
    .catch((error) => {
      console.warn('[ai-trading] Failed to persist scan log:', error instanceof Error ? error.message : error)
    })
  return scanLogQueue
}

// ---- Shadow outcome tracker (see shadow.js) ---------------------------------
// One small record per Analyst LONG/SHORT signal, whether or not a gate blocked it, kept far longer than the 50 saved runs so the gates can
// be judged on hundreds of samples. Newest first, capped.
export async function getShadowSignals() {
  const signals = await readJson(SHADOW_FILE, [])
  return Array.isArray(signals) ? signals : []
}

let shadowQueue = Promise.resolve()

/** `mutate(current)` returns the next array, or undefined for "no change". Serialised like the other stores. */
export function updateShadowSignals(mutate) {
  shadowQueue = shadowQueue
    .then(async () => {
      const current = await getShadowSignals()
      const next = mutate(current)
      if (next === undefined) return
      await writeJsonAtomic(SHADOW_FILE, [...next].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_SHADOW_SIGNALS))
    })
    .catch((error) => {
      console.warn('[ai-trading] Failed to persist shadow signals:', error instanceof Error ? error.message : error)
    })
  return shadowQueue
}

