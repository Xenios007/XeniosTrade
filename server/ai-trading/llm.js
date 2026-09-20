// One "give me a JSON object back" call, for any provider in
// src/lib/aiProviders.js. Anthropic goes through the official SDK; every other
// provider in the catalog speaks OpenAI-compatible Chat Completions.
//
// Deliberately separate from server/strategy/openai-compatible-client.js: that
// one is welded to the trade-decision shape the LLM bots share. Keys/base
// URLs/models come from the same in-memory credential mirror the bots read
// (the AI Models page), with the same .env fallbacks.

import Anthropic from '@anthropic-ai/sdk'
import { getAiProvider } from '../../src/lib/aiProviders.js'
import { CODEX_AGENT_TIMEOUT_MS, CODEX_PROVIDER_ID, runCodexAgent } from './codex-agent.js'
import { CLAUDE_AGENT_TIMEOUT_MS, CLAUDE_PROVIDER_ID, runClaudeAgent } from './claude-agent.js'
import { getAiProviderCredential } from '../strategy/ai-provider-credentials-store.js'

const ENV_KEY_FALLBACKS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

/**
 * Providers echo (partially masked) keys in auth errors, e.g. "Incorrect API key provided: sk-or-v1****e47a".
 * Even a masked fragment has no business reaching the browser, logs or the stored run history.
 */
export function redactSecrets(message) {
  return String(message ?? '')
    .replace(/\b(?:sk|xai|gsk|hf|pplx|nvapi|fw)[-_][A-Za-z0-9_*-]{6,}/g, '[redacted key]')
    .replace(/\bAIza[A-Za-z0-9_*-]{8,}/g, '[redacted key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=*-]{12,}/gi, 'Bearer [redacted]')
}

export const DEFAULT_LLM_TIMEOUT_MS = 45_000
// Reasoning models (Gemini 3.x, o-series, ...) spend hidden thinking tokens out of this same budget; at 1024 a
// Gemini reply was cut off mid-JSON. The visible reply is ~250 tokens, so the extra headroom costs nothing when unused.
const MAX_OUTPUT_TOKENS = 4096
const TRANSIENT_RETRY_DELAY_MS = 1500

/**
 * Resolves what a provider call would use, without calling anything.
 * `configured` is false when a required key/base URL is missing.
 */
export function resolveProviderCall(providerId, modelOverride = '') {
  const provider = getAiProvider(providerId)
  if (!provider) {
    return { configured: false, reason: providerId ? `Unknown provider "${providerId}".` : 'No provider assigned.' }
  }

  // Codex / Claude sign in with the machine's own login (checked when called), so they have no key, base URL or default model here.
  if (provider.localLogin && !provider.localServer) return { configured: true, provider, model: String(modelOverride || '').trim() }

  const credential = getAiProviderCredential(providerId) || {}
  const envName = ENV_KEY_FALLBACKS[providerId]
  const apiKey = String(credential.apiKey || (envName ? process.env[envName] : '') || '').trim()
  const baseUrl = String(credential.baseUrl || provider.baseUrl || '').trim()
  const model = String(modelOverride || credential.model || provider.suggested?.[0] || '').trim()

  if (!provider.keyless && !provider.keyOptional && !apiKey) {
    return { configured: false, provider, reason: `${provider.label} has no API key — add one on the AI Models page.` }
  }
  if (!baseUrl) {
    return { configured: false, provider, reason: `${provider.label} needs a base URL on the AI Models page.` }
  }
  if (!model) {
    return { configured: false, provider, reason: `${provider.label} needs a model id.` }
  }

  return { configured: true, provider, apiKey, baseUrl, model }
}

/** Pulls the first JSON object out of a model reply, tolerating code fences and stray prose. */
export function extractJsonObject(text) {
  const source = String(text || '').trim()
  if (!source) throw new Error('The model returned an empty reply.')

  const unfenced = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const direct = JSON.parse(unfenced)
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct
  } catch {
    // fall through to brace scanning
  }

  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('The model reply did not contain a JSON object.')
  const parsed = JSON.parse(unfenced.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model reply was not a JSON object.')
  }
  return parsed
}

async function callAnthropic({ apiKey, baseUrl, model, systemPrompt, userPrompt, timeoutMs }) {
  const client = new Anthropic({ apiKey, baseURL: baseUrl, timeout: timeoutMs, maxRetries: 0 })
  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  }).catch((error) => {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)))
  })
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`The model's reply was cut off at the ${MAX_OUTPUT_TOKENS}-token limit.`)
  }
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

