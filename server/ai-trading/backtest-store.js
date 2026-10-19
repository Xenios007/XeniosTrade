// On-disk state for AI Trading backtests: one subtree per run (status + simulated trades), plus a small shared
// index - the same run-registry.js pattern the bot backtest harness already uses (one small shared index + one
// subtree per entity id).

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'ai-trading-backtest')
const INDEX_FILE = path.join(DATA_DIR, 'index.json')
const runDir = (runId) => path.join(DATA_DIR, runId)

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

// tmp + rename so a crash mid-write can never leave a truncated file behind.
async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function listAiBacktestRuns() {
  const index = await readJson(INDEX_FILE, [])
  return Array.isArray(index) ? index : []
}

export async function getAiBacktestStatus(runId) {
  return readJson(path.join(runDir(runId), 'status.json'), null)
}

export async function getAiBacktestTrades(runId) {
  const trades = await readJson(path.join(runDir(runId), 'trades.json'), [])
  return Array.isArray(trades) ? trades : []
}

/** Saves the run's status and keeps the shared index's summary row for it in sync. */
export async function saveAiBacktestStatus(runId, status) {
  await writeJsonAtomic(path.join(runDir(runId), 'status.json'), status)
  const index = await listAiBacktestRuns()
  const summary = {
    id: runId,
    symbols: status.symbols,
    startMs: status.startMs,
    endMs: status.endMs,
    state: status.state,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt ?? null,
  }
  await writeJsonAtomic(INDEX_FILE, [summary, ...index.filter((item) => item.id !== runId)])
  return status
}

export async function saveAiBacktestTrades(runId, trades) {
  await writeJsonAtomic(path.join(runDir(runId), 'trades.json'), trades)
  return trades
}

export async function deleteAiBacktestRun(runId) {
  await fs.rm(runDir(runId), { recursive: true, force: true })
  const index = await listAiBacktestRuns()
  await writeJsonAtomic(INDEX_FILE, index.filter((item) => item.id !== runId))
}
