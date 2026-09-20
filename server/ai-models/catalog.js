// "Browse Models": what each provider in src/lib/aiProviders.js can actually run.
//
//  - Connected providers are asked for their live model list with the key the
//    AI Models page already holds (the key never leaves the server).
//  - OpenRouter's public catalog needs no key at all, and carries pricing, so it
//    is always listed live — including its free models, which is what makes it
//    handy for testing the pipeline at no cost.
//  - Anything unconnected, unlistable (Azure/Bedrock/Vertex) or failing falls back
//    to the static `suggested` models in the provider catalog, clearly labelled.

import crypto from 'node:crypto'
import { AI_PROVIDERS, getAiProvider, isProviderConnected } from '../../src/lib/aiProviders.js'
import { redactSecrets } from '../ai-trading/llm.js'

export const CATALOG_TTL_MS = 10 * 60 * 1000
const LIST_TIMEOUT_MS = 12_000

// Providers whose list endpoint is not the OpenAI-compatible `GET {base}/models`, or that have none.
const NOT_LISTABLE = new Set(['azure-openai', 'bedrock', 'vertex'])

// Ids that are clearly not chat/completion models — hidden unless the user asks.
const NON_CHAT_PATTERN = /embed|whisper|tts|dall-e|imagen|image|moderation|transcribe|audio|realtime|rerank|lyria|veo|omni-moderation|speech|sora/i

const perMillion = (perTokenPrice) => {
  const price = Number(perTokenPrice)
  return Number.isFinite(price) && price >= 0 ? Number((price * 1e6).toFixed(4)) : null
}

const contextLabel = (tokens) => (Number.isFinite(tokens) && tokens > 0 ? tokens : null)

/** OpenRouter's public `/models` payload -> normalized rows. */
export function normalizeOpenRouterModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.filter((row) => row?.id).map((row) => {
    const promptPrice = perMillion(row.pricing?.prompt)
    const completionPrice = perMillion(row.pricing?.completion)
    const inputs = row.architecture?.input_modalities || []
    const outputs = row.architecture?.output_modalities || []
    const params = row.supported_parameters || []
    const free = (promptPrice === 0 && completionPrice === 0) || String(row.id).endsWith(':free')

    return {
      id: row.id,
      name: row.name || row.id,
      providerId: 'openrouter',
      description: String(row.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      contextLength: contextLabel(Number(row.context_length)),
      pricePerMillion: promptPrice == null && completionPrice == null ? null : { input: promptPrice, output: completionPrice },
      free,
      // Chat only when text comes out and nothing exotic (audio/image generation) is the point of the model.
      kind: outputs.includes('text') && !outputs.includes('audio') && !(outputs.includes('image') && !inputs.includes('image')) ? 'chat' : 'other',
      vision: inputs.includes('image'),
      jsonMode: params.includes('response_format') || params.includes('structured_outputs'),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      created: Number(row.created) > 0 ? Number(row.created) * 1000 : null,
    }
  })
}

/** OpenAI-compatible `GET {base}/models` (also Google's compat layer, xAI, Groq, Together, Ollama...). */
export function normalizeOpenAiCompatibleModels(payload, providerId) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return rows.filter((row) => row?.id).map((row) => {
    // Google prefixes ids with "models/"; the chat endpoint wants the bare name.
    const id = String(row.id).replace(/^models\//, '')
    return {
      id,
      name: row.display_name || row.name || id,
      providerId,
      description: '',
      contextLength: contextLabel(Number(row.context_length ?? row.context_window ?? row.inputTokenLimit)),
      pricePerMillion: null,
      free: false,
      kind: NON_CHAT_PATTERN.test(id) ? 'other' : 'chat',
      vision: false,
      jsonMode: null, // unknown from the list; the Test button finds out for real
      reasoning: false,
      created: Number(row.created) > 0 ? Number(row.created) * 1000 : null,
    }
  })
}

/** Anthropic `GET /v1/models`. */
export function normalizeAnthropicModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.filter((row) => row?.id).map((row) => ({
    id: row.id,
    name: row.display_name || row.id,
    providerId: 'anthropic',
    description: '',
    contextLength: null,
    pricePerMillion: null,
    free: false,
    kind: 'chat',
    vision: true,
    jsonMode: null,
    reasoning: false,
    created: row.created_at ? Date.parse(row.created_at) || null : null,
  }))
}

/** A key pasted into the wrong provider slot is the most common setup mistake; say so instead of just "invalid key". */
export function misplacedKeyHint(providerId, apiKey) {
  const key = String(apiKey || '')
  const owner = key.startsWith('sk-or-') ? 'openrouter' : key.startsWith('sk-ant-') ? 'anthropic' : /^AIza/.test(key) ? 'google' : null
  const target = owner && owner !== providerId ? getAiProvider(owner) : null
  return target ? ` This looks like ${/^[aeiou]/i.test(target.label) ? 'an' : 'a'} ${target.label} key — save it under ${target.label} on Providers & Keys.` : ''
}

