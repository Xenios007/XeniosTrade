function round(value, precision = 6) {
  return Number(value.toFixed(precision))
}

export function calculateSMA(data, period) {
  let sum = 0

  return data.reduce((result, item, index) => {
    sum += item.close

    if (index >= period) {
      sum -= data[index - period].close
    }

    if (index >= period - 1) {
      result.push({
        time: item.time,
        value: round(sum / period),
      })
    }

    return result
  }, [])
}

export function calculateEMA(data, period) {
  const multiplier = 2 / (period + 1)
  let ema = 0

  return data.reduce((result, item, index) => {
    if (index === period - 1) {
      const seed = data.slice(0, period).reduce((sum, point) => sum + point.close, 0) / period
      ema = seed
      result.push({ time: item.time, value: round(ema) })
      return result
    }

    if (index >= period) {
      ema = (item.close - ema) * multiplier + ema
      result.push({ time: item.time, value: round(ema) })
    }

    return result
  }, [])
}

export function calculateVWAP(data) {
  let cumulativePriceVolume = 0
  let cumulativeVolume = 0

  return data.reduce((result, item) => {
    const volume = Number(item.volume || 0)
    const typicalPrice = (Number(item.high || 0) + Number(item.low || 0) + Number(item.close || 0)) / 3
    cumulativePriceVolume += typicalPrice * volume
    cumulativeVolume += volume

    result.push({
      time: item.time,
      value: round(cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : typicalPrice),
    })

    return result
  }, [])
}

export function calculateBollingerBands(data, period = 20, multiplier = 2) {
  const basis = calculateSMA(data, period)

  const lookup = new Map(
    basis.map((entry) => [entry.time, entry.value]),
  )

  const upper = []
  const lower = []

  for (let index = period - 1; index < data.length; index += 1) {
    const slice = data.slice(index - period + 1, index + 1)
    const mean = lookup.get(data[index].time)
    const variance = slice.reduce((sum, item) => sum + (item.close - mean) ** 2, 0) / period
    const deviation = Math.sqrt(variance)

    upper.push({
      time: data[index].time,
      value: round(mean + deviation * multiplier),
    })

    lower.push({
      time: data[index].time,
      value: round(mean - deviation * multiplier),
    })
  }

  return {
    basis,
    upper,
    lower,
  }
}

export function calculateRSI(data, period = 14) {
  if (data.length <= period) {
    return []
  }

  let avgGain = 0
  let avgLoss = 0
  const result = []

  for (let index = 1; index <= period; index += 1) {
    const change = data[index].close - data[index - 1].close
    avgGain += Math.max(change, 0)
    avgLoss += Math.max(-change, 0)
  }

  avgGain /= period
  avgLoss /= period

  const firstValue = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  result.push({
    time: data[period].time,
    value: round(firstValue, 2),
  })

  for (let index = period + 1; index < data.length; index += 1) {
    const change = data[index].close - data[index - 1].close
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)

    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period

    const value = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

    result.push({
      time: data[index].time,
      value: round(value, 2),
    })
  }

  return result
}

export function calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = calculateEMA(data, fastPeriod)
  const slow = calculateEMA(data, slowPeriod)
  const slowLookup = new Map(slow.map((entry) => [entry.time, entry.value]))

  const macdLine = fast.reduce((result, entry) => {
    const slowValue = slowLookup.get(entry.time)

    if (slowValue !== undefined) {
      result.push({
        time: entry.time,
        value: round(entry.value - slowValue),
      })
    }

    return result
  }, [])

  let signalEma = 0
  const signalLine = []

  macdLine.forEach((entry, index) => {
    if (index === signalPeriod - 1) {
      signalEma = macdLine.slice(0, signalPeriod).reduce((sum, item) => sum + item.value, 0) / signalPeriod
      signalLine.push({ time: entry.time, value: round(signalEma) })
      return
    }

    if (index >= signalPeriod) {
      const multiplier = 2 / (signalPeriod + 1)
      signalEma = (entry.value - signalEma) * multiplier + signalEma
      signalLine.push({ time: entry.time, value: round(signalEma) })
    }
  })

  const signalLookup = new Map(signalLine.map((entry) => [entry.time, entry.value]))
  const histogram = macdLine.reduce((result, entry) => {
    const signalValue = signalLookup.get(entry.time)

    if (signalValue !== undefined) {
      result.push({
        time: entry.time,
        value: round(entry.value - signalValue),
      })
    }

    return result
  }, [])

  return {
    macdLine,
    signalLine,
    histogram,
  }
}
