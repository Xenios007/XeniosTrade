// Bot 12 "Bot GPT" — Bot Claude's sibling, same shared engine
// (llm-trading-engine.js), calling OpenAI's Chat Completions API instead.
// See bot-claude.js for the design notes shared by every bot in this family.

import { requestOpenAiCompatibleTradeDecision } from './openai-compatible-client.js'
import { buildLlmTradeSystemPrompt, createLlmTradingBot } from './llm-trading-engine.js'
import { getAiProviderCredential } from './ai-provider-credentials-store.js'

const BOT_LABEL = 'Bot GPT'
const PROVIDER_ID = 'openai'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function getApiKey() {
  return String(getAiProviderCredential(PROVIDER_ID)?.apiKey || process.env.OPENAI_API_KEY || '').trim()
}

function getBaseUrl() {
  return String(getAiProviderCredential(PROVIDER_ID)?.baseUrl || process.env.OPENAI_BOT_GPT_BASE_URL || DEFAULT_BASE_URL).trim()
}

function getModelId() {
  // Falls back through the same OPENAI_MODEL env var the dashboard
  // "Manual Trade With ChatGPT" review already uses, so one configured key
  // sensibly drives both features unless a bot-specific model is set.
  return String(
    getAiProviderCredential(PROVIDER_ID)?.model || process.env.OPENAI_BOT_GPT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  ).trim()
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
  id: 'bot-gpt',
  label: BOT_LABEL,
  strategyFamily: 'llm-gpt',
  isConfigured: () => Boolean(getApiKey()),
  resolveModelLabel: getModelId,
  requestDecision,
})

export const refreshBotGptDecisions = engine.refreshDecisions
export const buildBotGptSignalSnapshot = engine.buildSignalSnapshot
