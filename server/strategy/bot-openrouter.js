// Bot 15 "Bot OpenRouter" — Bot Claude's sibling, same shared engine
// (llm-trading-engine.js), routed through OpenRouter's aggregator API
// instead of a single provider. Defaults to a Llama model so the five-bot
// roster covers five genuinely distinct model families (Claude, GPT,
// Gemini, Grok, Llama) rather than duplicating one already covered by a
// dedicated bot — but OPENROUTER_BOT_MODEL can point it at any model
// OpenRouter serves (e.g. "anthropic/claude-sonnet-5", "openai/gpt-4o").
// See bot-claude.js for the design notes shared by every bot in this family.

import { requestOpenAiCompatibleTradeDecision } from './openai-compatible-client.js'
import { buildLlmTradeSystemPrompt, createLlmTradingBot } from './llm-trading-engine.js'

const BOT_LABEL = 'Bot OpenRouter'
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

function getApiKey() {
  return String(process.env.OPENROUTER_API_KEY || '').trim()
}

function getBaseUrl() {
  return String(process.env.OPENROUTER_BOT_BASE_URL || DEFAULT_BASE_URL).trim()
}

function getModelId() {
  return String(process.env.OPENROUTER_BOT_MODEL || 'meta-llama/llama-3.3-70b-instruct').trim()
}

async function requestDecision({ prompt }) {
  const apiKey = getApiKey()
  if (!apiKey) return null

  return requestOpenAiCompatibleTradeDecision({
    apiKey,
    baseUrl: getBaseUrl(),
    model: getModelId(),
    systemPrompt: buildLlmTradeSystemPrompt(BOT_LABEL),
    userPrompt: prompt,
    extraHeaders: { 'X-Title': 'XeniosTrade Bot OpenRouter' },
  })
}

const engine = createLlmTradingBot({
  id: 'bot-openrouter',
  label: BOT_LABEL,
  strategyFamily: 'llm-openrouter',
  isConfigured: () => Boolean(getApiKey()),
  resolveModelLabel: getModelId,
  requestDecision,
})

export const refreshBotOpenrouterDecisions = engine.refreshDecisions
export const buildBotOpenrouterSignalSnapshot = engine.buildSignalSnapshot
