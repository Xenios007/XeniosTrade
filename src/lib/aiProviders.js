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
    suggested: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
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
  P('custom', 'Custom OpenAI-compatible', {
    baseUrlEditable: true,
    baseUrlRequired: true,
    baseUrlHint: 'https://your-endpoint/v1',
  }),
]

const AI_PROVIDERS_BY_ID = new Map(AI_PROVIDERS.map((provider) => [provider.id, provider]))
export const AI_PROVIDER_IDS = AI_PROVIDERS.map((provider) => provider.id)

export function getAiProvider(id) {
  return AI_PROVIDERS_BY_ID.get(String(id || '').trim()) || null
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
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
        if (!apiKey && !baseUrl && !model) return null
        return [providerId, { apiKey, baseUrl, model }]
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
    }
  }

  return normalizeAiProviderCredentials(next)
}
