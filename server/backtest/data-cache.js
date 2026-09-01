// Persistent historical-data cache for the backtest harness.
//
// Layout (under server/data/historical-cache/):
//   <SYMBOL>/<timeframe>/<YYYY-MM>.ndjson.gz   gzipped NDJSON, one kline row/line
//   <SYMBOL>/funding/<YYYY-MM>.ndjson.gz       gzipped NDJSON funding rows
//   <SYMBOL>/meta.json                         actual first/last candle per tf
//
// A month file for a fully-elapsed month is treated as immutable once written.
// The current (in-progress) month is always re-fetched. Binance klines never
// change retroactively, so this is safe and means a symbol is downloaded once.
//
// This module only ADDS a caching layer; the actual network fetch is still
// historical-data.js. Nothing here fabricates, interpolates or back-fills a
// missing candle — a gap in Binance's history stays a gap.

import path from 'node:path'
import fs from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { threadId } from 'node:worker_threads'

// Unique temp-file suffix — process.pid is shared across worker_threads, so a
// pid-only suffix collides when two workers write the same path concurrently.
const tmpSuffix = () => `tmp-${process.pid}-${threadId}-${randomBytes(6).toString('hex')}`
import {
  fetchHistoricalKlines,
  fetchFundingRateHistory,
  INTERVAL_MS,
} from './historical-data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = path.join(__dirname, '..', 'data', 'historical-cache')

const monthKey = (ms) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const monthStart = (y, m) => Date.UTC(y, m, 1)
const nowMonthKey = () => monthKey(Date.now())

function* monthRange(startMs, endMs) {
  const s = new Date(startMs)
  let y = s.getUTCFullYear()
  let m = s.getUTCMonth()
  const end = new Date(endMs)
  const ey = end.getUTCFullYear()
  const em = end.getUTCMonth()
  while (y < ey || (y === ey && m <= em)) {
    yield { y, m, key: `${y}-${String(m + 1).padStart(2, '0')}`, start: monthStart(y, m), end: monthStart(y, m + 1) - 1 }
    m += 1
    if (m > 11) { m = 0; y += 1 }
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function readGz(file) {
  try {
    const buf = await fs.readFile(file)
    const text = gunzipSync(buf).toString('utf8')
    if (!text.trim()) return []
    return text.trim().split('\n').map((line) => JSON.parse(line))
  } catch {
    return null // not cached
  }
}

// Windows can throw EPERM/EEXIST on rename-over-existing when another thread has
// the target open or AV is scanning it. Retry a few times, then fall back to a
// plain overwrite write.
async function atomicWrite(file, buf) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${tmpSuffix()}`
  await fs.writeFile(tmp, buf)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EEXIST' || err.code === 'EACCES') && attempt < 4) {
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
        continue
      }
      // last resort: overwrite in place, then drop the tmp
      try { await fs.writeFile(file, buf); await fs.rm(tmp, { force: true }); return } catch { throw err }
    }
  }
}

async function writeGz(file, rows) {
  const text = rows.map((r) => JSON.stringify(r)).join('\n')
  await atomicWrite(file, gzipSync(Buffer.from(text, 'utf8')))
}

async function updateMeta(symbol, patch) {
  const metaFile = path.join(CACHE_DIR, symbol, 'meta.json')
  let meta = {}
  try { meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) } catch { meta = {} }
  const next = { ...meta, ...patch, symbol, updatedAt: Date.now() }
  await atomicWrite(metaFile, Buffer.from(JSON.stringify(next, null, 2), 'utf8'))
  return next
}

export async function readMeta(symbol) {
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, symbol, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Cached klines for [startMs, endMs]. Fetches only the months not already on
 * disk (plus the current month). Returns raw Binance kline rows ascending,
 * de-duplicated by open time, clipped to the requested range.
 */
export async function getCachedKlines(symbol, timeframe, startMs, endMs, { onFetch, readOnly = false } = {}) {
  if (!INTERVAL_MS[timeframe]) throw new Error(`Unsupported interval: ${timeframe}`)
  const tfDir = path.join(CACHE_DIR, symbol, timeframe)
  const curMonth = nowMonthKey()
  const all = []
  const seen = new Set()

  for (const mo of monthRange(startMs, endMs)) {
    const file = path.join(tfDir, `${mo.key}.ndjson.gz`)
    let rows = mo.key === curMonth ? null : await readGz(file)
    if (rows == null) {
      if (onFetch) onFetch(symbol, timeframe, mo.key)
      const fetched = await fetchHistoricalKlines(symbol, timeframe, mo.start, Math.min(mo.end, endMs + INTERVAL_MS[timeframe]))
      rows = Array.isArray(fetched) ? fetched : []
      // Only persist elapsed months (current month is still growing). readOnly
      // callers (replay workers over a pre-warmed cache) never write.
      if (!readOnly && mo.key !== curMonth && rows.length > 0) await writeGz(file, rows)
    }
    for (const r of rows) {
      const ot = Number(r[0])
      if (ot < startMs || ot > endMs) continue
      if (seen.has(ot)) continue
      seen.add(ot)
      all.push(r)
    }
  }
  all.sort((a, b) => Number(a[0]) - Number(b[0]))

  if (!readOnly && all.length > 0) {
    const meta = (await readMeta(symbol)) || {}
    const tfMeta = meta.timeframes || {}
    tfMeta[timeframe] = {
      firstCandle: Number(all[0][0]),
      lastCandle: Number(all[all.length - 1][0]),
      firstCandleIso: new Date(Number(all[0][0])).toISOString(),
      lastCandleIso: new Date(Number(all[all.length - 1][0])).toISOString(),
      bars: all.length,
    }
    await updateMeta(symbol, { timeframes: tfMeta }).catch(() => {})
  }
  return all
}

/**
 * Cached funding-rate history for [startMs, endMs]. Same month-file scheme.
 * Missing funding history is best-effort — returns [] for a period with none,
 * never invents values.
 */
export async function getCachedFunding(symbol, startMs, endMs, { onFetch, readOnly = false } = {}) {
  const dir = path.join(CACHE_DIR, symbol, 'funding')
  const curMonth = nowMonthKey()
  const all = []
  const seen = new Set()

  for (const mo of monthRange(startMs, endMs)) {
    const file = path.join(dir, `${mo.key}.ndjson.gz`)
    let rows = mo.key === curMonth ? null : await readGz(file)
    if (rows == null) {
      if (onFetch) onFetch(symbol, 'funding', mo.key)
      const fetched = await fetchFundingRateHistory(symbol, mo.start, Math.min(mo.end, endMs))
      rows = Array.isArray(fetched) ? fetched : []
      if (!readOnly && mo.key !== curMonth) await writeGz(file, rows) // persist even if empty (marks "checked")
    }
    for (const r of rows) {
      const t = Number(r.fundingTime)
      if (t < startMs || t > endMs) continue
      if (seen.has(t)) continue
      seen.add(t)
      all.push({ fundingTime: t, fundingRate: Number(r.fundingRate || 0) })
    }
  }
  all.sort((a, b) => a.fundingTime - b.fundingTime)
  return all
}

/** Human-readable cache footprint for a symbol. */
export async function cacheStats(symbol) {
  const base = path.join(CACHE_DIR, symbol)
  let bytes = 0
  let files = 0
  async function walk(dir) {
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else { files += 1; bytes += (await fs.stat(p)).size }
    }
  }
  await walk(base)
  return { symbol, files, bytes, mb: Number((bytes / 1e6).toFixed(1)) }
}
