// Bot 11 "Bot Claude" — one of a family of LLM-driven bots (Bot Claude, Bot
// GPT, Bot Gemini, Bot Grok, Bot OpenRouter — see llm-trading-engine.js for
// the shared engine and bot-gpt.js/bot-gemini.js/bot-grok.js/bot-openrouter.js
// for its siblings) meant to compare how different frontier models trade the
// same market. Unlike Bots 1-10, there is no hand-coded technical rule set
// here: every decision comes from a live call to the Anthropic Claude API.
//
// This file only supplies "how to call Claude" - caching, gating, prompt
// content, and position sizing all live in the shared engine so every LLM
// bot is compared on identical footing.

import Anthropic from '@anthropic-ai/sdk'
import { buildLlmTradeSystemPrompt, createLlmTradingBot, LLM_TRADE_DECISION_JSON_SCHEMA, parseTradeDecision } from './llm-trading-engine.js'
import { getAiProviderCredential } from './ai-provider-credentials-store.js'

const BOT_LABEL = 'Bot Claude'
const PROVIDER_ID = 'anthropic'

const TRADE_DECISION_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: LLM_TRADE_DECISION_JSON_SCHEMA,
  parse: parseTradeDecision,
}

function getApiKey() {
  return String(getAiProviderCredential(PROVIDER_ID)?.apiKey || process.env.ANTHROPIC_API_KEY || '').trim()
}

let anthropicClient = null
let cachedApiKey = null
let missingApiKeyWarned = false

function getClient() {
  const apiKey = getApiKey()
  if (!apiKey) {
    if (!missingApiKeyWarned) {
      missingApiKeyWarned = true
      console.warn('[bot-claude] No Anthropic API key configured (AI Models page or ANTHROPIC_API_KEY) — Bot Claude will stay in "watching" state.')
    }
    return null
  }
  // Re-create the client if the key changed (e.g. rotated via the AI Models page).
  if (!anthropicClient || cachedApiKey !== apiKey) {
    anthropicClient = new Anthropic({ apiKey })
    cachedApiKey = apiKey
  }
  return anthropicClient
}

function getModelId() {
  return String(
    getAiProviderCredential(PROVIDER_ID)?.model || process.env.ANTHROPIC_BOT_CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  ).trim()
}

async function requestDecision({ prompt }) {
  const client = getClient()
  if (!client) return null

  const response = await client.beta.messages.parse({
    model: getModelId(),
    max_tokens: 1024,
    system: buildLlmTradeSystemPrompt(BOT_LABEL),
    messages: [{ role: 'user', content: prompt }],
    output_format: TRADE_DECISION_OUTPUT_FORMAT,
  })

  if (!response.parsed) {
    throw new Error('Claude returned an unparseable trade decision.')
  }

  return response.parsed
}

const engine = createLlmTradingBot({
  id: 'bot-claude',
  label: BOT_LABEL,
  strategyFamily: 'llm-claude',
  isConfigured: () => Boolean(getApiKey()),
  resolveModelLabel: getModelId,
  requestDecision,
})

export const refreshBotClaudeDecisions = engine.refreshDecisions
export const buildBotClaudeSignalSnapshot = engine.buildSignalSnapshot
