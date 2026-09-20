import { useCallback, useEffect, useRef, useState } from 'react'

export async function requestJson(url, options) {
  const response = await fetch(url, options)
  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Expected JSON but received: ${text.slice(0, 120)}`)
  }
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
  return payload
}

export function postJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/**
 * The AI wallets' ledger: trades, wallet numbers, journal data and live prices for open positions.
 * Polls while the page is mounted; `refresh({ sync: true })` also forces a fresh exchange balance read.
 */
export function useAiLedger({ pollMs = 10_000 } = {}) {
  const [ledger, setLedger] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)

  const refresh = useCallback(async ({ sync = false } = {}) => {
    try {
      const payload = await requestJson(`/api/ai-trading/ledger${sync ? '?sync=1' : ''}`)
      if (alive.current) {
        setLedger(payload)
        setError('')
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : 'Could not load the AI ledger.')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    refresh()
    const timer = pollMs > 0 ? setInterval(refresh, pollMs) : null
    return () => {
      alive.current = false
      if (timer) clearInterval(timer)
    }
  }, [refresh, pollMs])

  return { ledger, error, loading, refresh }
}

export const MODE_LABEL = { testnet: 'Testnet', real: 'Real money' }