/** The static suggestions from the provider catalog, shown when a live list is not possible. */
export function suggestedModels(provider) {
  return (provider.suggested || []).map((id) => ({
    id,
    name: id,
    providerId: provider.id,
    description: '',
    contextLength: null,
    pricePerMillion: null,
    free: false,
    kind: 'chat',
    vision: false,
    jsonMode: null,
    reasoning: false,
    created: null,
  }))
}

async function getJson(url, headers) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { raw: text }
    }
    if (!response.ok) {
      const message = payload?.error?.message || payload?.[0]?.error?.message || payload?.message || payload?.raw?.slice?.(0, 160)
      throw new Error(redactSecrets(message || `HTTP ${response.status}`))
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Timed out after ${Math.round(LIST_TIMEOUT_MS / 1000)}s.`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

const cache = new Map()
export const clearCatalogCache = () => cache.clear()

// A rotated key or edited base URL must not serve the old key's list from cache.
const cacheKeyFor = (providerId, apiKey, baseUrl) =>
  `${providerId}:${crypto.createHash('sha1').update(`${apiKey}|${baseUrl}`).digest('hex').slice(0, 12)}`

/**
 * @param {string} providerId
 * @param {{ apiKey?: string, baseUrl?: string } | null} credential  from the AI Models credential mirror
 * @returns {Promise<{ providerId, label, connected, source: 'live'|'catalog', error: string|null, models: object[], fetchedAt: number }>}
 */
export async function listProviderModels(providerId, credential, { now = Date.now, force = false } = {}) {
  const provider = getAiProvider(providerId)
  if (!provider) throw new Error(`Unknown provider "${providerId}".`)

  const apiKey = String(credential?.apiKey || '').trim()
  const baseUrl = String(credential?.baseUrl || provider.baseUrl || '').trim().replace(/\/+$/, '')
  // Same rule as the Providers & Keys page: a keyless local server only counts once its URL is saved, not
  // because the catalog carries a default localhost address.
  // A `localServer` provider (FinGPT) is built in: its URL is a fixed default, so it is always asked, and an offline
  // process shows up as the "Could not list models" fallback below.
  const connected = provider.localServer ? true : isProviderConnected(provider, credential, Boolean(apiKey))
  const base = { providerId, label: (provider.customSlot && credential?.label) || provider.label, connected, fetchedAt: now() }

  const fallback = (error) => ({ ...base, source: 'catalog', error, models: suggestedModels(provider) })

  // OpenRouter's catalog is public; everyone else needs their key (or to be a keyless local server).
  const canList = providerId === 'openrouter' || (connected && !NOT_LISTABLE.has(providerId))
  if (!canList) {
    return fallback(NOT_LISTABLE.has(providerId) ? 'This provider has no model-list endpoint; showing suggested models.' : null)
  }
  if (!baseUrl) return fallback('No base URL configured.')

  const key = cacheKeyFor(providerId, apiKey, baseUrl)
  const cached = cache.get(key)
  if (!force && cached && now() - cached.at < CATALOG_TTL_MS) return cached.value

  try {
    let models
    if (providerId === 'anthropic') {
      const payload = await getJson(`${baseUrl}/v1/models?limit=1000`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })
      models = normalizeAnthropicModels(payload)
    } else if (providerId === 'openrouter') {
      const payload = await getJson(`${baseUrl}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      models = normalizeOpenRouterModels(payload)
    } else {
      const payload = await getJson(`${baseUrl}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      models = normalizeOpenAiCompatibleModels(payload, providerId)
    }
    if (!models.length) return fallback('The provider returned an empty model list; showing suggested models.')
    const value = { ...base, source: 'live', error: null, models }
    cache.set(key, { at: now(), value })
    return value
  } catch (error) {
    return fallback(`Could not list models: ${error instanceof Error ? error.message : String(error)}${misplacedKeyHint(providerId, apiKey)}`)
  }
}

/** Every catalog provider, in parallel. Unconnected ones just return their suggested models. */
export async function listAllProviderModels(getCredential, options) {
  const credentials = Object.fromEntries(AI_PROVIDERS.map((provider) => [provider.id, getCredential(provider.id)]))
  return Promise.all(AI_PROVIDERS
    // Unconfigured custom slots have nothing to browse; they only appear on Providers & Keys (as the next empty slot).
    .filter((provider) => !provider.agentOnly && (!provider.customSlot || credentials[provider.id]))
    .map((provider) => listProviderModels(provider.id, credentials[provider.id], options)))
}
