// Historical market-data fetchers for the backtest harness.
// Self-contained (own fetch + backoff) so it does not disturb the live
// server's market-data cache / circuit breaker.

const SPOT_BASES = [
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.com/api/v3',
]
const FUTURES_BASE = 'https://fapi.binance.com'

export const INTERVAL_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJsonWithRetry(url, { retries = 4 } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (response.status === 429 || response.status === 418) {
          const wait = 2_000 * (attempt + 1) + Math.random() * 1_000
          await sleep(wait)
          continue
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${url}`)
        }
        return await response.json()
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await sleep(Math.round(400 * (2 ** attempt) * (1 + Math.random() * 0.4)))
      }
    }
  }
  throw lastError
}

async function fetchKlinePage(symbol, interval, startTime, endTime) {
  let lastError = null
  for (const base of SPOT_BASES) {
    try {
      const url = `${base}/klines?symbol=${symbol}&interval=${interval}&limit=1000`
        + `&startTime=${startTime}&endTime=${endTime}`
      return await fetchJsonWithRetry(url)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * Pull a full [startMs, endMs] range of klines, paginating 1000 at a time.
 * Returns raw Binance kline arrays ([openTime, o, h, l, c, v, closeTime, ...]),
 * ascending, de-duplicated by open time.
 */
export async function fetchHistoricalKlines(symbol, interval, startMs, endMs, { onProgress } = {}) {
  const step = INTERVAL_MS[interval]
  if (!step) throw new Error(`Unsupported interval: ${interval}`)

  const out = []
  let cursor = startMs
  const seen = new Set()

  while (cursor < endMs) {
    const pageEnd = Math.min(cursor + step * 1000, endMs)
    const page = await fetchKlinePage(symbol, interval, cursor, pageEnd)
    if (!Array.isArray(page) || page.length === 0) {
      cursor = pageEnd + 1
      continue
    }
    for (const row of page) {
      const openTime = Number(row[0])
      if (seen.has(openTime)) continue
      seen.add(openTime)
      out.push(row)
    }
    const lastOpen = Number(page[page.length - 1][0])
    cursor = lastOpen + step
    if (onProgress) onProgress(out.length, symbol, interval)
    await sleep(120) // gentle pacing
  }

  out.sort((a, b) => Number(a[0]) - Number(b[0]))
  return out
}

/**
 * Funding-rate history for a symbol as [{ fundingTime, fundingRate }] ascending.
 * Funding posts every 8h; the harness picks the most recent entry <= a given
 * bar time as the marketContext fundingRate.
 */
export async function fetchFundingRateHistory(symbol, startMs, endMs) {
  const out = []
  let cursor = startMs
  const seen = new Set()

  while (cursor < endMs) {
    const url = `${FUTURES_BASE}/fapi/v1/fundingRate?symbol=${symbol}`
      + `&startTime=${cursor}&endTime=${endMs}&limit=1000`
    let page = []
    try {
      page = await fetchJsonWithRetry(url)
    } catch {
      break // funding history is best-effort; missing → neutral context
    }
    if (!Array.isArray(page) || page.length === 0) break
    for (const row of page) {
      const t = Number(row.fundingTime)
      if (seen.has(t)) continue
      seen.add(t)
      out.push({ fundingTime: t, fundingRate: Number(row.fundingRate || 0) })
    }
    const lastTime = Number(page[page.length - 1].fundingTime)
    if (!Number.isFinite(lastTime) || lastTime <= cursor) break
    cursor = lastTime + 1
    await sleep(120)
  }

  out.sort((a, b) => a.fundingTime - b.fundingTime)
  return out
}

/** Most recent funding rate at or before `timeMs` (0 if none). */
export function fundingRateAt(fundingHistory, timeMs) {
  let value = 0
  for (const entry of fundingHistory) {
    if (entry.fundingTime <= timeMs) value = entry.fundingRate
    else break
  }
  return value
}
