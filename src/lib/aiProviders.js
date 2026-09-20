// Catalog of AI providers the app can hold a credential for, ported from the
// sibling XeniosAI project's provider registry (packages/ai-providers/src/registry.js)
// so the "AI Models" page follows the same design there. Shared between client
// and server (like signalModels.js / wallets.js) — no Node builtins here.
//
// Only five providers (anthropic, openai, google, xai, openrouter) currently
// drive a live trading bot (Bot Claude/GPT/Gemini/Grok/OpenRouter). The rest
// are listed so a key can be saved and ready for a future bot without any
// server change beyond adding that bot — see docs/LLM_TRADING_BOTS.md.

const P = (id, label, over = {}) => ({
  id,
  label,
  keyless: false,
  baseUrlEditable: false,
  baseUrlRequired: false,
  advanced: false,
  suggested: [],
  wiredBot: null,
  ...over,
})

const CUSTOM_SLOT_COUNT = 5
const MAX_LABEL_LENGTH = 40

export const AI_PROVIDERS = [
  P('anthropic', 'Anthropic (Claude)', {
    baseUrl: 'https://api.anthropic.com',
    baseUrlEditable: true,
    keyHint: 'sk-ant-…',
    docs: 'https://docs.anthropic.com/en/docs/about-claude/models',
    suggested: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    wiredBot: 'Bot Claude (Wallet 11)',
  }),
  P('openai', 'OpenAI (GPT)', {
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: true,
    keyHint: 'sk-…',
    docs: 'https://platform.openai.com/docs/models',
    suggested: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    wiredBot: 'Bot GPT (Wallet 12)',
  }),
  P('google', 'Google (Gemini)', {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'AIza…',
    docs: 'https://ai.google.dev/gemini-api/docs/models',
    suggested: ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest'],
    wiredBot: 'Bot Gemini (Wallet 13)',
  }),
  P('xai', 'xAI (Grok)', {
    baseUrl: 'https://api.x.ai/v1',
    keyHint: 'xai-…',
    suggested: ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'],
    wiredBot: 'Bot Grok (Wallet 14)',
  }),
  P('openrouter', 'OpenRouter', {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…',
    docs: 'https://openrouter.ai/models',
    suggested: ['meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-sonnet-5', 'openai/gpt-4o', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-chat'],
    wiredBot: 'Bot OpenRouter (Wallet 15)',
  }),
  // AI Trading agents only: runs through the Codex SDK on the server with the machine's own `codex login`, so there is no key
  // or base URL to save and it never shows on Providers & Keys / Browse Models (`agentOnly`). `localLogin` marks the no-key path.
  P('codex', 'Codex (this server\'s login)', {
    keyless: true,
    agentOnly: true,
    localLogin: true,
    keyHint: 'machine login',
  }),
  // Same idea as Codex: the Claude Agent SDK on the server with the machine's own `claude login`. Not the pay-per-token
  // Anthropic API provider above, which needs a saved key.
  P('claude', 'Claude (this server\'s login)', {
    keyless: true,
    agentOnly: true,
    localLogin: true,
    keyHint: 'machine login',
  }),
  // FinGPT (Llama-3-8B + LoRA, 4-bit NF4) served from this machine by server/local-llm/server.py (OpenAI-compatible, port
  // 8011). No key; `localServer` marks a built-in local model whose readiness is that process's /health, and the Base URL
  // stays editable so the same slot can point at any other OpenAI-compatible local server. `timeoutMs` is the per-call
  // budget because an 8B model generates slowly on this hardware.
  P('fingpt', 'FinGPT · Llama 3 8B (local, 4-bit)', {
    baseUrl: 'http://127.0.0.1:8011/v1',
    baseUrlEditable: true,
    baseUrlHint: 'http://127.0.0.1:8011/v1',
    // Optional key: only needed when the model is reached over a Cloudflare tunnel (e.g. from the VPS), where the local
    // server requires its bearer token (server/local-llm/api-key.txt). Direct localhost calls need none.
    keyOptional: true,
    localLogin: true,
    localServer: true,
    keyHint: 'token, only for a tunnel / remote URL',
    suggested: ['fingpt-llama3-8b'],
    wiredBot: 'AI Trading agents (local model)',
    timeoutMs: 420_000,
  }),
  P('meta', 'Meta (Llama via Together)', {
    baseUrl: 'https://api.together.xyz/v1',
    keyHint: 'Together key',
    suggested: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
  }),
  P('deepseek', 'DeepSeek', {
    baseUrl: 'https://api.deepseek.com/v1',
    suggested: ['deepseek-chat', 'deepseek-reasoner'],
  }),
  P('mistral', 'Mistral', {
    baseUrl: 'https://api.mistral.ai/v1',
    suggested: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
  }),
  P('qwen', 'Qwen / Alibaba', {
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    suggested: ['qwen-max', 'qwen-plus', 'qwen2.5-72b-instruct'],
  }),
  P('cohere', 'Cohere', {
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    suggested: ['command-r-plus', 'command-r'],
  }),
  P('perplexity', 'Perplexity', {
    baseUrl: 'https://api.perplexity.ai',
    suggested: ['sonar', 'sonar-pro', 'sonar-reasoning'],
  }),
  P('groq', 'Groq', {
    baseUrl: 'https://api.groq.com/openai/v1',
    suggested: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  }),
  P('together', 'Together AI', {
    baseUrl: 'https://api.together.xyz/v1',
    suggested: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
  }),
  P('fireworks', 'Fireworks AI', {
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    suggested: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
  }),
  P('nvidia', 'NVIDIA NIM', {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    suggested: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'],
  }),
  P('cerebras', 'Cerebras', {
    baseUrl: 'https://api.cerebras.ai/v1',
    suggested: ['llama-3.3-70b', 'llama3.1-8b'],
  }),
  P('huggingface', 'Hugging Face', {
    baseUrl: 'https://router.huggingface.co/v1',
    keyHint: 'hf_…',
    suggested: ['meta-llama/Llama-3.3-70B-Instruct'],
  }),
  P('azure-openai', 'Azure OpenAI', {
    baseUrlEditable: true,
    baseUrlRequired: true,
    baseUrlHint: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>',
    advanced: true,
  }),
  P('bedrock', 'AWS Bedrock', { advanced: true, baseUrlEditable: true, baseUrlRequired: true }),
  P('vertex', 'Google Vertex AI', { advanced: true, baseUrlEditable: true, baseUrlRequired: true }),
  P('ollama', 'Ollama (local)', {
    baseUrl: 'http://localhost:11434/v1',
    baseUrlEditable: true,
    keyless: true,
    keyHint: 'not required',
    suggested: ['llama3.2', 'qwen2.5', 'mistral'],
  }),
  P('lmstudio', 'LM Studio (local)', {
    baseUrl: 'http://localhost:1234/v1',
    baseUrlEditable: true,
    keyless: true,
    keyHint: 'not required',
  }),
  // Custom OpenAI-compatible endpoints, for testing your own / self-hosted models. Several fixed slots (each one holds one
  // base URL + model, and can be given a display name); the page only shows the configured ones plus the next empty one.
  // The key is optional because a local server (vLLM, llama.cpp, TGI...) usually has none.
  ...Array.from({ length: CUSTOM_SLOT_COUNT }, (_unused, index) => P(
    index === 0 ? 'custom' : `custom-${index + 1}`,
    index === 0 ? 'Custom OpenAI-compatible' : `Custom OpenAI-compatible ${index + 1}`,
    {
      baseUrlEditable: true,
      baseUrlRequired: true,
      baseUrlHint: 'http://127.0.0.1:8000/v1',
      keyOptional: true,
      keyHint: 'optional',
      customSlot: index + 1,
    },
  )),
]

const AI_PROVIDERS_BY_ID = new Map(AI_PROVIDERS.map((provider) => [provider.id, provider]))
export const AI_PROVIDER_IDS = AI_PROVIDERS.map((provider) => provider.id)

export function getAiProvider(id) {
  return AI_PROVIDERS_BY_ID.get(String(id || '').trim()) || null
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A key is only needed when the provider requires one; keyless and `keyOptional` providers connect on a saved base URL. */
export function isProviderConnected(provider, entry, keyPresent) {
  if (!provider) return false
  if (keyPresent) return true
  return Boolean(provider.keyless || provider.keyOptional) && Boolean(String(entry?.baseUrl || '').trim())
}

/** The name to show for a provider: a custom slot's own label when the user gave it one. */
export function providerDisplayName(provider, credentials) {
  if (!provider) return ''
  return (provider.customSlot && credentials?.[provider.id]?.label) || provider.label
}

/**
 * Which providers the Providers & Keys / agent pickers list. Custom slots after the first stay hidden until the one
 * before them is in use, so there is always exactly one empty custom slot to add the next model to.
 */
export function isProviderListed(provider, credentials) {
  if (!provider.customSlot || provider.customSlot === 1) return true
  if (credentials?.[provider.id]) return true
  const previousId = provider.customSlot === 2 ? 'custom' : `custom-${provider.customSlot - 1}`
  return Boolean(credentials?.[previousId])
}

/** Validates/cleans a `{ [providerId]: { apiKey, baseUrl, model } }` map from disk or a request body. */
export function normalizeAiProviderCredentials(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  return Object.fromEntries(
    Object.entries(raw)
      .map(([providerId, entry]) => {
        if (!getAiProvider(providerId) || !entry || typeof entry !== 'object') return null
        const apiKey = toTrimmedString(entry.apiKey)
        const baseUrl = toTrimmedString(entry.baseUrl)
        const model = toTrimmedString(entry.model)
        // Only custom slots can be named, and the field is left out when unset so other entries keep their exact shape.
        const label = getAiProvider(providerId).customSlot ? toTrimmedString(entry.label).slice(0, MAX_LABEL_LENGTH) : ''
        if (!apiKey && !baseUrl && !model) return null
        return [providerId, { apiKey, baseUrl, model, ...(label ? { label } : {}) }]
      })
      .filter(Boolean),
  )
}

/**
 * Merges a requested per-provider credential update onto the current map.
 * A blank apiKey/baseUrl/model in the request means "leave the stored value
 * alone" (never send a real key back to the client, so it can only ever
 * resubmit blank for fields it isn't changing) — mirrors the single-credential
 * masking already used for the Binance key fields. Sending `null` for a
 * provider removes it entirely (the page's "Remove" action).
 */
export function mergeAiProviderCredentialsUpdate(currentMap, requestedMap) {
  const current = normalizeAiProviderCredentials(currentMap)
  const requested = requestedMap && typeof requestedMap === 'object' && !Array.isArray(requestedMap) ? requestedMap : {}
  const next = { ...current }

  for (const [providerId, entry] of Object.entries(requested)) {
    if (!getAiProvider(providerId)) continue
    if (entry === null) {
      delete next[providerId]
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const existing = current[providerId] || { apiKey: '', baseUrl: '', model: '' }
    const requestedApiKey = toTrimmedString(entry.apiKey)
    const requestedBaseUrl = toTrimmedString(entry.baseUrl)
    const requestedModel = toTrimmedString(entry.model)
    next[providerId] = {
      apiKey: requestedApiKey || existing.apiKey,
      baseUrl: requestedBaseUrl || existing.baseUrl,
      model: requestedModel || existing.model,
      label: toTrimmedString(entry.label) || existing.label || '',
    }
  }

  return normalizeAiProviderCredentials(next)
}

/** Whether a `localLogin` provider (Codex / Claude) can run: `logins` is the `{ codex, claude }` status the server reports. */
export function isLocalLoginReady(logins, providerId) {
  const status = logins?.[providerId]
  return Boolean(status?.available && status?.loggedIn)
}
