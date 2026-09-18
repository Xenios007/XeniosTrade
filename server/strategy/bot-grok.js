// Bot 14 "Bot Grok" — Bot Claude's sibling, same shared engine
// (llm-trading-engine.js), calling xAI's Grok API through its
// OpenAI-compatible endpoint instead. See bot-claude.js for the design
// notes shared by every bot in this family.

import { requestOpenAiCompatibleTradeDecision } from './openai-compatible-client.js'
import { buildLlmTradeSystemPrompt, createLlmTradingBot } from './llm-trading-engine.js'
import { getAiProviderCredential } from './ai-provider-credentials-store.js'

const BOT_LABEL = 'Bot Grok'
const PROVIDER_ID = 'xai'
const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

function getApiKey() {
  return String(getAiProviderCredential(PROVIDER_ID)?.apiKey || process.env.XAI_API_KEY || '').trim()
}

function getBaseUrl() {
  return String(getAiProviderCredential(PROVIDER_ID)?.baseUrl || process.env.XAI_BOT_BASE_URL || DEFAULT_BASE_URL).trim()
}

function getModelId() {
  return String(getAiProviderCredential(PROVIDER_ID)?.model || process.env.XAI_BOT_MODEL || 'grok-2-latest').trim()
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
  id: 'bot-grok',
  label: BOT_LABEL,
  strategyFamily: 'llm-grok',
  isConfigured: () => Boolean(getApiKey()),
  resolveModelLabel: getModelId,
  requestDecision,
})

export const refreshBotGrokDecisions = engine.refreshDecisions
export const buildBotGrokSignalSnapshot = engine.buildSignalSnapshot
