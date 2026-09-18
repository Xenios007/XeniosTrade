// Bot 13 "Bot Gemini" — Bot Claude's sibling, same shared engine
// (llm-trading-engine.js), calling Google's Gemini API through its
// OpenAI-compatible endpoint instead. See bot-claude.js for the design
// notes shared by every bot in this family.

import { requestOpenAiCompatibleTradeDecision } from './openai-compatible-client.js'
import { buildLlmTradeSystemPrompt, createLlmTradingBot } from './llm-trading-engine.js'
import { getAiProviderCredential } from './ai-provider-credentials-store.js'

const BOT_LABEL = 'Bot Gemini'
const PROVIDER_ID = 'google'
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

function getApiKey() {
  return String(getAiProviderCredential(PROVIDER_ID)?.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim()
}

function getBaseUrl() {
  return String(getAiProviderCredential(PROVIDER_ID)?.baseUrl || process.env.GEMINI_BOT_BASE_URL || DEFAULT_BASE_URL).trim()
}

function getModelId() {
  return String(getAiProviderCredential(PROVIDER_ID)?.model || process.env.GEMINI_BOT_MODEL || 'gemini-2.0-flash').trim()
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
  })
}

const engine = createLlmTradingBot({
  id: 'bot-gemini',
  label: BOT_LABEL,
  strategyFamily: 'llm-gemini',
  isConfigured: () => Boolean(getApiKey()),
  resolveModelLabel: getModelId,
  requestDecision,
})

export const refreshBotGeminiDecisions = engine.refreshDecisions
export const buildBotGeminiSignalSnapshot = engine.buildSignalSnapshot
