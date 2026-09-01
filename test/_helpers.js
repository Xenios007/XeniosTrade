// Shared synthetic-candle builders for the backtest test suites.

export function synthCandles(n, {
  base = 100, trend = 0, noise = 0.4, vol = 1000, seed = 1, step = 300_000,
} = {}) {
  // deterministic LCG so tests are reproducible
  let s = seed >>> 0
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
  const out = []
  let p = base
  for (let i = 0; i < n; i += 1) {
    p += trend + Math.sin(i / 9) * noise + (rnd() - 0.5) * noise
    const o = p
    const c = p + (rnd() - 0.5) * noise
    const hi = Math.max(o, c) + noise * 0.5
    const lo = Math.min(o, c) - noise * 0.5
    const v = vol * (0.7 + rnd() * 0.6)
    out.push({
      time: i * step,
      closeTime: i * step + step - 1,
      open: o, high: hi, low: lo, close: c, volume: v,
      takerBuyBaseVolume: v * 0.55,
      takerSellBaseVolume: v * 0.45,
      deltaVolume: v * 0.1,
    })
  }
  return out
}

// Raw Binance kline rows [openTime,o,h,l,c,v,closeTime,...]
export function synthRawKlines(n, opts = {}) {
  return synthCandles(n, opts).map((c) => [
    c.time, c.open, c.high, c.low, c.close, c.volume, c.closeTime,
    0, 0, c.takerBuyBaseVolume, 0, 0,
  ])
}
