// Pre-download + cache the historical data the 8-bot 5-year run needs, so the
// replay itself never blocks on the network and we can see the genuine history
// window for every symbol up front. Safe to re-run — months already on disk are
// not re-fetched. Nothing is fabricated: a symbol that listed in 2023 simply
// gets 2023-onward.
//
//   node server/backtest/warm-cache.js --months 60 --concurrency 3
//
// Writes server/data/historical-cache/<SYMBOL>/meta.json per symbol and a
// server/data/historical-cache/_summary.json roll-up.

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { BACKTEST_UNIVERSE, isExtendedBacktestSymbol } from '../../src/lib/tradingConfig.js'
import { getCachedKlines, getCachedFunding, readMeta, cacheStats, CACHE_DIR } from './data-cache.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) a[k] = true
      else { a[k] = v; i += 1 }
    }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const MONTHS = Number(args.months || 60)
const CONCURRENCY = Math.min(4, Math.max(1, Number(args.concurrency || 3)))
const TIMEFRAMES = ['1h', '15m', '5m']
// BTC + ETH are needed as market context for every altcoin sample.
const SYMBOLS = Array.from(new Set(['BTCUSDT', 'ETHUSDT', ...BACKTEST_UNIVERSE]))

const endMs = Date.now()
const startMs = endMs - MONTHS * 30 * 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)

async function warmSymbol(symbol) {
  const t0 = Date.now()
  const perTf = {}
  for (const tf of TIMEFRAMES) {
    let fetched = 0
    const rows = await getCachedKlines(symbol, tf, startMs, endMs, {
      onFetch: () => { fetched += 1 },
    })
    perTf[tf] = { bars: rows.length, monthsFetched: fetched }
  }
  let fundingCount = 0
  try {
    const f = await getCachedFunding(symbol, startMs, endMs, { onFetch: () => { fundingCount += 1 } })
    perTf.funding = { entries: f.length, monthsFetched: fundingCount }
  } catch (e) {
    perTf.funding = { entries: 0, error: String(e?.message || e) }
  }
  const meta = await readMeta(symbol)
  const stats = await cacheStats(symbol)
  const e5 = meta?.timeframes?.['5m']
  console.log(
    `  ${symbol.padEnd(12)} 5m ${String(perTf['5m'].bars).padStart(7)} bars  `
    + `${e5 ? `${e5.firstCandleIso.slice(0, 10)}→${e5.lastCandleIso.slice(0, 10)}` : 'n/a'}  `
    + `${stats.mb} MB  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  )
  return {
    symbol,
    isExtended: isExtendedBacktestSymbol(symbol),
    historyStart: e5?.firstCandleIso || null,
    historyEnd: e5?.lastCandleIso || null,
    fiveMinBars: perTf['5m'].bars,
    monthsOfHistory: e5 ? Number(((e5.lastCandle - e5.firstCandle) / (30 * 86_400_000)).toFixed(1)) : 0,
    perTimeframe: perTf,
    cacheMb: stats.mb,
  }
}

async function pool(items, worker, size) {
  const out = new Array(items.length)
  let c = 0
  async function next() {
    const i = c
    c += 1
    if (i >= items.length) return
    try { out[i] = await worker(items[i]) } catch (e) { out[i] = { symbol: items[i], error: String(e?.message || e) } }
    await next()
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next))
  return out
}

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true })
  console.log(`=== warm-cache: ${SYMBOLS.length} symbols, ${MONTHS} mo, tf ${TIMEFRAMES.join('/')} + funding, concurrency ${CONCURRENCY} ===`)
  console.log(`range requested: ${iso(startMs)} → ${iso(endMs)}\n`)
  const t0 = Date.now()
  const results = await pool(SYMBOLS, warmSymbol, CONCURRENCY)

  const summary = {
    generatedAt: Date.now(),
    monthsRequested: MONTHS,
    rangeRequested: { start: iso(startMs), end: iso(endMs) },
    timeframes: TIMEFRAMES,
    symbols: results,
    totalCacheMb: Number(results.reduce((s, r) => s + (r.cacheMb || 0), 0).toFixed(1)),
    elapsedSeconds: Math.round((Date.now() - t0) / 1000),
  }
  await fs.writeFile(path.join(CACHE_DIR, '_summary.json'), JSON.stringify(summary, null, 2))

  console.log('\n=== actual history per symbol ===')
  for (const r of results) {
    if (r.error) { console.log(`  ${r.symbol}: ERROR ${r.error}`); continue }
    console.log(`  ${r.symbol.padEnd(12)} ${String(r.monthsOfHistory).padStart(5)} mo  ${r.historyStart?.slice(0, 10)} → ${r.historyEnd?.slice(0, 10)}  ${r.isExtended ? '(extended)' : '(core)'}`)
  }
  console.log(`\ntotal cache: ${summary.totalCacheMb} MB   elapsed: ${summary.elapsedSeconds}s`)
  console.log(`summary → ${path.join(CACHE_DIR, '_summary.json')}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('warm-cache failed:', e); process.exit(1) })
