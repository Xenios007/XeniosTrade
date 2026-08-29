const BASE_URL = 'https://data-api.binance.vision/api/v3'

async function fetchJson(path) {
  const response = await fetch(`${BASE_URL}${path}`)

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  return response.json()
}

async function readAppJson(response) {
  const text = await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    const compactBody = text.replace(/\s+/g, ' ').trim().slice(0, 180)
    const contentType = response.headers.get('content-type') || 'unknown content type'
    throw new Error(`Expected JSON but received ${contentType}: ${compactBody}`)
  }
}

async function fetchAppJson(path) {
  const response = await fetch(path)

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  return readAppJson(response)
}

export function getVolatileMarkets() {
  return fetchAppJson('/api/volatile-markets')
}

export function getLearningBotSummary() {
  return fetchAppJson('/api/learning-bot/summary')
}

export function getLearningBotDataset() {
  return fetchAppJson('/api/learning-bot/dataset')
}

export function getLearningBotTrainStatus() {
  return fetchAppJson('/api/learning-bot/train-status')
}

export async function startLearningBotTraining() {
  const response = await fetch('/api/learning-bot/train', {
    method: 'POST',
  })
  const payload = await readAppJson(response)

  if (!response.ok) {
    throw new Error(payload.error || 'Unable to start learning bot training')
  }

  return payload
}

export function getSignalModelAnalysis(symbol, modelId) {
  const params = new URLSearchParams({
    symbol,
    modelId,
  })

  return fetchAppJson(`/api/signal-model-analysis?${params.toString()}`)
}

export function getKlines(symbol, interval = '15m', limit = 120) {
  return fetchJson(`/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
}

export function getOrderBook(symbol, limit = 12) {
  return fetchJson(`/depth?symbol=${symbol}&limit=${limit}`)
}

export function getRecentTrades(symbol, limit = 14) {
  return fetchJson(`/trades?symbol=${symbol}&limit=${limit}`)
}
