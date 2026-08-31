// Backtest run registry — a durable index of every replay-dataset.js run.
//
// Each run gets:
//   - one entry in  server/data/backtest-runs.json  (this file's registry array)
//   - one row-data file  server/data/backtest-runs/<id>.json  (the closed trades)
//   - one human report   server/backtest/runs/<id>.md
//
// The live server reads the registry to render the AI Training → Backtests panel
// and to merge only the runs flagged `includeInTraining: true` into the training
// dataset. This module imports nothing from the server so the harness can use it
// without booting the HTTP listener.

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const dataDir = path.join(here, '..', 'data')
export const REGISTRY_PATH = path.join(dataDir, 'backtest-runs.json')
export const RUNS_DATA_DIR = path.join(dataDir, 'backtest-runs')
export const RUNS_MD_DIR = path.join(here, 'runs')

async function ensureDirs() {
  await fs.mkdir(RUNS_DATA_DIR, { recursive: true })
  await fs.mkdir(RUNS_MD_DIR, { recursive: true })
}

export async function readRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8')
    if (!raw.trim()) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    if (error instanceof SyntaxError) return []
    throw error
  }
}

async function writeRegistryAtomic(runs) {
  await ensureDirs()
  const tmp = `${REGISTRY_PATH}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(runs, null, 2))
  await fs.rename(tmp, REGISTRY_PATH)
}

// Shallow-merge `entry` onto any existing run with the same id (so a progress
// tick from the harness never clobbers server-set fields like includeInTraining
// or conclusion), else prepend. Registry stays newest-first by startedAt.
export async function upsertRun(entry) {
  if (!entry || !entry.id) throw new Error('upsertRun: entry.id is required')
  const runs = await readRegistry()
  const idx = runs.findIndex((r) => r && r.id === entry.id)
  if (idx >= 0) {
    runs[idx] = { ...runs[idx], ...entry, updatedAt: Date.now() }
  } else {
    runs.unshift({ ...entry, updatedAt: Date.now() })
  }
  runs.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))
  await writeRegistryAtomic(runs)
  return runs[runs.findIndex((r) => r.id === entry.id)]
}

// Apply a partial update to one run. Returns the updated entry or null.
export async function patchRun(id, patch) {
  const runs = await readRegistry()
  const idx = runs.findIndex((r) => r && r.id === id)
  if (idx < 0) return null
  const allowed = {}
  if (typeof patch.includeInTraining === 'boolean') allowed.includeInTraining = patch.includeInTraining
  if (typeof patch.conclusion === 'string') allowed.conclusion = patch.conclusion
  if (typeof patch.label === 'string') allowed.label = patch.label
  runs[idx] = { ...runs[idx], ...allowed, updatedAt: Date.now() }
  await writeRegistryAtomic(runs)
  return runs[idx]
}

function fmtRow(cells, widths) {
  return `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`
}

export function renderRunMarkdown(entry = {}) {
  const cfg = entry.config || {}
  const perBot = entry.summary?.perBot || []
  const started = entry.startedAt ? new Date(entry.startedAt).toISOString() : '—'
  const finished = entry.finishedAt ? new Date(entry.finishedAt).toISOString() : '—'
  const lines = []
  lines.push(`# Backtest run — ${entry.label || entry.id}`)
  lines.push('')
  lines.push(`- **Run id:** \`${entry.id}\``)
  lines.push(`- **Status:** ${entry.status || 'unknown'}`)
  lines.push(`- **Started:** ${started}`)
  lines.push(`- **Finished:** ${finished}`)
  lines.push(`- **Rows written:** ${entry.summary?.totalRows ?? '—'}`)
  lines.push(`- **Data file:** \`${entry.dataFile || '—'}\``)
  lines.push(`- **Include in AI training:** ${entry.includeInTraining ? 'YES' : 'no'}`)
  lines.push('')
  lines.push('## Config')
  lines.push('')
  lines.push('```')
  lines.push(`months           : ${cfg.months}`)
  lines.push(`step / stride     : ${cfg.step} / ${cfg.stride}`)
  lines.push(`bots             : ${(cfg.bots || []).join(', ')}`)
  lines.push(`symbols          : ${cfg.symbolCount}`)
  lines.push(`cap/(symbol,bot) : ${cfg.capPerSymbolBot}`)
  lines.push(`friction         : ${cfg.feeBps} + ${cfg.slippageBps} bps/side x2`)
  lines.push(`max hold hours   : ${cfg.maxHoldHours}`)
  lines.push(`money stop USD   : ${cfg.moneyStopUsd || 0}`)
  lines.push(`context          : ${cfg.strictContext ? 'strict/zero' : 'proxied'}`)
  lines.push('```')
  lines.push('')
  lines.push('## Signals used')
  lines.push('')
  for (const s of entry.signalsUsed || []) lines.push(`- ${s}`)
  lines.push('')
  lines.push('## Result by bot')
  lines.push('')
  const widths = [8, 7, 7, 14, 11, 10, 10]
  lines.push(fmtRow(['Bot', 'Rows', 'Win %', 'Total USDT', 'Avg/trade', 'BUY win%', 'SELL win%'], widths))
  lines.push(fmtRow(widths.map((w) => '-'.repeat(w)), widths))
  for (const b of perBot) {
    lines.push(fmtRow([
      b.botId,
      b.rows,
      b.winRate?.toFixed(1) ?? '—',
      b.totalUsd?.toFixed(2) ?? '—',
      b.avgPerTrade?.toFixed(3) ?? '—',
      b.buy?.winRate?.toFixed(1) ?? '—',
      b.sell?.winRate?.toFixed(1) ?? '—',
    ], widths))
  }
  lines.push('')
  lines.push('## Conclusion')
  lines.push('')
  lines.push(entry.conclusion ? entry.conclusion : '_(none recorded yet)_')
  lines.push('')
  return lines.join('\n')
}

export async function writeRunMarkdown(entry) {
  await ensureDirs()
  const file = path.join(RUNS_MD_DIR, `${entry.id}.md`)
  await fs.writeFile(file, renderRunMarkdown(entry))
  return file
}
