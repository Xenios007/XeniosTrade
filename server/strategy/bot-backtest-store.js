// On-disk state for Bot Trading backtests: one subtree per run (status + simulated trades),
// plus a small shared index. Same run-registry.js-style pattern as
// server/ai-trading/backtest-store.js (one small shared index + one subtree per entity id) -
// kept as its own file rather than a shared import so the two backtest features (LLM-based AI
// Trading vs. indicator-based Bot Trading) stay fully independent on disk.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'bot-backtest')
const INDEX_FILE = path.join(DATA_DIR, 'index.json')
const runDir = (runId) => path.join(DATA_DIR, runId)

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function listBotBacktestRuns() {
  const index = await readJson(INDEX_FILE, [])
  return Array.isArray(index) ? index : []
}

export async function getBotBacktestStatus(runId) {
  return readJson(path.join(runDir(runId), 'status.json'), null)
}

export async function getBotBacktestTrades(runId) {
  const trades = await readJson(path.join(runDir(runId), 'trades.json'), [])
  return Array.isArray(trades) ? trades : []
}

export async function saveBotBacktestStatus(runId, status) {
  await writeJsonAtomic(path.join(runDir(runId), 'status.json'), status)
  const index = await listBotBacktestRuns()
  const summary = {
    id: runId,
    bots: status.bots,
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

export async function saveBotBacktestTrades(runId, trades) {
  await writeJsonAtomic(path.join(runDir(runId), 'trades.json'), trades)
  return trades
}

export async function deleteBotBacktestRun(runId) {
  await fs.rm(runDir(runId), { recursive: true, force: true })
  const index = await listBotBacktestRuns()
  await writeJsonAtomic(INDEX_FILE, index.filter((item) => item.id !== runId))
}
