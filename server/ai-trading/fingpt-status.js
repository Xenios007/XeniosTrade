// Readiness of a local model server (server/local-llm/server.py for FinGPT, server/local-llm/finma-server.py for
// FinMA), shaped like the Codex / Claude login status so the UI's `isLocalLoginReady` treats it the same way:
// `available` = the process answers, `loggedIn` = the model finished loading.

import { getAiProvider } from '../../src/lib/aiProviders.js'
import { getAiProviderCredential } from '../strategy/ai-provider-credentials-store.js'

export const FINGPT_PROVIDER_ID = 'fingpt'
export const FINMA_PROVIDER_ID = 'finma'
const STATUS_TIMEOUT_MS = 1500

export async function getLocalLlmStatus(providerId, { fetchImpl = fetch } = {}) {
  const baseUrl = String(getAiProviderCredential(providerId)?.baseUrl || getAiProvider(providerId).baseUrl).replace(/\/+$/, '')
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
    const payload = await response.json()
    return { available: true, loggedIn: payload?.status === 'ready', status: payload?.status || 'unknown', error: payload?.error || '' }
  } catch {
    return { available: false, loggedIn: false, status: 'offline', error: '' }
  }
}

export async function getFingptStatus(options) {
  return getLocalLlmStatus(FINGPT_PROVIDER_ID, options)
}

export async function getFinmaStatus(options) {
  return getLocalLlmStatus(FINMA_PROVIDER_ID, options)
}