async function postChatCompletion({ apiKey, baseUrl, body, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let payload = {}
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { raw: text }
    }
    return { response, payload }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Turns an error body into one readable line. Google wraps error bodies in an array: [{ "error": { ... } }].
 * OpenRouter's message is often just "Provider returned error" and puts the real reason (the upstream host and its
 * raw reply, e.g. a free-tier rate limit) in `error.metadata`, so include that or the failure is undiagnosable.
 */
export function describeProviderError(payload, status) {
  const error = payload?.error || payload?.[0]?.error
  const base = error?.message || payload?.raw?.slice?.(0, 200) || `HTTP ${status}`
  const meta = error?.metadata
  if (!meta || typeof meta !== 'object') return base
  let raw = meta.raw
  if (raw && typeof raw === 'object') raw = raw.error?.message || raw.message || JSON.stringify(raw)
  const detail = [meta.provider_name, typeof raw === 'string' ? raw.slice(0, 240) : ''].filter(Boolean).join(': ')
  return detail ? `${base} (${detail})` : base
}

async function callOpenAiCompatible({ apiKey, baseUrl, model, systemPrompt, userPrompt, timeoutMs }) {
  const body = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  }

  let activeBody = body
  let { response, payload } = await postChatCompletion({ apiKey, baseUrl, body: activeBody, timeoutMs })
  if (response.status === 400) {
    // Not every OpenAI-compatible host accepts JSON mode; the prompt already spells out the shape.
    const { response_format: _unused, ...withoutJsonMode } = body
    activeBody = withoutJsonMode
    ;({ response, payload } = await postChatCompletion({ apiKey, baseUrl, body: activeBody, timeoutMs }))
  }

  if (response.status === 503) {
    // Transient "high demand" spikes (seen from Gemini) — one short retry.
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS))
    ;({ response, payload } = await postChatCompletion({ apiKey, baseUrl, body: activeBody, timeoutMs }))
  }

  if (!response.ok) {
    throw new Error(redactSecrets(describeProviderError(payload, response.status)))
  }
  const choice = payload?.choices?.[0]
  if (choice?.finish_reason === 'length') {
    throw new Error(`The model's reply was cut off at the ${MAX_OUTPUT_TOKENS}-token limit (reasoning models spend tokens thinking). Try a non-reasoning model for this agent.`)
  }
  if (!choice?.message?.content) throw new Error('No message content returned.')
  return choice.message.content
}

/**
 * @returns {Promise<{ json: object, providerId: string, model: string }>}
 * Throws when the provider is unconfigured, the call fails, or the reply is not JSON.
 */
export async function callAgentJson({ providerId, model = '', systemPrompt, userPrompt, timeoutMs }) {
  const resolved = resolveProviderCall(providerId, model)
  if (!resolved.configured) {
    const error = new Error(resolved.reason)
    error.code = 'NOT_CONFIGURED'
    throw error
  }

  if (providerId === CODEX_PROVIDER_ID) {
    try {
      const text = await runCodexAgent({ systemPrompt, userPrompt, model: resolved.model, timeoutMs: timeoutMs ?? CODEX_AGENT_TIMEOUT_MS })
      return { json: extractJsonObject(text), providerId, model: resolved.model || 'codex-default' }
    } catch (error) {
      if (error?.code === 'NOT_CONFIGURED') throw error
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)))
    }
  }

  if (providerId === CLAUDE_PROVIDER_ID) {
    try {
      const text = await runClaudeAgent({ systemPrompt, userPrompt, model: resolved.model, timeoutMs: timeoutMs ?? CLAUDE_AGENT_TIMEOUT_MS })
      return { json: extractJsonObject(text), providerId, model: resolved.model || 'claude-default' }
    } catch (error) {
      if (error?.code === 'NOT_CONFIGURED') throw error
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)))
    }
  }

  const args = { ...resolved, systemPrompt, userPrompt, timeoutMs: timeoutMs ?? resolved.provider.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS }
  const text = providerId === 'anthropic' ? await callAnthropic(args) : await callOpenAiCompatible(args)
  return { json: extractJsonObject(text), providerId, model: resolved.model }
}
