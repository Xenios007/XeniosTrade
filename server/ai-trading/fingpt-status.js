// Readiness of the local FinGPT server (server/local-llm/server.py), shaped like the Codex / Claude login status so the
// UI's `isLocalLoginReady` treats it the same way: `available` = the process answers, `loggedIn` = the model finished loading.

import { getAiProvider } from '../../src/lib/aiProviders.js'
import { getAiProviderCredential } from '../strategy/ai-provider-credentials-store.js'

export const FINGPT_PROVIDER_ID = 'fingpt'
const STATUS_TIMEOUT_MS = 1500

export async function getFingptStatus({ fetchImpl = fetch } = {}) {
  const baseUrl = String(getAiProviderCredential(FINGPT_PROVIDER_ID)?.baseUrl || getAiProvider(FINGPT_PROVIDER_ID).baseUrl).replace(/\/+$/, '')
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
    const payload = await response.json()
    return { available: true, loggedIn: payload?.status === 'ready', status: payload?.status || 'unknown', error: payload?.error || '' }
  } catch {
    return { available: false, loggedIn: false, status: 'offline', error: '' }
  }
}
