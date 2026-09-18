// In-memory mirror of settings.aiProviderCredentials (src/lib/aiProviders.js),
// so bot-claude.js / bot-gpt.js / bot-gemini.js / bot-grok.js / bot-openrouter.js
// can read the UI-configured key/baseUrl/model synchronously without each one
// awaiting the async settings file on every call. mock-trading-server.js
// calls setAiProviderCredentialsStore() every time it loads settings
// (getSettings() is the single choke point - see its final lines), so this
// is at most one settings-read cycle stale.

import { normalizeAiProviderCredentials } from '../../src/lib/aiProviders.js'

let store = {}

export function setAiProviderCredentialsStore(map) {
  store = normalizeAiProviderCredentials(map)
}

/** Returns { apiKey, baseUrl, model } for a provider, or null if never configured. */
export function getAiProviderCredential(providerId) {
  return store[providerId] || null
}
