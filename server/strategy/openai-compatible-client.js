// Minimal client for any OpenAI-compatible Chat Completions endpoint
// (OpenAI itself, Google Gemini's OpenAI-compat layer, xAI/Grok, OpenRouter,
// and any other provider on this shape). Bot GPT, Bot Gemini, Bot Grok, and
// Bot OpenRouter all call this — they differ only in apiKey/baseUrl/model.
//
// Uses JSON-object mode (`response_format: { type: 'json_object' }`) rather
// than strict JSON-schema mode, since schema-constrained structured output is
// not uniformly supported across these providers; the prompt itself spells
// out the exact required shape (see buildLlmTradeUserPrompt), and the result
// is validated the same way regardless of provider.

import { parseTradeDecision } from './llm-trading-engine.js'

export async function requestOpenAiCompatibleTradeDecision({
  apiKey,
  baseUrl,
  model,
  systemPrompt,
  userPrompt,
  extraHeaders = {},
  timeoutMs = 20000,
}) {
  if (!apiKey || !baseUrl || !model) {
    return null
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })
  } finally {
    clearTimeout(timeout)
  }

  const text = await response.text()
  let payload = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.raw || `HTTP ${response.status}`)
  }

  const content = payload?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('No message content returned.')
  }

  return parseTradeDecision(content)
}
