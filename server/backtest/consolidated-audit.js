import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'

export async function* strictRows(file) {
  if (file.endsWith('.ndjson')) {
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    let line = 0
    for await (const text of lines) {
      line++
      if (!text.trim()) continue
      try { yield JSON.parse(text) } catch { throw new Error(`Invalid JSON: ${file}:${line}`) }
    }
  } else {
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    const rows = Array.isArray(data) ? data : data.rows || data.trades || data.items
    if (!Array.isArray(rows)) throw new Error(`Unrecognized row container: ${file}`)
    yield* rows
  }
}

export async function discoverSources(dataDir) {
  const root = path.join(dataDir, 'backtest-runs')
  const entries = await fs.readdir(root, { withFileTypes: true })
  const sources = [], directoryIds = new Set()
  for (const entry of entries.filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, entry.name)
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.ndjson') && !f.startsWith('_')).sort()
    if (files.length) {
      sources.push({ id: entry.name, files: files.map(f => path.join(dir, f)) })
      directoryIds.add(entry.name)
    }
  }
  for (const entry of entries.filter(e => e.isFile() && /\.(json|ndjson)$/.test(e.name))) {
    const id = entry.name.replace(/\.(json|ndjson)$/, '')
    if (!directoryIds.has(id)) sources.push({ id, files: [path.join(root, entry.name)] })
  }
  for (const name of ['backtest-history.json', 'backtest-moneystop.json']) {
    try { await fs.access(path.join(dataDir, name)); sources.push({ id: name, files: [path.join(dataDir, name)] }) } catch {}
  }
  return sources
}

export function summarize(rows) {
  let wins = 0, gain = 0, loss = 0, sum = 0, pnl = 0
  const days = new Map()
  for (const r of rows) {
    const v = r.r
    if (v > 0) { wins++; gain += v } else loss -= v
    sum += v; pnl += r.pnl || 0
    const day = new Date(r.t).toISOString().slice(0,10)
    const d = days.get(day) || [0,0]
    d[0] += v; d[1]++; days.set(day,d)
  }
  const n = rows.length, meanR = n ? sum/n : 0, g = days.size
  const se = n && g > 1 ? Math.sqrt(g/(g-1) * [...days.values()].reduce((s,[v,k]) => s+(v-k*meanR)**2,0))/n : null
  return { trades:n, wins, losses:n-wins, winRate:n ? wins/n : 0, meanR, totalR:sum,
    profitFactor:loss ? gain/loss : null, netPnl:pnl, days:g,
    lower95R:se === null ? null : meanR-1.96*se,
    upper95R:se === null ? null : meanR+1.96*se }
}
