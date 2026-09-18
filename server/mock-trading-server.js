import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import dotenv from 'dotenv'
import {
  getStrategyDerivedMaxLossPerTrade,
  getTradeEffectiveStopLoss,
  getTradeMaxLossPerTrade,
  getTradePnlForExitPrice,
  getTradeRiskAmount,
  summarizeAccount,
} from '../src/lib/accountMetrics.js'
import {
  DEFAULT_PREFERRED_SYMBOLS,
  VOLATILE_MARKET_SYMBOL_LIMIT,
} from '../src/lib/tradingConfig.js'
import { DEFAULT_MARGIN_MODE, normalizeMarginMode } from '../src/lib/marginModes.js'
import {
  buildDefaultSignalModelStrategies,
  calculateSignalModelPositionSizing,
  DEFAULT_BOT3_RISK_PRESET_ID,
  DEFAULT_SIGNAL_MODEL_ID,
  ensureSignalModelId,
  getEffectiveSignalModelStrategy,
  getSignalModel,
  getSignalModelName,
  getSignalModelTrackedSymbols,
  normalizeSignalModelStrategies,
  normalizeSymbolRiskProfiles,
  resolveBot3RiskPresetId,
  SIGNAL_MODELS,
} from '../src/lib/signalModels.js'
import {
  buildDefaultWallets,
  EXCHANGE_SYNC_WALLET_BALANCE_MODE,
  getTradingWallets,
  getWalletById,
  getWalletEffectiveStartingBalance,
  hydrateWalletMetadata,
  isExchangeSyncWallet,
  MANUAL_WALLET_BALANCE_MODE,
  normalizeWallets,
} from '../src/lib/wallets.js'
import { MANUAL_TRADE_STYLE_PRESET_ID } from '../src/lib/strategyPresets.js'
import { detectChartPatterns, patternScoreForSide } from '../src/lib/chartPatterns.js'
import {
  DEFAULT_AUTO_TRADE_SESSIONS,
  isHourWithinScheduledSessions,
  normalizeAutoTradeSessions,
} from '../src/lib/tradingSessions.js'
import { getCodexConsoleStatus, runCodexConsoleTurn } from './codex-console.js'
import { BOT5TO8_BUILDERS } from './strategy/bots5to8.js'
import { refreshBotClaudeDecisions } from './strategy/bot-claude.js'
import { registerConsolidatedBot } from './consolidated-bot.js'

dotenv.config()

const app = express()
const port = Number(process.env.PORT || process.env.MOCK_TRADING_PORT || 3001)
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
const futuresTestnetBaseUrl = 'https://demo-fapi.binance.com'
const publicDataBaseUrl = 'https://data-api.binance.vision/api/v3'
const publicDataFallbackBaseUrl = 'https://api.binance.com/api/v3'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// The server (HTTP listener + background timers) starts by default. Tools that
// import this file only for its exported functions — the backtest harness —
// set XENIOS_SERVER_AUTOSTART=off first so nothing double-runs. An entry-point
// check is not reliable here because pm2 fork mode loads the file through its
// own wrapper, so argv[1] is not this file.
const IS_MAIN_MODULE = String(process.env.XENIOS_SERVER_AUTOSTART || '').toLowerCase() !== 'off'
const defaultLearningBotTrainerRuntimeCommand = process.platform === 'win32' ? 'python' : 'python3'
const defaultLearningBotTrainerDevicePreference = process.platform === 'win32' ? 'cuda' : 'cpu'
const dataDir = path.join(__dirname, 'data')
const distDir = path.join(__dirname, '..', 'dist')
const distIndexFilePath = path.join(distDir, 'index.html')
const shouldServeBuiltFrontend = process.env.SERVE_FRONTEND !== 'false'
const generatedAppLoginPassword = crypto.randomBytes(18).toString('base64url')
const appLoginPassword = (
  process.env.APP_LOGIN_PASSWORD
  || process.env.XENIOS_LOGIN_PASSWORD
  || generatedAppLoginPassword
).trim()
const appLoginPasswordSource = process.env.APP_LOGIN_PASSWORD || process.env.XENIOS_LOGIN_PASSWORD
  ? 'environment'
  : 'generated'
// Local-only escape hatch: when XENIOS_DISABLE_AUTH=true the workspace login gate
// is bypassed entirely. Intended for the backtest / dev box; never set on the live server.
const authDisabled = String(process.env.XENIOS_DISABLE_AUTH || '').toLowerCase() === 'true'
const AUTH_SESSION_COOKIE_NAME = 'xeniostrade_session'
const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 12
const authSessions = new Map()
const historyFilePath = path.join(dataDir, 'trade-history.json')
const settingsFilePath = path.join(dataDir, 'settings.json')
const settingsAuditLogFilePath = path.join(dataDir, 'settings-audit-log.json')
const settingsRecoveryFilePath = path.join(dataDir, 'settings-recovery.json')
const autoTradeLogFilePath = path.join(dataDir, 'auto-trade-log.json')
const workflowReviewLogFilePath = path.join(dataDir, 'workflow-review-log.json')
const botSettingsLogFilePath = path.join(dataDir, 'bot-settings-log.json')
const learningBotDatasetFilePath = path.join(dataDir, 'learning-bot-dataset.json')
// Backtest-generated closed trades for AI training only. Never read into the
// live account / journal / UI - only merged in getPreferredLearningBotDataset.
const backtestHistoryFilePath = path.join(dataDir, 'backtest-history.json')
// Registry of individual backtest runs (see server/backtest/run-registry.js).
// Each entry may point at its own per-run row file under backtest-runs/ and is
// merged into training only when `includeInTraining === true`.
const backtestRunsRegistryFilePath = path.join(dataDir, 'backtest-runs.json')
const backtestRunsDir = path.join(dataDir, 'backtest-runs')
const backtestRunsMdDir = path.join(__dirname, 'backtest', 'runs')
const learningBotTrainStatusFilePath = path.join(dataDir, 'learning-bot-train-status.json')
const learningBotTrainConfigFilePath = path.join(dataDir, 'learning-bot-train-config.json')
const learningBotTrainArtifactFilePath = path.join(dataDir, 'learning-bot-train-artifact.json')
const learningBotTrainerScriptPath = path.join(__dirname, 'learning-bot', 'rl_trainer.py')
// Append-only log of upstream market-data 4xx responses (Binance 418/429 rate
// limits, 451, etc.). Used to decide whether the tracked universe
// (VOLATILE_MARKET_SYMBOL_LIMIT) needs further tuning. Dialed back 100 -> 50 on
// 2026-08-30 because the 100-symbol scan was overrunning the 5-minute interval
// (not 4xx-related; there were zero 4xx), leaving the auto-trader lock held.
const marketData4xxLogFilePath = path.join(dataDir, 'market-data-4xx.log')
const MARKET_DATA_4XX_LOG_MAX_BYTES = 5 * 1024 * 1024
// Keep effectively the full trade history so the AI can train on every closed trade.
// This is a safety ceiling against an unbounded file, not a training window.
const TRADE_HISTORY_LIMIT = 100000
const AUTO_TRADE_LOG_LIMIT = 1500
const LEARNING_BOT_REAL_MONEY_TRADE_TARGET = 1000
const autoTradeClients = new Set()
const autoTradeRuntime = {
  running: false,
  currentRunId: null,
  cancelRequested: false,
  lastRunAt: null,
  lastReason: 'No auto-trade run recorded yet.',
  lastExecuted: false,
}
// How many symbols the auto-trader scans in parallel per wave. Keeps the scan
// off a single serial await chain so one slow/failed upstream symbol can't
// stall the whole run (or hold the run lock past the 5-minute interval).
const SIGNAL_SCAN_CONCURRENCY = 5
const TERMINAL_TRADE_MONITOR_INTERVAL_MS = 10_000
let lastTerminalTradeMonitorAt = 0
let lastTerminalTradeMonitorSignature = ''
let lastBotSettingsLogSignature = ''
const VOLATILE_SYMBOL_LIMIT = VOLATILE_MARKET_SYMBOL_LIMIT
const VOLATILE_MARKET_CACHE_TTL_MS = 60_000
const EXCHANGE_INFO_CACHE_TTL_MS = 5 * 60_000
const MARKET_DATA_TICKER_CACHE_TTL_MS = 8_000
const MARKET_DATA_1M_KLINE_CACHE_TTL_MS = 12_000
const MARKET_DATA_5M_KLINE_CACHE_TTL_MS = 30_000
const MARKET_DATA_15M_KLINE_CACHE_TTL_MS = 60_000
const MARKET_DATA_1H_KLINE_CACHE_TTL_MS = 2 * 60_000
const MARKET_DATA_CONTEXT_CACHE_TTL_MS = 30_000
const MARKET_DATA_STALE_MAX_AGE_MS = 5 * 60_000
const MARKET_DATA_CIRCUIT_FAILURE_THRESHOLD = 5
const MARKET_DATA_CIRCUIT_WINDOW_MS = 2 * 60_000
const MARKET_DATA_CIRCUIT_COOLDOWN_MS = 2 * 60_000
const SETTINGS_AUDIT_LOG_LIMIT = 500
const SETTINGS_FILE_AUDIT_INTERVAL_MS = 5_000
const volatileMarketCache = {
  updatedAt: 0,
  items: [],
}
const exchangeInfoCache = {
  updatedAt: 0,
  data: null,
}
const marketDataCache = new Map()
const marketDataInflightRequests = new Map()
const marketDataReliability = {
  requests: 0,
  cacheHits: 0,
  inFlightHits: 0,
  staleServed: 0,
  successes: 0,
  failures: 0,
  timeouts: 0,
  rateLimited: 0,
  circuitOpened: 0,
  consecutiveFailures: 0,
  failureWindowStartedAt: 0,
  circuitOpenUntil: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureMessage: '',
  lastFailureStatus: null,
  fourXx: 0,
  fourXxByStatus: {},
  fourXxLastAt: null,
}
let lastObservedSettingsFileHash = ''
let lastObservedSettingsSnapshot = null
const dashboardTradeReviewModel = process.env.OPENAI_DASHBOARD_REVIEW_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini'

function extractStructuredResponsePayload(responsePayload) {
  const directOutput = responsePayload?.output_text

  if (typeof directOutput === 'string' && directOutput.trim()) {
    return JSON.parse(directOutput)
  }

  const outputItems = Array.isArray(responsePayload?.output) ? responsePayload.output : []

  for (const item of outputItems) {
    const contents = Array.isArray(item?.content) ? item.content : []

    for (const content of contents) {
      if (typeof content?.text === 'string' && content.text.trim()) {
        return JSON.parse(content.text)
      }
    }
  }

  throw new Error('OpenAI returned an empty structured response.')
}

function buildDashboardTradeReviewPrompt(payload) {
  const confirmedSignals = Array.isArray(payload?.confirmedSignals) ? payload.confirmedSignals : []
  const pendingSignals = Array.isArray(payload?.pendingSignals) ? payload.pendingSignals : []
  const marketSnapshot = payload?.marketSnapshot || {}
  const analysis = payload?.analysis || {}
  const lines = [
    'Review this crypto futures trade idea for a human trader who will decide manually.',
    'Return a positive verdict only if the setup quality is strong enough to justify manual execution right now.',
    '',
    `Symbol: ${payload?.symbol || 'N/A'}`,
    `Interval: ${payload?.interval || 'N/A'}`,
    `Active signal model: ${payload?.activeSignalModelName || payload?.activeSignalModelId || 'N/A'}`,
    `Current market price: ${Number(marketSnapshot.lastPrice || analysis.entryPrice || 0) || 'N/A'}`,
    `24h change percent: ${Number(marketSnapshot.priceChangePercent || 0) || 0}`,
    `24h quote volume: ${Number(marketSnapshot.quoteVolume || 0) || 0}`,
    `Direction bias: ${analysis.direction || 'WAIT'}`,
    `Checklist side: ${analysis.checklistSide || 'WAIT'}`,
    `Summary: ${analysis.summary || 'N/A'}`,
    `Entry price: ${Number(analysis.entryPrice || 0) || 'N/A'}`,
    `Stop loss: ${Number(analysis.stopLoss || 0) || 'N/A'}`,
    `Take profit: ${Number(analysis.takeProfit || 0) || 'N/A'}`,
    `Support: ${Number(analysis.support || 0) || 'N/A'}`,
    `Resistance: ${Number(analysis.resistance || 0) || 'N/A'}`,
    `Signal confidence: ${Number(analysis.confidence || 0) || 0}`,
    `Risk summary: ${payload?.activeModelRiskSummary || 'N/A'}`,
    '',
    'Confirmed signals:',
    confirmedSignals.length > 0
      ? confirmedSignals.map((item) => `- ${item.label}: ${item.detail || 'confirmed'}`).join('\n')
      : '- None',
    '',
    'Pending or missing signals:',
    pendingSignals.length > 0
      ? pendingSignals.map((item) => `- ${item.label}: ${item.detail || 'still missing'}`).join('\n')
      : '- None',
    '',
    'Decide whether manual execution should continue now. If the setup is weak, overextended, or incomplete, return a negative verdict.',
    'If positive, give the preferred direction, a suggested entry price close to the current setup, a suggested take-profit price, a suggested stop-loss price, and an optional earlier-exit price.',
    'Keep the reasoning practical and concise.',
  ]

  return lines.join('\n')
}
let lastSettingsRegressionWarningSignature = ''

// Bot 4 (model-4) cuts any open position the instant its unrealized PnL reaches this loss, in USDT.
const MODEL4_HARD_MONEY_STOP_USDT = 1

// Local-paper auto trades are flattened after this many hours if neither the take-profit
// nor the stop-loss has been hit. Matches the 48h time stop already enforced by the
// backtest engine (server/backtest/exit-policy.js MAX_HOLD_MS) and the consolidated bot's
// live testnet loop (server/consolidated-testnet.js TESTNET_LIMITS.maxHoldHours), so a
// paper trade can no longer sit open indefinitely (e.g. a stalled USDCUSDT position that
// never reaches its bracket) and live paper trading matches what was actually backtested.
const PAPER_TRADE_MAX_HOLD_HOURS = 48

const defaultStrategySettingsBase = {
  autoTradingEnabled: false,
  preferredSymbols: DEFAULT_PREFERRED_SYMBOLS,
  activeSignalModelId: DEFAULT_SIGNAL_MODEL_ID,
  tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
  bot3RiskPresetId: DEFAULT_BOT3_RISK_PRESET_ID,
  sessionScheduleEnabled: false,
  scheduledSessions: DEFAULT_AUTO_TRADE_SESSIONS,
  marginMode: DEFAULT_MARGIN_MODE,
  marginPerTrade: 500,
  leverage: 10,
  maxOpenPositions: 1,
  stopLossPercent: 0.7,
  takeProfitPercent: 1,
  maxTradesPerDay: 3,
  maxLossesPerDay: 2,
  maxLossPerDay: 20,
  dailyProfitTarget: 50,
  timezone: 'Asia/Manila',
  symbolRiskProfiles: {},
}
const defaultStrategySettings = {
  ...defaultStrategySettingsBase,
  signalModelStrategies: buildDefaultSignalModelStrategies(defaultStrategySettingsBase),
}
const defaultLearningBotSettings = {
  enabled: false,
  mode: 'rule-adaptive',
  focusSource: 'auto',
  trainingScope: 'per-bot',
  focusSignalModelId: 'all',
  // 0 = no training window: the AI trains on every eligible closed trade.
  reviewWindowTrades: 0,
  minClosedTradesForInsights: 12,
  minPatternSampleSize: 2,
  requireCandleClose: true,
  blockCounterTrend: true,
  autoPromoteToPaper: false,
  // When true, backtest-generated trades (server/data/backtest-history.json,
  // produced by server/backtest/replay-dataset.js) are merged into the training
  // dataset alongside real closed trades. They never touch account balances.
  includeBacktestData: true,
  notes: '',
  aiTrainer: {
    enabled: false,
    framework: 'pytorch',
    algorithm: 'dqn',
    runtimeCommand: defaultLearningBotTrainerRuntimeCommand,
    devicePreference: defaultLearningBotTrainerDevicePreference,
    epochs: 20,
    batchSize: 64,
    learningRate: 0.0005,
    stateWindow: 32,
    rewardMode: 'pnl-risk',
  },
  aiEntryFilter: {
    enabled: false,
    paperOnly: true,
    thresholdScore: 55,
  },
  perBotOverrides: {
    'model-1': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-2': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-3': { enabled: false, paperOnly: true, thresholdScore: 55 },
    // Bot 4 is fully AI-gated: the entry score is the sole decision, so it runs as a hard block, not paper-only.
    // Threshold kept modest during the data-gathering phase; raise it once Bot 4 has a self-trained policy.
    'model-4': { enabled: true, paperOnly: false, thresholdScore: 45 },
    // Bots 5-8 (mean-reversion / volatility-breakout / range-fade / funding-contrarian) are AI-gated
    // the same way during their observation phase.
    'model-5': { enabled: true, paperOnly: false, thresholdScore: 45 },
    'model-6': { enabled: true, paperOnly: false, thresholdScore: 45 },
    'model-7': { enabled: true, paperOnly: false, thresholdScore: 45 },
    'model-8': { enabled: true, paperOnly: false, thresholdScore: 45 },
    // Bot 9 is a user-authorized, validation-rejected experiment. It remains
    // testnet-scoped through the server's exchange credentials and small risk profile.
    'model-9': { enabled: true, paperOnly: false, thresholdScore: 45 },
    'model-10': { enabled: true, paperOnly: false, thresholdScore: 45 },
    // Bot 11 "Bot Claude" is a live LLM-driven experiment, same posture as Bot 9/10.
    'model-11': { enabled: true, paperOnly: false, thresholdScore: 45 },
  },
}

const defaultSettings = {
  settingsRevision: 1,
  apiKey: process.env.BINANCE_TESTNET_API_KEY || '',
  secretKey: process.env.BINANCE_TESTNET_SECRET_KEY || '',
  strategy: {
    ...defaultStrategySettings,
    maxLossPerTrade: getStrategyDerivedMaxLossPerTrade(defaultStrategySettings),
  },
  learningBot: defaultLearningBotSettings,
  wallets: buildDefaultWallets(),
}

const strategySettingKeys = Object.keys(defaultSettings.strategy)

function clampInteger(value, fallback, {
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
} = {}) {
  const numericValue = Math.round(Number(value))

  if (!Number.isFinite(numericValue)) {
    return fallback
  }

  return Math.min(Math.max(numericValue, min), max)
}

export function normalizeLearningBotSettings(rawSettings = {}) {
  const raw = rawSettings && typeof rawSettings === 'object' ? rawSettings : {}
  const rawAiTrainer = raw.aiTrainer && typeof raw.aiTrainer === 'object' ? raw.aiTrainer : {}
  const rawAiEntryFilter = raw.aiEntryFilter && typeof raw.aiEntryFilter === 'object' ? raw.aiEntryFilter : {}
  const rawPerBotOverrides = raw.perBotOverrides && typeof raw.perBotOverrides === 'object' ? raw.perBotOverrides : {}

  return {
    enabled: Boolean(raw.enabled),
    mode: 'rule-adaptive',
    focusSource: raw.focusSource === 'all' ? 'all' : defaultLearningBotSettings.focusSource,
    trainingScope: raw.trainingScope === 'shared' ? 'shared' : 'per-bot',
    focusSignalModelId: typeof raw.focusSignalModelId === 'string' && raw.focusSignalModelId.trim()
      ? raw.focusSignalModelId.trim()
      : defaultLearningBotSettings.focusSignalModelId,
    reviewWindowTrades: clampInteger(
      raw.reviewWindowTrades,
      defaultLearningBotSettings.reviewWindowTrades,
      { min: 0, max: 100000 },
    ),
    minClosedTradesForInsights: clampInteger(
      raw.minClosedTradesForInsights,
      defaultLearningBotSettings.minClosedTradesForInsights,
      { min: 5, max: 200 },
    ),
    minPatternSampleSize: clampInteger(
      raw.minPatternSampleSize,
      defaultLearningBotSettings.minPatternSampleSize,
      { min: 2, max: 20 },
    ),
    requireCandleClose: raw.requireCandleClose !== false,
    blockCounterTrend: raw.blockCounterTrend !== false,
    autoPromoteToPaper: Boolean(raw.autoPromoteToPaper),
    includeBacktestData: raw.includeBacktestData !== false,
    notes: typeof raw.notes === 'string'
      ? raw.notes.trim().slice(0, 600)
      : defaultLearningBotSettings.notes,
    aiTrainer: {
      enabled: Boolean(rawAiTrainer.enabled),
      framework: 'pytorch',
      algorithm: rawAiTrainer.algorithm === 'ppo' ? 'ppo' : 'dqn',
      runtimeCommand: typeof rawAiTrainer.runtimeCommand === 'string' && rawAiTrainer.runtimeCommand.trim()
        ? rawAiTrainer.runtimeCommand.trim().slice(0, 160)
        : defaultLearningBotSettings.aiTrainer.runtimeCommand,
      devicePreference: rawAiTrainer.devicePreference === 'cpu' ? 'cpu' : 'cuda',
      epochs: clampInteger(rawAiTrainer.epochs, defaultLearningBotSettings.aiTrainer.epochs, { min: 1, max: 500 }),
      batchSize: clampInteger(rawAiTrainer.batchSize, defaultLearningBotSettings.aiTrainer.batchSize, { min: 8, max: 2048 }),
      learningRate: Number.isFinite(Number(rawAiTrainer.learningRate)) && Number(rawAiTrainer.learningRate) > 0
        ? Number(rawAiTrainer.learningRate)
        : defaultLearningBotSettings.aiTrainer.learningRate,
      stateWindow: clampInteger(rawAiTrainer.stateWindow, defaultLearningBotSettings.aiTrainer.stateWindow, { min: 4, max: 256 }),
      rewardMode: rawAiTrainer.rewardMode === 'pnl-only' ? 'pnl-only' : 'pnl-risk',
    },
    aiEntryFilter: {
      enabled: Boolean(rawAiEntryFilter.enabled),
      paperOnly: rawAiEntryFilter.paperOnly !== false,
      thresholdScore: clampInteger(
        rawAiEntryFilter.thresholdScore,
        defaultLearningBotSettings.aiEntryFilter.thresholdScore,
        { min: 0, max: 100 },
      ),
    },
    perBotOverrides: Object.fromEntries(
      Object.keys(defaultLearningBotSettings.perBotOverrides).map((modelId) => {
        const rawOverride = rawPerBotOverrides[modelId] && typeof rawPerBotOverrides[modelId] === 'object'
          ? rawPerBotOverrides[modelId]
          : {}

        return [modelId, {
          enabled: Boolean(rawOverride.enabled),
          paperOnly: rawOverride.paperOnly !== false,
          thresholdScore: clampInteger(
            rawOverride.thresholdScore,
            defaultLearningBotSettings.perBotOverrides[modelId].thresholdScore,
            { min: 0, max: 100 },
          ),
        }]
      }),
    ),
  }
}

function formatTerminalTimestamp(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp).replace(',', '')
}

function formatTerminalClock(timestamp = Date.now()) {
  return formatTerminalTimestamp(timestamp).split(' ')[1] || formatTerminalTimestamp(timestamp)
}

function formatTerminalNumber(value, maxDecimals = 6) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'n/a'
  }

  return numericValue.toFixed(maxDecimals).replace(/\.?0+$/, '')
}

function formatSignedTerminalNumber(value, maxDecimals = 2) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return 'n/a'
  }

  const prefix = numericValue > 0 ? '+' : numericValue < 0 ? '-' : ''
  return `${prefix}${formatTerminalNumber(Math.abs(numericValue), maxDecimals)}`
}

function formatTerminalEnabledState(enabled, { onLabel = 'ON', offLabel = 'OFF' } = {}) {
  return enabled
    ? styleTerminal(onLabel, 'bold', 'green')
    : styleTerminal(offLabel, 'bold', 'red')
}

function formatTerminalRuntimeState(running) {
  return running
    ? styleTerminal('RUNNING', 'bold', 'magenta')
    : styleTerminal('IDLE', 'bold', 'gray')
}

function formatLearningBotRuntimeState(trainStatus = defaultLearningBotTrainStatus) {
  if (trainStatus?.running) {
    return styleTerminal('TRAINING', 'bold', 'magenta')
  }

  if (trainStatus?.lastError) {
    return styleTerminal('ERROR', 'bold', 'red')
  }

  if (trainStatus?.metrics?.framework) {
    return styleTerminal('READY', 'bold', 'green')
  }

  return styleTerminal('IDLE', 'bold', 'gray')
}

const TERMINAL_STYLE = process.stdout?.isTTY
  ? {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
  }
  : {
    reset: '',
    bold: '',
    dim: '',
    cyan: '',
    green: '',
    yellow: '',
    red: '',
    magenta: '',
    blue: '',
    gray: '',
    white: '',
  }

function styleTerminal(text, ...styles) {
  const codes = styles
    .map((style) => TERMINAL_STYLE[style] || '')
    .join('')

  if (!codes) {
    return text
  }

  return `${codes}${text}${TERMINAL_STYLE.reset}`
}

function getTerminalToneStyle(tone = 'info') {
  switch (tone) {
    case 'success':
      return 'green'
    case 'warning':
      return 'yellow'
    case 'error':
      return 'red'
    case 'accent':
      return 'magenta'
    case 'muted':
      return 'gray'
    case 'live':
      return 'blue'
    default:
      return 'cyan'
  }
}

function getTerminalWidth() {
  const width = Number(process.stdout?.columns || 96)
  return Math.min(Math.max(width, 72), 120)
}

function terminalRule(character = '-') {
  return character.repeat(Math.max(getTerminalWidth() - 4, 40))
}

function formatTerminalTag(label, tone = 'info') {
  return styleTerminal(`[${label}]`, 'bold', getTerminalToneStyle(tone))
}

function logTerminalLine(label, message, tone = 'info') {
  const time = styleTerminal(formatTerminalClock(), 'dim')
  console.log(`${time} ${formatTerminalTag(label, tone)} ${message}`)
}

function logTerminalBlock(title, lines = [], tone = 'info') {
  const color = getTerminalToneStyle(tone)
  const visibleLines = lines.filter(Boolean)

  console.log('')
  console.log(styleTerminal(terminalRule('='), color))
  console.log(`${styleTerminal(title, 'bold', color)} ${styleTerminal(`(${formatTerminalTimestamp()})`, 'dim')}`)

  for (const line of visibleLines) {
    console.log(`  ${line}`)
  }

  console.log(styleTerminal(terminalRule('-'), 'dim'))
}

function formatTradeModeLabel(mode = '') {
  if (mode === 'binance-futures-testnet') {
    return 'Binance Demo'
  }

  if (mode === 'local-paper') {
    return 'Local Paper'
  }

  return String(mode || 'Unknown')
}

function formatTradeDirectionLabel(side = '') {
  return String(side || '').toUpperCase() === 'BUY'
    ? 'LONG'
    : String(side || '').toUpperCase() === 'SELL'
      ? 'SHORT'
      : String(side || 'n/a')
}

function formatTradePnlText(trade = {}, {
  currentPrice = null,
  exitPrice = null,
} = {}) {
  const priceReference = Number.isFinite(Number(exitPrice)) && Number(exitPrice) > 0
    ? Number(exitPrice)
    : Number(currentPrice)

  if (!Number.isFinite(priceReference) || priceReference <= 0) {
    return null
  }

  return getTradePnlForExitPrice(trade, priceReference)
}

function formatTradeRowForTerminal(trade = {}, {
  currentPrice = null,
  exitPrice = null,
} = {}) {
  const pnl = formatTradePnlText(trade, { currentPrice, exitPrice })
  const priceLabel = Number.isFinite(Number(exitPrice)) && Number(exitPrice) > 0
    ? `exit ${formatTerminalNumber(exitPrice)}`
    : Number.isFinite(Number(currentPrice)) && Number(currentPrice) > 0
      ? `mark ${formatTerminalNumber(currentPrice)}`
      : null

  return [
    trade.walletName || 'Unknown wallet',
    `${trade.symbol || 'n/a'} ${formatTradeDirectionLabel(trade.side)}`,
    `entry ${formatTerminalNumber(trade.entryPrice)}`,
    priceLabel,
    Number.isFinite(Number(pnl)) ? `pnl ${formatSignedTerminalNumber(pnl, 2)} USDT` : null,
    `sl ${formatTerminalNumber(trade.stopLoss)}`,
    `tp ${formatTerminalNumber(trade.takeProfit)}`,
    trade.status ? `status ${trade.status}` : null,
  ].filter(Boolean).join(' | ')
}

function formatMonitorTradeRowForTerminal(trade = {}, { currentPrice = null } = {}) {
  const resolvedCurrentPrice = Number(currentPrice)
  const hasCurrentPrice = Number.isFinite(resolvedCurrentPrice) && resolvedCurrentPrice > 0
  const pnl = hasCurrentPrice ? formatTradePnlText(trade, { currentPrice: resolvedCurrentPrice }) : null

  return [
    trade.walletName || 'Unknown wallet',
    `${trade.symbol || 'n/a'} ${formatTradeDirectionLabel(trade.side)}`,
    `price ${hasCurrentPrice ? formatTerminalNumber(resolvedCurrentPrice) : 'waiting'}`,
    `entry ${formatTerminalNumber(trade.entryPrice)}`,
    Number.isFinite(Number(pnl)) ? `pnl ${formatSignedTerminalNumber(pnl, 2)} USDT` : 'pnl waiting',
    `sl ${formatTerminalNumber(trade.stopLoss)}`,
    `tp ${formatTerminalNumber(trade.takeProfit)}`,
    trade.status ? `status ${trade.status}` : null,
  ].filter(Boolean).join(' | ')
}

function buildTradeDetailLines(trade = {}, {
  currentPrice = null,
  exitPrice = null,
} = {}) {
  const pnl = formatTradePnlText(trade, { currentPrice, exitPrice })

  return [
    `Wallet : ${trade.walletName || 'n/a'}${trade.signalModelName ? ` | ${trade.signalModelName}` : ''}`,
    `Market : ${trade.symbol || 'n/a'} | ${formatTradeDirectionLabel(trade.side)} | ${formatTradeModeLabel(trade.mode)}`,
    `Size   : qty ${formatTerminalNumber(trade.quantity)} | margin ${formatTerminalNumber(trade.margin, 2)} USDT | leverage ${formatTerminalNumber(trade.leverage, 2)}x`,
    `Prices : entry ${formatTerminalNumber(trade.entryPrice)}${Number.isFinite(Number(currentPrice)) && Number(currentPrice) > 0 ? ` | mark ${formatTerminalNumber(currentPrice)}` : ''}${Number.isFinite(Number(exitPrice)) && Number(exitPrice) > 0 ? ` | exit ${formatTerminalNumber(exitPrice)}` : ''}`,
    `Risk   : SL ${formatTerminalNumber(trade.stopLoss)} | TP ${formatTerminalNumber(trade.takeProfit)}`,
    `${Number.isFinite(Number(pnl)) ? `PnL    : ${formatSignedTerminalNumber(pnl, 2)} USDT | ` : ''}Status : ${trade.status || 'n/a'}${trade.result ? ` | Result ${trade.result}` : ''}`,
  ]
}

function getTradeOutcomeTitle(status = '') {
  switch (String(status || '').toUpperCase()) {
    case 'CLOSED_TP':
      return 'Trade Closed - Take Profit'
    case 'CLOSED_SL':
      return 'Trade Closed - Stop Loss'
    case 'CLOSED_MANUAL':
      return 'Trade Closed - Manual Exit'
    case 'CLOSED_TIMEOUT':
      return 'Trade Closed - Time Stop'
    default:
      return 'Trade Closed'
  }
}

function getTradeOutcomeTone(status = '') {
  switch (String(status || '').toUpperCase()) {
    case 'CLOSED_TP':
      return 'success'
    case 'CLOSED_SL':
      return 'error'
    default:
      return 'warning'
  }
}

function shouldLogAutoTradeStep(step = {}) {
  const message = String(step?.message || '')
  const status = String(step?.status || '').toLowerCase()

  if (!message) {
    return false
  }

  if (message.startsWith('No A-grade setup on ')) {
    return false
  }

  return (
    ['blocked', 'pass'].includes(status)
    || message.startsWith('Assigned model:')
    || message.startsWith('Capital mode ')
    || message.startsWith("Today's stats:")
    || message.startsWith('Account snapshot:')
    || message.startsWith('Dedicated risk profile active:')
    || message.startsWith('Enabled wallets:')
    || message.startsWith('Liquidity x volatility scan')
    || message.startsWith('Auto trading is disabled')
    || message.startsWith('Skipped run because')
    || message.startsWith('No volatile futures symbols available')
    || message.startsWith('Loaded strategy settings.')
  )
}

function logAutoTradeStepToTerminal(step = {}) {
  if (!shouldLogAutoTradeStep(step)) {
    return
  }

  const status = String(step?.status || 'info').toLowerCase()
  const label = status === 'pass' ? 'OK' : status === 'blocked' ? 'BLOCK' : 'INFO'
  const tone = status === 'pass' ? 'success' : status === 'blocked' ? 'warning' : 'info'
  const walletLabel = step?.walletName ? `${styleTerminal(step.walletName, 'bold')} | ` : ''
  logTerminalLine(label, `${walletLabel}${step.message}`, tone)
}

function logTradeOpenedToTerminal(trade) {
  logTerminalBlock('Trade Opened', buildTradeDetailLines(trade), 'success')
}

function logTradeClosedToTerminal(trade, closedTrade) {
  logTerminalBlock(
    getTradeOutcomeTitle(closedTrade?.status),
    buildTradeDetailLines(closedTrade, { exitPrice: closedTrade?.exitPrice || trade?.exitPrice }),
    getTradeOutcomeTone(closedTrade?.status),
  )
}

function formatLearningBotStatusLine(trainStatus = defaultLearningBotTrainStatus) {
  const framework = trainStatus?.metrics?.framework || 'pending'
  const device = trainStatus?.metrics?.deviceUsed || 'n/a'
  const errorText = trainStatus?.lastError ? ` | Error ${trainStatus.lastError}` : ''

  return `AI    : ${formatLearningBotRuntimeState(trainStatus)} | Framework ${framework} | Device ${device}${errorText}`
}

function buildTerminalMonitorSnapshot(settings = {}, trades = [], livePriceMap = {}, trainStatus = defaultLearningBotTrainStatus) {
  const enabledWallets = getTradingWallets(settings.wallets).filter((wallet) => wallet.enabled)
  const binanceCount = trades.filter((trade) => trade.mode === 'binance-futures-testnet').length
  const paperCount = trades.filter((trade) => trade.mode === 'local-paper').length
  let pricedTradeCount = 0
  let totalOpenPnl = 0

  const rows = trades.map((trade) => {
    const currentPrice = Number(livePriceMap?.[trade.symbol] || 0)
    const pnl = formatTradePnlText(trade, { currentPrice })
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      pricedTradeCount += 1
    }
    if (Number.isFinite(Number(pnl))) {
      totalOpenPnl += Number(pnl)
    }
    return formatMonitorTradeRowForTerminal(trade, { currentPrice })
  })

  const roundedTotalOpenPnl = Number(totalOpenPnl.toFixed(2))
  const lines = [
    `Auto  : ${formatTerminalEnabledState(Boolean(settings?.strategy?.autoTradingEnabled))} | Runtime ${formatTerminalRuntimeState(autoTradeRuntime.running)} | Wallets ${enabledWallets.length} enabled`,
    formatLearningBotStatusLine(trainStatus),
    `Loops : terminal monitor every 10s | auto-trader scan every 5m | Session ${formatTerminalEnabledState(Boolean(settings?.strategy?.sessionScheduleEnabled))}`,
    `Open  : ${trades.length} trade${trades.length === 1 ? '' : 's'} | Live prices ${pricedTradeCount}/${trades.length} | Unrealized ${formatSignedTerminalNumber(roundedTotalOpenPnl, 2)} USDT`,
    trades.length > 0 ? `Mix   : ${binanceCount} Binance Demo | ${paperCount} Local Paper` : null,
    autoTradeRuntime.lastReason ? `Last  : ${autoTradeRuntime.lastReason}` : null,
    ...(rows.length > 0 ? rows : ['No open trades to monitor right now.']),
  ]
  const signature = JSON.stringify({
    autoTradingEnabled: Boolean(settings?.strategy?.autoTradingEnabled),
    sessionScheduleEnabled: Boolean(settings?.strategy?.sessionScheduleEnabled),
    running: autoTradeRuntime.running,
    lastReason: autoTradeRuntime.lastReason,
    enabledWalletIds: enabledWallets.map((wallet) => wallet.id),
    aiTrainingRunning: Boolean(trainStatus?.running),
    aiTrainingFramework: trainStatus?.metrics?.framework || '',
    aiTrainingDevice: trainStatus?.metrics?.deviceUsed || '',
    aiTrainingError: trainStatus?.lastError || '',
    rows,
    roundedTotalOpenPnl,
    pricedTradeCount,
  })

  return { lines, signature }
}

function logTerminalMonitorSnapshot(settings = {}, trades = [], livePriceMap = {}, trainStatus = defaultLearningBotTrainStatus) {
  const { lines, signature } = buildTerminalMonitorSnapshot(settings, trades, livePriceMap, trainStatus)
  if (signature === lastTerminalTradeMonitorSignature) {
    return
  }

  lastTerminalTradeMonitorSignature = signature
  logTerminalBlock(`Terminal Monitor${trades.length > 0 ? ` (${trades.length} open)` : ''}`, lines, 'live')
}

function normalizeSettings(rawSettings = {}) {
  const rawStrategy = rawSettings && typeof rawSettings === 'object' ? rawSettings.strategy || {} : {}
  const normalizedSettingsRevision = Number.isSafeInteger(Number(rawSettings?.settingsRevision))
    && Number(rawSettings.settingsRevision) > 0
    ? Number(rawSettings.settingsRevision)
    : defaultSettings.settingsRevision
  const strategy = strategySettingKeys.reduce((accumulator, key) => {
    accumulator[key] = key in rawStrategy ? rawStrategy[key] : defaultSettings.strategy[key]
    return accumulator
  }, {})

  strategy.activeSignalModelId = ensureSignalModelId(strategy.activeSignalModelId)
  strategy.bot3RiskPresetId = resolveBot3RiskPresetId(strategy.bot3RiskPresetId)
  strategy.sessionScheduleEnabled = Boolean(strategy.sessionScheduleEnabled)
  strategy.scheduledSessions = normalizeAutoTradeSessions(strategy.scheduledSessions)
  strategy.marginMode = normalizeMarginMode(strategy.marginMode)
  strategy.signalModelStrategies = normalizeSignalModelStrategies(strategy.signalModelStrategies, strategy)
  strategy.symbolRiskProfiles = normalizeSymbolRiskProfiles(strategy.symbolRiskProfiles)
  strategy.maxLossPerTrade = getStrategyDerivedMaxLossPerTrade(strategy)

  return {
    settingsRevision: normalizedSettingsRevision,
    apiKey: typeof rawSettings.apiKey === 'string' ? rawSettings.apiKey : defaultSettings.apiKey,
    secretKey: typeof rawSettings.secretKey === 'string' ? rawSettings.secretKey : defaultSettings.secretKey,
    strategy,
    learningBot: normalizeLearningBotSettings(rawSettings.learningBot),
    wallets: normalizeWallets(rawSettings.wallets),
  }
}

function hasDirectBinanceCredentials(settings = {}) {
  return Boolean(
    typeof settings?.apiKey === 'string'
    && settings.apiKey.trim()
    && typeof settings?.secretKey === 'string'
    && settings.secretKey.trim(),
  )
}

function buildSettingsRecoverySnapshot(settings = defaultSettings) {
  const normalizedSettings = normalizeSettings(settings)

  return {
    updatedAt: Date.now(),
    settingsRevision: normalizedSettings.settingsRevision,
    apiKey: typeof normalizedSettings.apiKey === 'string' ? normalizedSettings.apiKey : '',
    secretKey: typeof normalizedSettings.secretKey === 'string' ? normalizedSettings.secretKey : '',
    strategy: {
      autoTradingEnabled: Boolean(normalizedSettings.strategy.autoTradingEnabled),
    },
    learningBot: normalizeLearningBotSettings(normalizedSettings.learningBot),
  }
}

async function getSettingsRecoverySnapshot() {
  const snapshot = await readJson(settingsRecoveryFilePath, null)

  if (!snapshot || typeof snapshot !== 'object') {
    return null
  }

  return {
    updatedAt: Number(snapshot.updatedAt || 0),
    settingsRevision: Number(snapshot.settingsRevision || 0),
    apiKey: typeof snapshot.apiKey === 'string' ? snapshot.apiKey : '',
    secretKey: typeof snapshot.secretKey === 'string' ? snapshot.secretKey : '',
    strategy: {
      autoTradingEnabled: Boolean(snapshot?.strategy?.autoTradingEnabled),
    },
    learningBot: normalizeLearningBotSettings(snapshot.learningBot),
  }
}

function inspectSettingsRegressionRisk(settings = defaultSettings, recoverySnapshot = null) {
  const normalizedSettings = normalizeSettings(settings)
  const snapshot = recoverySnapshot && typeof recoverySnapshot === 'object'
    ? recoverySnapshot
    : null
  const currentRevision = Number(normalizedSettings.settingsRevision || 0)
  const snapshotRevision = Number(snapshot?.settingsRevision || 0)
  const snapshotIsAtLeastCurrent = snapshotRevision >= currentRevision
  const currentHasCredentials = hasDirectBinanceCredentials(normalizedSettings)
  const snapshotHasCredentials = Boolean(String(snapshot?.apiKey || '').trim() && String(snapshot?.secretKey || '').trim())
  const currentAutoEnabled = Boolean(normalizedSettings.strategy.autoTradingEnabled)
  const snapshotAutoEnabled = Boolean(snapshot?.strategy?.autoTradingEnabled)
  const credentialsRegression = snapshotIsAtLeastCurrent && snapshotHasCredentials && !currentHasCredentials
  const autoEnabledRegression = snapshotIsAtLeastCurrent && snapshotAutoEnabled && !currentAutoEnabled

  return {
    dangerous: Boolean(
      snapshot
      && (
        snapshotRevision > currentRevision
        || credentialsRegression
        || autoEnabledRegression
      )
    ),
    currentRevision,
    snapshotRevision,
    snapshotIsAtLeastCurrent,
    currentHasCredentials,
    snapshotHasCredentials,
    currentAutoEnabled,
    snapshotAutoEnabled,
    credentialsRegression,
    autoEnabledRegression,
  }
}

function buildSettingsRegressionWarningSignature(regressionRisk = {}) {
  return JSON.stringify({
    currentRevision: Number(regressionRisk.currentRevision || 0),
    snapshotRevision: Number(regressionRisk.snapshotRevision || 0),
    snapshotIsAtLeastCurrent: Boolean(regressionRisk.snapshotIsAtLeastCurrent),
    currentHasCredentials: Boolean(regressionRisk.currentHasCredentials),
    snapshotHasCredentials: Boolean(regressionRisk.snapshotHasCredentials),
    currentAutoEnabled: Boolean(regressionRisk.currentAutoEnabled),
    snapshotAutoEnabled: Boolean(regressionRisk.snapshotAutoEnabled),
    credentialsRegression: Boolean(regressionRisk.credentialsRegression),
    autoEnabledRegression: Boolean(regressionRisk.autoEnabledRegression),
  })
}

function logSettingsRegressionWarningOnce(regressionRisk = {}, detail = '') {
  if (!regressionRisk?.dangerous) {
    lastSettingsRegressionWarningSignature = ''
    return
  }

  const signature = buildSettingsRegressionWarningSignature(regressionRisk)
  if (signature === lastSettingsRegressionWarningSignature) {
    return
  }

  lastSettingsRegressionWarningSignature = signature
  logTerminalLine(
    'SETTINGS',
    `Detected a risky settings regression snapshot (rev ${regressionRisk.currentRevision}, recovery rev ${regressionRisk.snapshotRevision}).${detail ? ` ${detail}` : ''}`,
    'warning',
  )
}

async function persistSettingsRecoverySnapshot(settings = defaultSettings, {
  source = 'unknown',
  note = '',
} = {}) {
  const normalizedSettings = normalizeSettings(settings)

  if (!hasDirectBinanceCredentials(normalizedSettings) || !normalizedSettings.strategy.autoTradingEnabled) {
    return null
  }

  const nextSnapshot = buildSettingsRecoverySnapshot(normalizedSettings)
  const previousSnapshot = await getSettingsRecoverySnapshot()
  const currentComparable = previousSnapshot
    ? {
      settingsRevision: Number(previousSnapshot.settingsRevision || 0),
      apiKey: previousSnapshot.apiKey,
      secretKey: previousSnapshot.secretKey,
      autoTradingEnabled: Boolean(previousSnapshot.strategy?.autoTradingEnabled),
      learningBot: normalizeLearningBotSettings(previousSnapshot.learningBot),
    }
    : null
  const nextComparable = {
    settingsRevision: Number(nextSnapshot.settingsRevision || 0),
    apiKey: nextSnapshot.apiKey,
    secretKey: nextSnapshot.secretKey,
    autoTradingEnabled: Boolean(nextSnapshot.strategy.autoTradingEnabled),
    learningBot: normalizeLearningBotSettings(nextSnapshot.learningBot),
  }

  if (currentComparable && JSON.stringify(currentComparable) === JSON.stringify(nextComparable)) {
    return previousSnapshot
  }

  await writeJson(settingsRecoveryFilePath, nextSnapshot)
  logTerminalLine(
    'RECOVERY',
    `Updated armed settings recovery snapshot from ${source}.${note ? ` ${note}` : ''}`.trim(),
    'info',
  )
  return nextSnapshot
}

async function selfHealSettingsIfNeeded(settings = null, {
  source = 'settings-recovery',
  note = '',
} = {}) {
  const currentSettings = settings ? normalizeSettings(settings) : await getSettings()
  const recoverySnapshot = await getSettingsRecoverySnapshot()
  const regressionRisk = inspectSettingsRegressionRisk(currentSettings, recoverySnapshot)
  const fallbackApiKey = recoverySnapshot?.apiKey || process.env.BINANCE_TESTNET_API_KEY || ''
  const fallbackSecretKey = recoverySnapshot?.secretKey || process.env.BINANCE_TESTNET_SECRET_KEY || ''
  const missingApiKey = !String(currentSettings.apiKey || '').trim()
  const missingSecretKey = !String(currentSettings.secretKey || '').trim()
  const shouldRestoreRevision = regressionRisk.dangerous && regressionRisk.snapshotRevision > regressionRisk.currentRevision
  const shouldRestoreCredentials = regressionRisk.credentialsRegression
    && (missingApiKey || missingSecretKey)
    && Boolean(fallbackApiKey && fallbackSecretKey)
  const shouldRestoreAutoTrading = regressionRisk.autoEnabledRegression

  if (!shouldRestoreRevision && !shouldRestoreCredentials && !shouldRestoreAutoTrading) {
    logSettingsRegressionWarningOnce(regressionRisk)
    return {
      settings: currentSettings,
      healed: false,
    }
  }

  logSettingsRegressionWarningOnce(
    regressionRisk,
    shouldRestoreRevision ? 'Promoting revision from the recovery snapshot.' : '',
  )

  const nextSettings = {
    ...currentSettings,
    apiKey: missingApiKey ? fallbackApiKey : currentSettings.apiKey,
    secretKey: missingSecretKey ? fallbackSecretKey : currentSettings.secretKey,
    settingsRevision: shouldRestoreRevision
      ? Math.max(regressionRisk.snapshotRevision, regressionRisk.currentRevision)
      : currentSettings.settingsRevision,
    strategy: {
      ...currentSettings.strategy,
      autoTradingEnabled: shouldRestoreAutoTrading ? true : currentSettings.strategy.autoTradingEnabled,
    },
    learningBot: shouldRestoreRevision && recoverySnapshot?.learningBot
      ? normalizeLearningBotSettings(recoverySnapshot.learningBot)
      : currentSettings.learningBot,
  }
  const savedSettings = await saveSettings(nextSettings, {
    incrementRevision: false,
    currentSettings,
    audit: {
      trigger: 'SETTINGS_SELF_HEAL',
      source,
      note: note || 'Automatically restored armed settings after critical fields were wiped.',
      writeMeta: {
        restoredSettingsRevision: shouldRestoreRevision,
        restoredCredentials: shouldRestoreCredentials,
        restoredAutoTradingEnabled: shouldRestoreAutoTrading,
        usedRecoverySnapshot: Boolean(recoverySnapshot?.apiKey && recoverySnapshot?.secretKey),
        usedEnvironmentCredentials: !recoverySnapshot && Boolean(
          process.env.BINANCE_TESTNET_API_KEY
          && process.env.BINANCE_TESTNET_SECRET_KEY
        ),
      },
    },
  })

  logTerminalLine(
    'RECOVERY',
    `Auto-restored ${[
      shouldRestoreCredentials ? 'Binance credentials' : null,
      shouldRestoreAutoTrading ? 'auto trading' : null,
    ].filter(Boolean).join(' and ')} from the armed recovery snapshot.`,
    'warning',
  )

  return {
    settings: savedSettings,
    healed: true,
  }
}

function mergeSignalModelStrategyUpdates(currentStrategy = {}, strategyUpdates = {}) {
  const currentSignalModelStrategies = normalizeSignalModelStrategies(
    currentStrategy.signalModelStrategies,
    currentStrategy,
  )
  const requestedSignalModelStrategies = strategyUpdates?.signalModelStrategies
  const requestedEntries = requestedSignalModelStrategies && typeof requestedSignalModelStrategies === 'object'
    ? Object.entries(requestedSignalModelStrategies)
    : []

  return Object.fromEntries(
    requestedEntries.map(([modelId, overrides]) => [
      modelId,
      {
        ...(currentSignalModelStrategies[modelId] || {}),
        ...(overrides && typeof overrides === 'object' ? overrides : {}),
      },
    ]),
  )
}

function resolveCredentialUpdate(currentValue = '', requestedValue) {
  const currentCredential = typeof currentValue === 'string' ? currentValue : ''

  if (typeof requestedValue !== 'string') {
    return currentCredential
  }

  // Treat blank credential submissions as "leave the existing secret alone"
  // so a stale or not-yet-loaded settings form cannot wipe stored keys.
  if (!requestedValue.trim() && currentCredential.trim()) {
    return currentCredential
  }

  return requestedValue
}

function mergeSettingsUpdate(currentSettings = defaultSettings, updates = {}) {
  const normalizedCurrentSettings = normalizeSettings(currentSettings)
  const requestedUpdates = updates && typeof updates === 'object' ? updates : {}
  const {
    settingsRevision: _requestedSettingsRevision,
    strategy: requestedStrategyInput,
    ...requestedRootUpdates
  } = requestedUpdates
  const requestedStrategy = requestedStrategyInput && typeof requestedStrategyInput === 'object'
    ? requestedStrategyInput
    : {}
  const mergedStrategy = {
    ...normalizedCurrentSettings.strategy,
    ...requestedStrategy,
    signalModelStrategies: {
      ...normalizeSignalModelStrategies(
        normalizedCurrentSettings.strategy.signalModelStrategies,
        normalizedCurrentSettings.strategy,
      ),
      ...mergeSignalModelStrategyUpdates(normalizedCurrentSettings.strategy, requestedStrategy),
    },
  }

  return {
    ...normalizedCurrentSettings,
    ...requestedRootUpdates,
    apiKey: resolveCredentialUpdate(normalizedCurrentSettings.apiKey, requestedRootUpdates.apiKey),
    secretKey: resolveCredentialUpdate(normalizedCurrentSettings.secretKey, requestedRootUpdates.secretKey),
    strategy: mergedStrategy,
    wallets: 'wallets' in requestedRootUpdates ? requestedRootUpdates.wallets : normalizedCurrentSettings.wallets,
  }
}

function sanitizeTradeHistoryItems(items) {
  return items.filter((item) => item.source !== 'AUTO_TEST')
}

function sanitizeAutoTradeLogItems(items) {
  return items.filter((item) => {
    if (item?.result?.order?.source === 'AUTO_TEST') {
      return false
    }

    if ((item?.result?.steps || []).some((step) => String(step.message || '').includes('Force-test mode active'))) {
      return false
    }

    return true
  })
}

function replaceLegacySignalModelLabels(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll('Model 1', 'Bot 1')
      .replaceAll('Model 2', 'Bot 2')
      .replaceAll('Model 3', 'Bot 3')
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceLegacySignalModelLabels(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, replaceLegacySignalModelLabels(entryValue)]),
  )
}

function normalizeSignalModelMetadata(record, activeSignalModelId = DEFAULT_SIGNAL_MODEL_ID) {
  if (!record || typeof record !== 'object') {
    return record
  }

  const shouldAssignModel = isAutoTradeSource(record.source) || record.signalModelId
  if (!shouldAssignModel) {
    return record
  }

  const signalModelId = ensureSignalModelId(record.signalModelId || activeSignalModelId || DEFAULT_SIGNAL_MODEL_ID)
  const signalModelName = getSignalModelName(signalModelId)
  let nextRecord = record

  if (nextRecord.signalModelId !== signalModelId) {
    nextRecord = {
      ...nextRecord,
      signalModelId,
    }
  }

  if (nextRecord.signalModelName !== signalModelName) {
    nextRecord = {
      ...nextRecord,
      signalModelName,
    }
  }

  return nextRecord
}

function getTickerVolatilityPercent(ticker) {
  const highPrice = Number(ticker?.highPrice || 0)
  const lowPrice = Number(ticker?.lowPrice || 0)
  const lastPrice = Number(ticker?.lastPrice || 0)

  if (highPrice > 0 && lowPrice > 0 && lastPrice > 0) {
    return Number((((highPrice - lowPrice) / lastPrice) * 100).toFixed(2))
  }

  return Number(Math.abs(Number(ticker?.priceChangePercent || 0)).toFixed(2))
}

function normalizeVolatileMarketTicker(ticker) {
  const priceChangePercent = Number(ticker?.priceChangePercent || 0)
  const volatilityPercent = getTickerVolatilityPercent(ticker)
  const quoteVolume = Number(ticker?.quoteVolume || 0)

  return {
    ...ticker,
    symbol: String(ticker?.symbol || ''),
    baseAsset: String(ticker?.symbol || '').replace('USDT', ''),
    quoteAsset: 'USDT',
    lastPrice: Number(ticker?.lastPrice || 0),
    priceChangePercent,
    absoluteChangePercent: Number(Math.abs(priceChangePercent).toFixed(2)),
    volatilityPercent,
    volume: Number(ticker?.volume || 0),
    quoteVolume,
    tradeabilityScore: Number((quoteVolume * volatilityPercent).toFixed(2)),
  }
}

// Stablecoin-vs-USDT pairs (USDC, FDUSD, TUSD, DAI, ...) pass the liquidity x volatility
// scan on raw quote volume alone even though the price barely moves, which lets a
// mean-reversion bot open a position whose bracket distance it can structurally never
// reach (see Bot 5/Bot 6 getting slot-locked on USDCUSDT for days). Excluded outright.
const STABLECOIN_BASE_ASSETS = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'GUSD', 'EURI', 'PYUSD'])

function getTradableUsdtSymbols(exchangeInfo) {
  return new Set(
    (exchangeInfo?.symbols || [])
      .filter((item) => item.status === 'TRADING' && item.quoteAsset === 'USDT' && !STABLECOIN_BASE_ASSETS.has(item.baseAsset))
      .map((item) => item.symbol),
  )
}

function rankVolatileMarkets(tickers, tradableSymbols, limit = VOLATILE_SYMBOL_LIMIT) {
  const normalized = tickers
    .filter((ticker) => String(ticker?.symbol || '').endsWith('USDT'))
    .map((ticker) => normalizeVolatileMarketTicker(ticker))
    .filter((ticker) => ticker.symbol && ticker.lastPrice > 0 && (!tradableSymbols || tradableSymbols.has(ticker.symbol)))

  const liquidCandidates = normalized.filter((ticker) => ticker.quoteVolume >= 10_000_000)
  const source = liquidCandidates.length >= limit ? liquidCandidates : normalized

  return source
    .sort((left, right) => (
      right.tradeabilityScore - left.tradeabilityScore
      || right.quoteVolume - left.quoteVolume
      || right.volatilityPercent - left.volatilityPercent
      || right.absoluteChangePercent - left.absoluteChangePercent
    ))
    .slice(0, limit)
}

// A candidate must have actually moved at least as far as its own stop-loss distance over
// the last 24h before it is accepted. Without this, a low-volatility symbol (a stablecoin
// pair slipping past the liquidity filter, a quiet alt, ...) can score high enough on
// pattern/indicator checks to open a position whose bracket it can never reach, locking
// the wallet's open-position slot indefinitely (see Bot 5/Bot 6 on USDCUSDT).
const CANDIDATE_RANGE_LOOKBACK_HOURS = 24
const MIN_RANGE_TO_STOP_RATIO = 1

function evaluateCandidateRangeViability(candidate, marketInputs) {
  const biasCandles = Array.isArray(marketInputs?.bias) ? marketInputs.bias : []
  const recentCandles = biasCandles.slice(-CANDIDATE_RANGE_LOOKBACK_HOURS)
  const entryPrice = Number(candidate?.entryPrice || 0)
  const stopLoss = Number(candidate?.stopLoss || 0)

  if (recentCandles.length === 0 || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) {
    // Not enough data to evaluate; never block a trade on missing/unavailable market data.
    return { viable: true, rangePercent: null, slDistancePercent: null, rangeHours: recentCandles.length }
  }

  const highestHigh = Math.max(...recentCandles.map((candle) => Number(candle.high)))
  const lowestLow = Math.min(...recentCandles.map((candle) => Number(candle.low)))
  const rangePercent = ((highestHigh - lowestLow) / entryPrice) * 100
  const slDistancePercent = (Math.abs(entryPrice - stopLoss) / entryPrice) * 100

  return {
    viable: rangePercent >= slDistancePercent * MIN_RANGE_TO_STOP_RATIO,
    rangePercent,
    slDistancePercent,
    rangeHours: recentCandles.length,
  }
}

function normalizeTradeRisk(trade, strategy) {
  const effectiveStopLoss = getTradeEffectiveStopLoss(trade, strategy)
  const maxLossPerTrade = getTradeMaxLossPerTrade({
    ...trade,
    stopLoss: effectiveStopLoss ?? trade.stopLoss,
  }, strategy)
  const configuredStopLossPercent = Number(trade?.configuredStopLossPercent ?? strategy.stopLossPercent ?? 0)

  let nextTrade = trade

  if (effectiveStopLoss != null && Number(trade.stopLoss) !== Number(effectiveStopLoss)) {
    nextTrade = {
      ...nextTrade,
      stopLoss: effectiveStopLoss,
    }
  }

  if (maxLossPerTrade != null && Number(nextTrade.maxLossPerTrade) !== Number(maxLossPerTrade)) {
    nextTrade = {
      ...nextTrade,
      maxLossPerTrade,
    }
  }

  if (Number(nextTrade.configuredStopLossPercent) !== configuredStopLossPercent) {
    nextTrade = {
      ...nextTrade,
      configuredStopLossPercent,
    }
  }

  if (nextTrade.status === 'CLOSED_SL' && effectiveStopLoss != null) {
    const cappedPnl = getTradePnlForExitPrice(nextTrade, effectiveStopLoss)
    if (cappedPnl != null && (Number(nextTrade.exitPrice) !== Number(effectiveStopLoss) || Number(nextTrade.pnl) !== cappedPnl)) {
      nextTrade = {
        ...nextTrade,
        exitPrice: effectiveStopLoss,
        pnl: cappedPnl,
      }
    }
  }

  return nextTrade
}

app.use(express.json())

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    String(cookieHeader || '')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf('=')

        if (separatorIndex === -1) {
          return [entry, '']
        }

        return [
          decodeURIComponent(entry.slice(0, separatorIndex).trim()),
          decodeURIComponent(entry.slice(separatorIndex + 1).trim()),
        ]
      }),
  )
}

function areSecureStringsEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8')
  const rightBuffer = Buffer.from(String(right || ''), 'utf8')

  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function buildCookieHeader(name, value, {
  maxAge = null,
  httpOnly = true,
  sameSite = 'Strict',
  secure = process.env.AUTH_COOKIE_SECURE === 'true',
  path: cookiePath = '/',
} = {}) {
  const segments = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${cookiePath}`,
    `SameSite=${sameSite}`,
  ]

  if (Number.isFinite(maxAge)) {
    segments.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`)
  }

  if (httpOnly) {
    segments.push('HttpOnly')
  }

  if (secure) {
    segments.push('Secure')
  }

  return segments.join('; ')
}

function pruneExpiredAuthSessions() {
  const now = Date.now()

  for (const [token, session] of authSessions.entries()) {
    if (!session || session.expiresAt <= now) {
      authSessions.delete(token)
    }
  }
}

function createAuthSession() {
  pruneExpiredAuthSessions()

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + AUTH_SESSION_TTL_MS
  authSessions.set(token, { expiresAt })

  return {
    token,
    expiresAt,
  }
}

function getAuthSessionFromRequest(request) {
  pruneExpiredAuthSessions()

  const cookies = parseCookies(request.headers.cookie)
  const token = cookies[AUTH_SESSION_COOKIE_NAME]

  if (!token) {
    return null
  }

  const session = authSessions.get(token)

  if (!session || session.expiresAt <= Date.now()) {
    authSessions.delete(token)
    return null
  }

  session.expiresAt = Date.now() + AUTH_SESSION_TTL_MS
  authSessions.set(token, session)

  return {
    token,
    expiresAt: session.expiresAt,
  }
}

function attachAuthSessionCookie(response, token, expiresAt) {
  response.setHeader('Set-Cookie', buildCookieHeader(AUTH_SESSION_COOKIE_NAME, token, {
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  }))
}

function clearAuthSessionCookie(response) {
  response.setHeader('Set-Cookie', buildCookieHeader(AUTH_SESSION_COOKIE_NAME, '', {
    maxAge: 0,
  }))
}

function requireAuthenticatedSession(request, response, next) {
  if (authDisabled) {
    next()
    return
  }

  const session = getAuthSessionFromRequest(request)

  if (!session) {
    clearAuthSessionCookie(response)
    response.status(401).json({
      error: 'Authentication required.',
      code: 'AUTH_REQUIRED',
    })
    return
  }

  attachAuthSessionCookie(response, session.token, session.expiresAt)
  request.authSession = session
  next()
}

function getRuntimeProfile() {
  return process.platform === 'win32' ? 'workstation' : 'live-server'
}

function isLiveServerRuntime() {
  return getRuntimeProfile() === 'live-server'
}

function resolveLearningBotRuntimeCommand(command) {
  const normalizedCommand = typeof command === 'string' ? command.trim() : ''

  // Local backtest/dev box: prefer the bundled trainer venv when present so
  // `python3` (which is a Store stub on Windows) resolves to a real interpreter
  // with torch installed. Falls back to `python` on win32, `python3` elsewhere.
  if (process.platform === 'win32') {
    const venvPython = path.join(__dirname, 'learning-bot', '.venv', 'Scripts', 'python.exe')
    if ((!normalizedCommand || normalizedCommand === 'python3' || normalizedCommand === 'python') && existsSync(venvPython)) {
      return venvPython
    }
    if (normalizedCommand === 'python3') {
      return 'python'
    }
  }

  if (!normalizedCommand) {
    return defaultLearningBotTrainerRuntimeCommand
  }

  if (process.platform !== 'win32' && normalizedCommand === 'python') {
    return 'python3'
  }

  return normalizedCommand
}

app.get('/healthz', (_request, response) => {
  response.json({
    ok: true,
    service: 'xeniostrade',
    status: 'healthy',
    mode: process.env.NODE_ENV || 'development',
    runtimeProfile: getRuntimeProfile(),
    marketData: getMarketDataHealthSnapshot(),
  })
})

app.get('/api/auth/session', (request, response) => {
  if (authDisabled) {
    response.json({
      authenticated: true,
    })
    return
  }

  const session = getAuthSessionFromRequest(request)

  if (!session) {
    clearAuthSessionCookie(response)
    response.status(401).json({
      authenticated: false,
    })
    return
  }

  attachAuthSessionCookie(response, session.token, session.expiresAt)
  response.json({
    authenticated: true,
  })
})

app.post('/api/auth/login', (request, response) => {
  const password = String(request.body?.password || '')

  if (!password || !areSecureStringsEqual(password, appLoginPassword)) {
    clearAuthSessionCookie(response)
    response.status(401).json({
      error: 'Incorrect password.',
    })
    return
  }

  const session = createAuthSession()
  attachAuthSessionCookie(response, session.token, session.expiresAt)
  response.json({
    ok: true,
    authenticated: true,
  })
})

app.post('/api/auth/logout', (request, response) => {
  const cookies = parseCookies(request.headers.cookie)
  const token = cookies[AUTH_SESSION_COOKIE_NAME]

  if (token) {
    authSessions.delete(token)
  }

  clearAuthSessionCookie(response)
  response.json({
    ok: true,
    authenticated: false,
  })
})

app.use('/api', (request, response, next) => {
  if (request.path.startsWith('/auth/')) {
    next()
    return
  }

  requireAuthenticatedSession(request, response, next)
})

async function ensureDir() {
  await fs.mkdir(dataDir, { recursive: true })
}

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    if (!content.trim()) {
      return fallback
    }
    return JSON.parse(content)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback
    }

    if (error instanceof SyntaxError) {
      // Primary file is corrupt (e.g. a write interrupted by a crash). Try the
      // last-good backup before falling back to the empty default — silently
      // returning `fallback` here is how a read/modify/write caller can wipe
      // months of trade history after one bad shutdown.
      try {
        const backup = await fs.readFile(`${filePath}.bak`, 'utf8')
        if (backup.trim()) {
          const parsed = JSON.parse(backup)
          console.error(`readJson: ${path.basename(filePath)} was corrupt — recovered from .bak`)
          return parsed
        }
      } catch { /* no usable backup */ }
      console.error(`readJson: ${path.basename(filePath)} was corrupt and no .bak — using fallback`)
      return fallback
    }

    throw error
  }
}

// Files that are large and fully derived from other sources — not worth a .bak
// copy on every write (atomic rename still applies).
const WRITE_JSON_NO_BACKUP = new Set([learningBotDatasetFilePath])

async function writeJson(filePath, value) {
  await ensureDir()
  const json = JSON.stringify(value, null, 2)
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, json)

  if (!WRITE_JSON_NO_BACKUP.has(filePath)) {
    try {
      const prev = await fs.readFile(filePath, 'utf8')
      const trimmed = prev.trim()
      if (trimmed && trimmed !== '[]' && trimmed !== '{}') {
        // Only keep a backup if the current file parses — never overwrite a good
        // .bak with a corrupt primary.
        JSON.parse(prev)
        await fs.writeFile(`${filePath}.bak`, prev)
      }
    } catch { /* no prior file, or prior file already corrupt — leave .bak as-is */ }
  }

  // Atomic replace: a crash leaves either the old file or the complete new one.
  await fs.rename(tmp, filePath)
}

// The learning-bot training dataset artifact ({generatedAt, config, rows}) can
// carry 80k+ feature-rich rows (~600 MB) — past V8's max string length, so it
// must be streamed. Produces valid JSON that Python's json.load reads fine.
async function writeDatasetArtifact(filePath, artifact) {
  await ensureDir()
  const { rows = [], ...rest } = artifact || {}
  if (!Array.isArray(rows) || rows.length < 20_000) {
    await fs.writeFile(filePath, JSON.stringify(artifact ?? {}, null, 2))
    return
  }
  const { writeDatasetArtifactStreamed } = await import('./backtest/ndjson.js')
  await writeDatasetArtifactStreamed(filePath, {
    generatedAt: rest.generatedAt ?? Date.now(),
    config: rest.config ?? {},
    rows,
  })
}

function getContentHash(value = '') {
  return crypto.createHash('sha1').update(String(value)).digest('hex')
}

function summarizeSettingsCredential(value = '') {
  const normalizedValue = typeof value === 'string' ? value : ''
  return {
    present: Boolean(normalizedValue),
    length: normalizedValue.length,
    fingerprint: normalizedValue
      ? getContentHash(normalizedValue).slice(0, 12)
      : null,
  }
}

function sanitizeSettingsForClient(settings = defaultSettings) {
  const normalizedSettings = normalizeSettings(settings)

  return {
    ...normalizedSettings,
    apiKey: '',
    secretKey: '',
    credentials: {
      apiKey: summarizeSettingsCredential(normalizedSettings.apiKey),
      secretKey: summarizeSettingsCredential(normalizedSettings.secretKey),
    },
  }
}

function summarizeSettingsSaveRequestBody(body = {}) {
  const strategy = body?.strategy && typeof body.strategy === 'object'
    ? body.strategy
    : {}
  const signalModelStrategies = strategy.signalModelStrategies && typeof strategy.signalModelStrategies === 'object'
    ? strategy.signalModelStrategies
    : {}

  return {
    rootKeys: Object.keys(body || {}).sort(),
    includesApiKey: typeof body?.apiKey === 'string',
    includesSecretKey: typeof body?.secretKey === 'string',
    strategyKeys: Object.keys(strategy).filter((key) => key !== 'signalModelStrategies').sort(),
    signalModelStrategyKeys: Object.fromEntries(
      Object.entries(signalModelStrategies).map(([modelId, value]) => [
        modelId,
        Object.keys(value && typeof value === 'object' ? value : {}).sort(),
      ]),
    ),
    walletCount: Array.isArray(body?.wallets) ? body.wallets.length : null,
  }
}

async function readSettingsFileAuditState() {
  let raw = ''

  try {
    raw = await fs.readFile(settingsFilePath, 'utf8')
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  let parsed = defaultSettings
  let parseError = null
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    raw,
    hash: getContentHash(raw),
    settings: normalizeSettings(parsed),
    parseError,
  }
}

export async function getSettings() {
  const stored = await readJson(settingsFilePath, defaultSettings)
  const normalized = normalizeSettings(stored)

  if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
    await saveSettings(normalized, {
      currentSettings: stored,
      incrementRevision: false,
      audit: {
        trigger: 'SETTINGS_NORMALIZE',
        source: 'getSettings',
        note: 'Normalized settings file shape while loading settings.',
      },
    })
  }

  const integrityResult = await selfHealSettingsIfNeeded(normalized, {
    source: 'getSettings',
    note: 'Validated loaded settings against the armed recovery snapshot.',
  })

  if (integrityResult.healed) {
    return integrityResult.settings
  }

  return normalized
}

async function saveSettings(nextSettings, {
  incrementRevision = false,
  currentSettings = null,
  audit = null,
} = {}) {
  const latestSettings = currentSettings ? normalizeSettings(currentSettings) : await getSettings()
  const nextSettingsRevision = Number(nextSettings?.settingsRevision || 0)
  const resolvedSettingsRevision = incrementRevision
    ? Number(latestSettings.settingsRevision || defaultSettings.settingsRevision) + 1
    : (Number.isSafeInteger(nextSettingsRevision) && nextSettingsRevision > 0
        ? nextSettingsRevision
        : Number(latestSettings.settingsRevision || defaultSettings.settingsRevision))
  const normalized = normalizeSettings({
    ...nextSettings,
    settingsRevision: resolvedSettingsRevision,
  })
  await writeJson(settingsFilePath, normalized)
  syncObservedSettingsAuditState(normalized)
  await appendSettingsAuditLog({
    trigger: audit?.trigger || 'SETTINGS_WRITE',
    source: audit?.source || 'saveSettings',
    note: audit?.note || '',
    beforeSettings: latestSettings,
    afterSettings: normalized,
    requestMeta: audit?.requestMeta || null,
    writeMeta: audit?.writeMeta || null,
  })
  await persistSettingsRecoverySnapshot(normalized, {
    source: audit?.source || 'saveSettings',
    note: audit?.note || '',
  }).catch((error) => {
    console.error('Failed to update settings recovery snapshot:', error)
  })
  return normalized
}

async function getTradeHistory() {
  const items = await readJson(historyFilePath, [])
  const settings = await getSettings()
  const wallets = normalizeWallets(settings.wallets)
  const sanitized = sanitizeTradeHistoryItems(items).map((item) => (
    hydrateWalletMetadata(
      normalizeSignalModelMetadata(
        normalizeTradeRisk(replaceLegacySignalModelLabels(item), settings.strategy),
        DEFAULT_SIGNAL_MODEL_ID,
      ),
      wallets,
    )
  ))

  if (JSON.stringify(sanitized) !== JSON.stringify(items)) {
    await writeJson(historyFilePath, sanitized)
  }

  return sanitized
}

export function inferLearningBotSetupFamily(signalSummary = '') {
  const summary = String(signalSummary || '').toLowerCase()

  if (summary.includes('support-zone reversal')) {
    return 'Support-zone reversal'
  }

  if (summary.includes('resistance rejection')) {
    return 'Resistance rejection'
  }

  if (summary.includes('bearish breakdown')) {
    return 'Bearish breakdown'
  }

  if (summary.includes('bullish breakout')) {
    return 'Bullish breakout'
  }

  if (summary.includes('ema/rsi bias')) {
    return 'Trend bias scalp'
  }

  if (summary.includes('momentum pullback continuation') || (summary.includes('ema20') && summary.includes('continuation'))) {
    return 'Momentum pullback continuation'
  }

  if (summary.includes('breakout')) {
    return 'Breakout continuation'
  }

  if (summary.includes('liquidity sweep') || summary.includes('trapped') || summary.includes('fake breakout')) {
    return 'Liquidity sweep reversal'
  }

  if (summary.includes('range')) {
    return 'Range scalp'
  }

  return 'Unclassified'
}

function buildLearningBotMistakeTags(trade = {}) {
  const signalSummary = String(trade.signalSummary || '')
  const summary = signalSummary.toLowerCase()
  const pnl = Number(trade.pnl || 0)
  const configuredStopLossPercent = Number(trade.configuredStopLossPercent || 0)
  const leverage = Number(trade.leverage || 0)
  const signalModelId = ensureSignalModelId(trade.signalModelId)
  const side = String(trade.side || '').toUpperCase()
  const tags = []

  if (String(trade.status || '').toUpperCase() === 'CLOSED_SL' || pnl < 0) {
    tags.push('stop-loss-hit')
  }

  if (pnl <= -20) {
    tags.push('severe-loss')
  } else if (pnl <= -10) {
    tags.push('moderate-loss')
  }

  if (configuredStopLossPercent > 0 && configuredStopLossPercent <= 0.9) {
    tags.push('tight-stop')
  }

  if (configuredStopLossPercent >= 5) {
    tags.push('extreme-stop-distance')
  } else if (configuredStopLossPercent >= 2.5) {
    tags.push('wide-stop-distance')
  }

  if (!signalSummary.trim()) {
    tags.push('missing-context')
  }

  if (!summary.includes('confirmed') && !summary.includes('closed decisively')) {
    tags.push('weak-confirmation')
  }

  if (summary.includes('support-zone reversal')) {
    tags.push('support-reversal-loss')
  }

  if (summary.includes('resistance-zone reversal')) {
    tags.push('resistance-reversal-loss')
  }

  if (summary.includes('bullish breakout')) {
    tags.push('bullish-breakout-loss')
  }

  if (summary.includes('bearish breakdown')) {
    tags.push('bearish-breakdown-loss')
  }

  if (summary.includes('liquidity sweep') || summary.includes('fake breakout') || summary.includes('trapped')) {
    tags.push('liquidity-sweep-loss')
  }

  if (summary.includes('momentum pullback continuation') || (summary.includes('ema20') && summary.includes('continuation'))) {
    tags.push('momentum-pullback-loss')
  }

  if (summary.includes('hammer') || summary.includes('tweezer')) {
    tags.push('reversal-candle')
  }

  if (summary.includes('shooting star') || summary.includes('evening star') || summary.includes('morning star') || summary.includes('engulfing')) {
    tags.push('pattern-confirmation-loss')
  }

  if (summary.includes('retest failed')) {
    tags.push('retest-entry')
  }

  if (leverage >= 15) {
    tags.push('high-leverage')
  }

  if (signalModelId === 'model-2' && leverage >= 20) {
    tags.push('bot-2-20x-loss-cluster')
  }

  if (side === 'BUY') {
    tags.push('long-loss')
  } else if (side === 'SELL') {
    tags.push('short-loss')
  }

  return Array.from(new Set(tags))
}

function scoreLearningBotEntryQuality(trade = {}) {
  const summary = String(trade.signalSummary || '').toLowerCase()
  const configuredStopLossPercent = Number(trade.configuredStopLossPercent || 0)
  const leverage = Number(trade.leverage || 0)
  let score = 45

  if (summary.includes('confirmed')) {
    score += 18
  }

  if (summary.includes('closed decisively')) {
    score += 14
  }

  if (summary.includes('hammer') || summary.includes('tweezer')) {
    score += 10
  }

  if (summary.includes('retest failed')) {
    score += 8
  }

  if (!summary.trim()) {
    score -= 18
  }

  if (configuredStopLossPercent > 0 && configuredStopLossPercent <= 0.9) {
    score -= 6
  }

  if (configuredStopLossPercent >= 5) {
    score -= 12
  } else if (configuredStopLossPercent >= 2.5) {
    score -= 7
  }

  if (leverage >= 20) {
    score -= 8
  } else if (leverage >= 15) {
    score -= 5
  }

  return Math.max(0, Math.min(100, Math.round(score)))
}

function buildLearningBotRecommendation(setupFamily, topLossTags = [], config = defaultLearningBotSettings) {
  if (topLossTags.includes('bot-2-20x-loss-cluster')) {
    return `Reduce Bot 2 20x exposure on ${setupFamily.toLowerCase()} until this loss cluster improves.`
  }

  if (topLossTags.includes('severe-loss')) {
    return `Cut size or require stronger confirmation on ${setupFamily.toLowerCase()} because severe losses are clustering in this setup.`
  }

  if (topLossTags.includes('wide-stop-distance') || topLossTags.includes('extreme-stop-distance')) {
    return `Avoid chasing ${setupFamily.toLowerCase()} when the stop distance is wide; wait for a tighter entry closer to invalidation.`
  }

  if (topLossTags.includes('bullish-breakout-loss') || topLossTags.includes('bearish-breakdown-loss')) {
    return `Be stricter with breakout retests on ${setupFamily.toLowerCase()} and reject continuation entries that are late or overextended.`
  }

  if (topLossTags.includes('support-reversal-loss') || topLossTags.includes('resistance-reversal-loss')) {
    return `Require stronger reversal confirmation before trusting ${setupFamily.toLowerCase()} at the zone.`
  }

  if (topLossTags.includes('tight-stop')) {
    return `Reduce early stop pressure on ${setupFamily.toLowerCase()} trades by waiting for a deeper reaction before entry.`
  }

  if (topLossTags.includes('weak-confirmation')) {
    return config.requireCandleClose
      ? `Keep candle-close confirmation mandatory before allowing ${setupFamily.toLowerCase()} entries.`
      : `Add candle-close confirmation before allowing ${setupFamily.toLowerCase()} entries.`
  }

  if (topLossTags.includes('missing-context')) {
    return `Require richer setup notes before trusting ${setupFamily.toLowerCase()} entries in replay or paper mode.`
  }

  if (topLossTags.includes('high-leverage')) {
    return `Lower leverage exposure on ${setupFamily.toLowerCase()} until the loss cluster cools off.`
  }

  if (config.blockCounterTrend) {
    return `Keep ${setupFamily.toLowerCase()} entries aligned with the higher-timeframe trend until the review score improves.`
  }

  return `Reduce confidence on ${setupFamily.toLowerCase()} until replay results improve.`
}

function getLearningBotEligibleClosedTrades(history = [], config = defaultLearningBotSettings) {
  const focusSource = config.focusSource === 'all'
    ? null
    : 'AUTO'
  const focusSignalModelId = config.focusSignalModelId && config.focusSignalModelId !== 'all'
    ? ensureSignalModelId(config.focusSignalModelId)
    : null

  return history
    .filter((trade) => trade.status !== 'OPEN' && Number.isFinite(Number(trade.pnl)))
    .filter((trade) => (focusSource ? String(trade.source || '').startsWith(focusSource) : true))
    .filter((trade) => (focusSignalModelId ? ensureSignalModelId(trade.signalModelId) === focusSignalModelId : true))
}

// Forbidden as AI INPUT — anything known only after the entry. These may appear
// on a training row only inside `label` / `reward` / `mistakeTags` (targets and
// reporting), never inside `features`. buildLearningBotTrainingRowV2 enforces
// this and rl_trainer.py re-checks it at load.
const LEARNING_BOT_FORBIDDEN_FEATURE_KEYS = new Set([
  'status', 'result', 'outcome', 'pnl', 'grossPnl', 'netPnl', 'netR', 'netReturn',
  'exitPrice', 'exitReason', 'win', 'tpBeforeSl', 'timedOut', 'holdBars', 'holdHours',
  'mfe', 'mae', 'maxFavorableExcursion', 'maxAdverseExcursion', 'mistakeTags',
  'reward', 'label', 'closedAt', 'closedDateKey', 'tradeDuration',
])

export function assertNoLeakageInFeatures(features, rowId) {
  if (!features || typeof features !== 'object') return
  for (const key of Object.keys(features)) {
    if (LEARNING_BOT_FORBIDDEN_FEATURE_KEYS.has(key)) {
      throw new Error(`Leakage: forbidden outcome key "${key}" found in features of row ${rowId}`)
    }
  }
}

// v2 training row: explicit features{} (entry-time only) vs label{}/reward (outcome).
export function buildLearningBotTrainingRowV2(trade) {
  const features = trade.features && typeof trade.features === 'object' ? { ...trade.features } : {}
  assertNoLeakageInFeatures(features, trade.id)
  const label = trade.label && typeof trade.label === 'object' ? trade.label : {
    outcome: trade.status,
    win: Number(trade.pnl || 0) > 0 ? 1 : 0,
    tpBeforeSl: trade.status === 'CLOSED_TP' && !trade.timedOut ? 1 : 0,
    netR: null,
    netReturn: null,
    pnl: Number(trade.pnl || 0),
    grossPnl: Number(trade.grossPnl ?? trade.pnl ?? 0),
    frictionUsd: Number(trade.frictionUsd || 0),
    timedOut: Boolean(trade.timedOut),
  }
  return {
    schemaVersion: 2,
    id: trade.id,
    runId: trade.runId || null,
    symbol: trade.symbol,
    isExtendedUniverse: Boolean(trade.isExtendedUniverse),
    timestamp: trade.timestamp || trade.transactTime || null,
    signalModelId: ensureSignalModelId(trade.signalModelId),
    signalModelName: trade.signalModelName || 'Unknown',
    strategyFamily: trade.strategyFamily || getSignalModel(trade.signalModelId)?.strategyFamily || 'legacy',
    setupFamily: trade.setupFamily || inferLearningBotSetupFamily(trade.signalSummary),
    side: trade.side,
    marketRegime: trade.marketRegime || 'UNKNOWN',
    split: trade.split || 'train',
    featureVersion: trade.featureVersion || 'unknown',
    features,
    entryQualityScore: scoreLearningBotEntryQuality(trade), // clean: summary text + SL% + leverage only
    configuredStopLossPercent: Number(Number(trade.configuredStopLossPercent || 0).toFixed(4)),
    leverage: Number(trade.leverage || 0),
    summary: String(trade.signalSummary || '').trim(),
    // ---- targets / reporting only ----
    label,
    reward: Number(trade.reward ?? 0),
    mistakeTags: buildLearningBotMistakeTags(trade), // reporting only — NOT a feature
    // legacy mirrors for existing summarisers
    status: trade.status,
    result: trade.result,
    pnl: Number(Number(trade.pnl || 0).toFixed(2)),
    closedAt: trade.closedAt || trade.transactTime || null,
    tradeDateKey: trade.tradeDateKey || null,
  }
}

export function buildLearningBotDataset(history = [], config = defaultLearningBotSettings) {
  const eligibleClosedTrades = getLearningBotEligibleClosedTrades(history, config)
  // reviewWindowTrades <= 0 means "no window" - train on every eligible closed trade.
  const closedTrades = Number(config.reviewWindowTrades) > 0
    ? eligibleClosedTrades.slice(0, Number(config.reviewWindowTrades))
    : eligibleClosedTrades

  return closedTrades.map((trade) => {
    // v2 rows from the 8-bot replay carry an explicit feature vector + label.
    if (trade.schemaVersion === 2 || (trade.features && typeof trade.features === 'object')) {
      return buildLearningBotTrainingRowV2(trade)
    }

    // Legacy v1 row (old 4-bot data / real trades without a captured feature vector).
    const setupFamily = inferLearningBotSetupFamily(trade.signalSummary)
    const mistakeTags = buildLearningBotMistakeTags(trade)
    const pnl = Number(trade.pnl || 0)

    return {
      schemaVersion: 1,
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      source: trade.source,
      status: trade.status,
      result: trade.result,
      signalModelId: ensureSignalModelId(trade.signalModelId),
      signalModelName: trade.signalModelName || 'Unknown',
      strategyFamily: getSignalModel(trade.signalModelId)?.strategyFamily || 'legacy',
      setupFamily,
      marketRegime: trade.marketRegime || 'UNKNOWN',
      split: trade.split || 'train',
      features: null,
      entryQualityScore: scoreLearningBotEntryQuality(trade),
      mistakeTags,
      pnl: Number(pnl.toFixed(2)),
      reward: Number(pnl.toFixed(2)),
      leverage: Number(trade.leverage || 0),
      configuredStopLossPercent: Number(Number(trade.configuredStopLossPercent || 0).toFixed(4)),
      summary: String(trade.signalSummary || '').trim(),
      closedAt: trade.closedAt || trade.transactTime || null,
      tradeDateKey: trade.tradeDateKey || null,
    }
  })
}

function buildLearningBotSummary(dataset = [], config = defaultLearningBotSettings) {
  const wins = dataset.filter((item) => item.pnl > 0)
  const losses = dataset.filter((item) => item.pnl < 0)
  const totalPnl = dataset.reduce((sum, item) => sum + Number(item.pnl || 0), 0)
  const setupMap = new Map()
  const mistakeCounts = new Map()

  for (const item of dataset) {
    const currentSetup = setupMap.get(item.setupFamily) || {
      key: item.setupFamily.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      setupFamily: item.setupFamily,
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      mistakeCounts: new Map(),
    }

    currentSetup.trades += 1
    currentSetup.totalPnl += Number(item.pnl || 0)
    if (item.pnl > 0) {
      currentSetup.wins += 1
    } else if (item.pnl < 0) {
      currentSetup.losses += 1
    }

    if (item.pnl < 0) {
      for (const tag of item.mistakeTags) {
        currentSetup.mistakeCounts.set(tag, Number(currentSetup.mistakeCounts.get(tag) || 0) + 1)
        mistakeCounts.set(tag, Number(mistakeCounts.get(tag) || 0) + 1)
      }
    }

    setupMap.set(item.setupFamily, currentSetup)
  }

  const patterns = Array.from(setupMap.values())
    .filter((item) => item.trades >= config.minPatternSampleSize)
    .map((item) => {
      const topLossTags = Array.from(item.mistakeCounts.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 3)
        .map(([tag]) => tag)
      const winRate = item.trades > 0 ? item.wins / item.trades : 0

      return {
        key: item.key,
        setupFamily: item.setupFamily,
        trades: item.trades,
        wins: item.wins,
        losses: item.losses,
        winRate: Number((winRate * 100).toFixed(1)),
        totalPnl: Number(item.totalPnl.toFixed(2)),
        avgPnl: Number((item.totalPnl / item.trades).toFixed(2)),
        topLossTags,
        recommendation: buildLearningBotRecommendation(item.setupFamily, topLossTags, config),
      }
    })
    .sort((left, right) => right.losses - left.losses || left.winRate - right.winRate || left.setupFamily.localeCompare(right.setupFamily))

  const topMistakes = Array.from(mistakeCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }))

  const lowConfidenceEntries = dataset
    .filter((item) => item.pnl < 0)
    .sort((left, right) => left.entryQualityScore - right.entryQualityScore || left.pnl - right.pnl)
    .slice(0, 6)

  return {
    generatedAt: Date.now(),
    overview: {
      tradeCount: dataset.length,
      wins: wins.length,
      losses: losses.length,
      winRate: dataset.length > 0 ? Number(((wins.length / dataset.length) * 100).toFixed(1)) : 0,
      totalPnl: Number(totalPnl.toFixed(2)),
      reviewWindowTrades: config.reviewWindowTrades,
      eligibleForInsights: dataset.length >= config.minClosedTradesForInsights,
      focusSource: config.focusSource,
      trainingScope: config.trainingScope,
      focusSignalModelId: config.focusSignalModelId,
    },
    topMistakes,
    patterns,
    lowConfidenceEntries,
    datasetPreview: dataset.slice(0, 12),
  }
}

const defaultLearningBotTrainStatus = {
  running: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastSuccessfulCompletedAt: null,
  lastExitCode: null,
  lastError: '',
  lastCommand: '',
  stdout: '',
  stderr: '',
  metrics: null,
  artifactPath: '',
  artifactGeneratedAt: null,
  datasetFingerprint: '',
}

async function getLearningBotTrainStatus() {
  const status = await readJson(learningBotTrainStatusFilePath, defaultLearningBotTrainStatus)
  return {
    ...defaultLearningBotTrainStatus,
    ...(status && typeof status === 'object' ? status : {}),
  }
}

async function saveLearningBotTrainStatus(status = {}) {
  const nextStatus = {
    ...defaultLearningBotTrainStatus,
    ...(status && typeof status === 'object' ? status : {}),
  }
  await writeJson(learningBotTrainStatusFilePath, nextStatus)
  return nextStatus
}

async function getBacktestHistory() {
  const items = await readJson(backtestHistoryFilePath, [])
  return Array.isArray(items) ? items : []
}

async function getBacktestRunRegistry() {
  const items = await readJson(backtestRunsRegistryFilePath, [])
  return Array.isArray(items) ? items : []
}

async function writeBacktestRunRegistry(runs) {
  const list = Array.isArray(runs) ? runs : []
  list.sort((a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0))
  // Atomic write so a concurrent harness read never sees a torn file.
  const tmp = `${backtestRunsRegistryFilePath}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(list, null, 2))
  await fs.rename(tmp, backtestRunsRegistryFilePath)
  return list
}

// Rows from every registry run flagged includeInTraining. dataFile is stored
// relative to server/data. Missing / unreadable files are skipped, not fatal.
// `alreadyLoadedPaths` lists absolute paths pulled in by another source (e.g. the
// legacy backtest-history.json) so a run pointing at the same file is not read
// twice.
async function getFlaggedBacktestRunRows(alreadyLoadedPaths = []) {
  const registry = await getBacktestRunRegistry()
  const skip = new Set(alreadyLoadedPaths.map((p) => path.resolve(p)))
  const flagged = registry.filter((run) => run && run.includeInTraining === true && run.dataFile)
  const out = []
  const { readRunRows, readRowsNdjson } = await import('./backtest/ndjson.js')
  for (const run of flagged) {
    const abs = path.resolve(dataDir, String(run.dataFile))
    if (skip.has(abs)) continue
    skip.add(abs)
    // Full-feature 5-year datasets are ~600 MB NDJSON — past V8's max string
    // length, so they must be streamed, never JSON.parsed as one blob.
    if (String(run.dataFile).endsWith('.ndjson')) {
      const rows = existsSync(abs)
        ? await readRowsNdjson(abs)
        : await readRunRows(dataDir, run.id)
      for (const row of rows) out.push(row)
      continue
    }
    const rows = await readJson(abs, [])
    if (Array.isArray(rows)) {
      for (const row of rows) out.push(row)
    }
  }
  return out
}

async function getPreferredLearningBotDataset(config = defaultLearningBotSettings) {
  const realHistory = await getTradeHistory()
  const useBacktest = config.includeBacktestData !== false
  const backtestHistory = useBacktest ? await getBacktestHistory() : []
  const flaggedRunRows = useBacktest
    ? await getFlaggedBacktestRunRows(backtestHistory.length > 0 ? [backtestHistoryFilePath] : [])
    : []
  // Real trades first so the training window (when set) prefers them; backtest
  // rows are supplemental bootstrap data. When no per-run file is flagged this is
  // the exact pre-existing fast path (no extra copy) — the dedupe merge only runs
  // when a Backtests-tab run has actually been opted in.
  let history
  if (flaggedRunRows.length === 0) {
    history = backtestHistory.length > 0 ? [...realHistory, ...backtestHistory] : realHistory
  } else {
    history = []
    const seenIds = new Set()
    for (const row of realHistory) {
      if (row && row.id != null) seenIds.add(row.id)
      history.push(row)
    }
    for (const row of [...backtestHistory, ...flaggedRunRows]) {
      const id = row && row.id
      if (id != null) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
      }
      history.push(row)
    }
  }
  const eligibleClosedTradeCount = getLearningBotEligibleClosedTrades(history, config).length
  const dataset = buildLearningBotDataset(history, config)
  const sourceParts = ['local-history']
  if (backtestHistory.length > 0) sourceParts.push(`backtest(${backtestHistory.length})`)
  if (flaggedRunRows.length > 0) sourceParts.push(`runs(${flaggedRunRows.length})`)
  return {
    artifact: buildLearningBotTrainingDatasetArtifact(dataset, config),
    dataset,
    eligibleClosedTradeCount,
    realMoneyTradeTarget: LEARNING_BOT_REAL_MONEY_TRADE_TARGET,
    realMoneyTradeReady: eligibleClosedTradeCount >= LEARNING_BOT_REAL_MONEY_TRADE_TARGET,
    source: sourceParts.join('+'),
  }
}

function buildLearningBotTrainingDatasetArtifact(dataset = [], config = defaultLearningBotSettings) {
  return {
    generatedAt: Date.now(),
    config,
    rows: dataset,
  }
}

function buildLearningBotDatasetFingerprint(dataset = []) {
  if (!Array.isArray(dataset) || dataset.length === 0) {
    return 'empty:0'
  }

  const latest = dataset[0] || {}
  return [
    dataset.length,
    latest.id || 'unknown',
    latest.closedAt || latest.tradeDateKey || 'na',
  ].join(':')
}

// The training dataset is derived from trade-history.json + backtest-history.json
// + flagged per-run files. backtest-history.json alone is ~120 MB / ~117k rows,
// so rebuilding + re-serialising it on every /api/learning-bot/* poll (train
// status polls every 20 s) exhausts the heap. Cache the built artifact and only
// rebuild when an input file's mtime or a relevant config field actually changes.
let learningBotArtifactCache = { key: null, value: null }

async function computeLearningBotDatasetCacheKey(config) {
  const parts = [
    config.includeBacktestData !== false ? 'bt1' : 'bt0',
    `rw${config.reviewWindowTrades || 0}`,
    `fs${config.focusSource || ''}`,
    `sc${config.trainingScope || ''}`,
    `fm${config.focusSignalModelId || ''}`,
  ]
  for (const filePath of [historyFilePath, backtestHistoryFilePath, backtestRunsRegistryFilePath]) {
    try {
      const stat = await fs.stat(filePath)
      parts.push(`${path.basename(filePath)}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${path.basename(filePath)}:0`)
    }
  }
  return parts.join('|')
}

export async function refreshLearningBotDatasetArtifact(config = defaultLearningBotSettings) {
  const cacheKey = await computeLearningBotDatasetCacheKey(config)
  if (learningBotArtifactCache.key === cacheKey && learningBotArtifactCache.value) {
    return learningBotArtifactCache.value
  }

  const { artifact, dataset, eligibleClosedTradeCount, realMoneyTradeTarget, realMoneyTradeReady, source } = await getPreferredLearningBotDataset(config)
  await writeDatasetArtifact(learningBotDatasetFilePath, artifact)

  const result = {
    artifact,
    dataset,
    eligibleClosedTradeCount,
    realMoneyTradeTarget,
    realMoneyTradeReady,
    source,
  }
  learningBotArtifactCache = { key: cacheKey, value: result }
  return result
}

function hydrateLearningBotTrainStatus(status = defaultLearningBotTrainStatus, datasetSnapshot = null) {
  const currentDatasetRows = Number(datasetSnapshot?.dataset?.length || 0)
  const eligibleClosedTradeCount = Number(datasetSnapshot?.eligibleClosedTradeCount ?? currentDatasetRows)
  const realMoneyTradeTarget = Number(datasetSnapshot?.realMoneyTradeTarget || LEARNING_BOT_REAL_MONEY_TRADE_TARGET)

  return {
    ...defaultLearningBotTrainStatus,
    ...(status && typeof status === 'object' ? status : {}),
    currentDatasetRows,
    eligibleClosedTradeCount,
    realMoneyTradeTarget,
    realMoneyTradeReady: eligibleClosedTradeCount >= realMoneyTradeTarget,
    realMoneyTradesRemaining: Math.max(realMoneyTradeTarget - eligibleClosedTradeCount, 0),
    currentDatasetGeneratedAt: datasetSnapshot?.artifact?.generatedAt || null,
    currentDatasetSource: datasetSnapshot?.source || 'local-history',
  }
}

export async function launchLearningBotTraining({ config, dataset }) {
  const currentStatus = await getLearningBotTrainStatus()

  if (currentStatus.running) {
    throw new Error('Learning Bot training is already running.')
  }

  const datasetArtifact = buildLearningBotTrainingDatasetArtifact(dataset, config)
  await writeDatasetArtifact(learningBotDatasetFilePath, datasetArtifact)
  await writeJson(learningBotTrainConfigFilePath, {
    generatedAt: Date.now(),
    learningBot: config,
  })

  const datasetFingerprint = buildLearningBotDatasetFingerprint(dataset)
  const runtimeCommand = resolveLearningBotRuntimeCommand(config.aiTrainer.runtimeCommand)
  const args = [
    learningBotTrainerScriptPath,
    '--dataset',
    learningBotDatasetFilePath,
    '--config',
    learningBotTrainConfigFilePath,
    '--artifact',
    learningBotTrainArtifactFilePath,
  ]
  const lastCommand = `${runtimeCommand} ${args.join(' ')}`
  const startedAt = Date.now()

  await saveLearningBotTrainStatus({
    ...currentStatus,
    running: true,
    lastRunAt: startedAt,
    lastCompletedAt: currentStatus.lastCompletedAt,
    lastExitCode: null,
    lastError: '',
    lastCommand,
    stdout: '',
    stderr: '',
    metrics: null,
    artifactPath: learningBotTrainArtifactFilePath,
    datasetFingerprint,
  })
  logTerminalLine('AI', `Started AI training with command: ${lastCommand}`, 'accent')

  const child = spawn(runtimeCommand, args, {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (chunk) => {
    stdout += String(chunk || '')
  })

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk || '')
  })

  child.on('error', async (error) => {
    const message = error instanceof Error ? error.message : 'Unable to start the trainer runtime.'
    const completedAt = Date.now()
    await saveLearningBotTrainStatus({
      ...currentStatus,
      running: false,
      lastRunAt: startedAt,
      lastCompletedAt: completedAt,
      lastExitCode: -1,
      lastError: message,
      lastCommand,
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000),
      metrics: currentStatus.metrics || null,
      artifactPath: learningBotTrainArtifactFilePath,
      artifactGeneratedAt: currentStatus.artifactGeneratedAt || null,
      lastSuccessfulCompletedAt: currentStatus.lastSuccessfulCompletedAt || null,
      datasetFingerprint,
    })
    logTerminalLine('AI', `AI training failed to start: ${message}`, 'error')
  })

  child.on('close', async (code) => {
    const artifact = await readJson(learningBotTrainArtifactFilePath, null).catch(() => null)
    const completedAt = Date.now()
    const artifactGeneratedAt = Number(artifact?.generatedAt || 0) > 0
      ? Number(artifact.generatedAt)
      : currentStatus.artifactGeneratedAt || null
    const nextMetrics = artifact?.metrics || currentStatus.metrics || null

    await saveLearningBotTrainStatus({
      ...currentStatus,
      running: false,
      lastRunAt: startedAt,
      lastCompletedAt: completedAt,
      lastExitCode: code,
      lastError: code === 0
        ? ''
        : artifact?.error || stderr.trim() || 'Training failed.',
      lastCommand,
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000),
      metrics: nextMetrics,
      artifactPath: learningBotTrainArtifactFilePath,
      artifactGeneratedAt,
      lastSuccessfulCompletedAt: code === 0
        ? completedAt
        : currentStatus.lastSuccessfulCompletedAt || null,
      datasetFingerprint,
    })
    logTerminalLine(
      'AI',
      code === 0
        ? `AI training completed. Framework ${artifact?.metrics?.framework || 'unknown'} on ${artifact?.metrics?.deviceUsed || 'n/a'}.`
        : `AI training exited with code ${code}: ${artifact?.error || stderr.trim() || 'Training failed.'}`,
      code === 0 ? 'success' : 'error',
    )
  })

  return {
    ok: true,
    running: true,
    command: lastCommand,
  }
}

async function maybeRefreshLearningBotPolicy(trigger = 'UNKNOWN', settingsOverride = null) {
  try {
    const settings = settingsOverride || await getSettings()
    const config = normalizeLearningBotSettings(settings.learningBot)
    const aiEntryEnabled = Boolean(
      config.aiTrainer.enabled
      || config.aiEntryFilter.enabled
      || Object.values(config.perBotOverrides || {}).some((item) => item?.enabled),
    )

    if (!aiEntryEnabled) {
      return { started: false, reason: 'disabled' }
    }

    const { dataset } = await refreshLearningBotDatasetArtifact(config)

    if (dataset.length < config.minClosedTradesForInsights) {
      return { started: false, reason: 'not-enough-closed-trades', rows: dataset.length }
    }

    const datasetFingerprint = buildLearningBotDatasetFingerprint(dataset)
    const status = await getLearningBotTrainStatus().catch(() => defaultLearningBotTrainStatus)

    if (status.running) {
      return { started: false, reason: 'already-running' }
    }

    if (status.datasetFingerprint === datasetFingerprint && Number(status.lastExitCode) === 0 && status.metrics) {
      return { started: false, reason: 'up-to-date', rows: dataset.length }
    }

    // aiEntryFilter can be on (scoring live candidates against the current policy)
    // while aiTrainer is off (the policy is a frozen, deliberately-uploaded model —
    // e.g. a CUDA-trained multi-bot artifact). Without this gate every trade close
    // would relaunch a full CPU retrain over the whole backtest-history dataset and
    // overwrite that model.
    if (!config.aiTrainer.enabled) {
      return { started: false, reason: 'auto-retrain-disabled', rows: dataset.length }
    }

    logTerminalLine('AI', `Refreshing AI policy after ${trigger.toLowerCase().replace(/_/g, ' ')} using ${dataset.length} closed trades.`, 'accent')
    await launchLearningBotTraining({ config, dataset })
    return { started: true, rows: dataset.length }
  } catch (error) {
    console.error(`Failed to refresh AI policy after ${trigger}:`, error)
    return {
      started: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function estimateCandidateEntryQuality(candidate = {}) {
  const summary = String(candidate.summary || '').toLowerCase()
  let score = 45

  if (summary.includes('confirmed')) {
    score += 16
  }

  if (summary.includes('closed decisively')) {
    score += 12
  }

  if (summary.includes('hammer') || summary.includes('tweezer') || summary.includes('engulfing')) {
    score += 8
  }

  if (summary.includes('retest')) {
    score += 6
  }

  if (Number(candidate.configuredStopLossPercent || 0) > 0 && Number(candidate.configuredStopLossPercent || 0) <= 0.9) {
    score -= 6
  }

  if (Number(candidate.leverage || 0) >= 20) {
    score -= 4
  }

  return Math.max(0, Math.min(100, Math.round(score)))
}

export function scoreCandidateWithAiFilter(candidate = {}, trainStatus = null, config = defaultLearningBotSettings) {
  const overallPolicy = trainStatus?.metrics?.policy?.setupFamilyScores || {}
  const modelPolicyMap = trainStatus?.metrics?.policy?.bySignalModel || {}
  const setupFamily = inferLearningBotSetupFamily(candidate.summary)
  const candidateSignalModelId = ensureSignalModelId(candidate.signalModelId)
  const modelPolicy = modelPolicyMap?.[candidateSignalModelId]?.setupFamilyScores || {}
  let policySource = 'none'
  let setupStats = null

  if (modelPolicy[setupFamily]) {
    setupStats = modelPolicy[setupFamily]
    policySource = candidateSignalModelId
  } else if (modelPolicy.Unclassified) {
    setupStats = modelPolicy.Unclassified
    policySource = `${candidateSignalModelId}:unclassified`
  } else if (overallPolicy[setupFamily]) {
    setupStats = overallPolicy[setupFamily]
    policySource = 'shared'
  } else if (overallPolicy.Unclassified) {
    setupStats = overallPolicy.Unclassified
    policySource = 'shared:unclassified'
  }
  const entryQualityScore = estimateCandidateEntryQuality({
    summary: candidate.summary,
    configuredStopLossPercent: candidate.configuredStopLossPercent,
    leverage: candidate.leverage,
  })
  const baseScore = entryQualityScore
  const perBotOverride = config.perBotOverrides?.[candidateSignalModelId] || null
  const thresholdScore = Number(
    perBotOverride?.thresholdScore
    ?? config.aiEntryFilter?.thresholdScore
    ?? defaultLearningBotSettings.aiEntryFilter.thresholdScore,
  )
  const liveFilterPaperOnly = perBotOverride?.paperOnly ?? config.aiEntryFilter?.paperOnly ?? true

  // Loss-averse scoring: a setup family this model has historically lost on is
  // penalised harder than a winning one is rewarded, and a proven loser is
  // pushed below the accept threshold so the AI filter skips it outright.
  const rewardValue = setupStats ? Number(setupStats.avgReward || 0) : 0
  const winRateValue = setupStats && setupStats.winRate != null ? Number(setupStats.winRate) : null
  const sampleCount = setupStats ? Number(setupStats.count || 0) : 0
  // A setup family needs at least this many closed trades before its learned
  // stats are trusted enough to gate a bot. Below it the numbers are noise, so
  // their influence is scaled way down and the bot stays in data-collection
  // (bootstrap) mode instead of being frozen by a 1-2 sample fluke.
  const MIN_POLICY_SAMPLES = 5
  const policyReliable = sampleCount >= MIN_POLICY_SAMPLES
  const reliabilityWeight = policyReliable
    ? 1
    : Math.min(1, sampleCount / MIN_POLICY_SAMPLES) * 0.3
  const rewardAdjustment = (setupStats
    ? (rewardValue < 0
      ? Math.max(-32, rewardValue * 3.2)
      : Math.min(16, rewardValue * 1.6))
    : 0) * reliabilityWeight
  const winRateAdjustment = (winRateValue == null
    ? 0
    : (winRateValue < 50
      ? (winRateValue - 50) * 0.7
      : (winRateValue - 50) * 0.3)) * reliabilityWeight
  const provenLoser = policyReliable
    && ((winRateValue != null && winRateValue < 40) || rewardValue <= -3)
  let finalScore = Math.max(0, Math.min(100, Math.round(baseScore + rewardAdjustment + winRateAdjustment)))
  if (provenLoser) {
    finalScore = Math.min(finalScore, Math.max(0, thresholdScore - 12))
  }
  // "Own" policy = trained on this signal model's own trades (not the shared fallback pool).
  const hasOwnModelPolicy = policySource === candidateSignalModelId
    || policySource === `${candidateSignalModelId}:unclassified`
  // Bootstrap: a hard-block bot with no reliable self-trained policy for this
  // setup family keeps trading to build its dataset. Auto-disables the moment
  // the trainer has >= MIN_POLICY_SAMPLES closed trades for the family.
  const bootstrapAccept = !liveFilterPaperOnly && (!hasOwnModelPolicy || !policyReliable)
  const accept = bootstrapAccept || finalScore >= thresholdScore

  return {
    signalModelId: candidateSignalModelId,
    setupFamily,
    setupStats,
    policySource,
    perBotOverride,
    entryQualityScore,
    finalScore,
    thresholdScore,
    hasOwnModelPolicy,
    bootstrapAccept,
    provenLoser,
    accept,
  }
}

function describeAiPolicySource(policySource = 'none', signalModelId = DEFAULT_SIGNAL_MODEL_ID) {
  if (policySource === signalModelId) {
    return `${getSignalModelName(signalModelId)} policy`
  }

  if (policySource === `${signalModelId}:unclassified`) {
    return `${getSignalModelName(signalModelId)} fallback policy`
  }

  if (policySource === 'shared') {
    return 'Shared policy'
  }

  if (policySource === 'shared:unclassified') {
    return 'Shared fallback policy'
  }

  return 'Heuristic baseline'
}

// Chart-pattern influence on the AI entry score. Asymmetric and loss-averse: a
// pattern that CONFIRMS the trade adds little, a pattern that OPPOSES it
// subtracts a lot (a confident opposing pattern can pull a borderline setup
// below the accept threshold).
const PATTERN_AI_SCORE_WEIGHT = 6
const PATTERN_AI_CONFLICT_WEIGHT = 14

// Runs the pattern engine over a candle series and returns a bounded,
// direction-aware score contribution plus a lightweight pattern list.
function computePatternInsight(candles, side) {
  try {
    const series = (Array.isArray(candles) ? candles : [])
      .filter((candle) => candle
        && Number.isFinite(Number(candle.open))
        && Number.isFinite(Number(candle.high))
        && Number.isFinite(Number(candle.low))
        && Number.isFinite(Number(candle.close)))
      .map((candle) => ({
        time: Number(candle.time) || 0,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
      }))

    const { patterns, summary } = detectChartPatterns(series, { candleLookback: 40 })
    const resolvedSide = side === 'SHORT' ? 'SHORT' : 'LONG'
    // The score already weights by confidence x recency; keep the attached list
    // to the few that actually matter so trade logs stay readable.
    const notablePatterns = patterns
      .filter((pattern) => pattern.confidence >= 0.5 || pattern.category === 'chart')
      .slice(0, 4)

    return {
      patternBias: summary.bias,
      patternScore: patternScoreForSide(summary, resolvedSide),
      patterns: notablePatterns.map((pattern) => ({
        name: pattern.name,
        category: pattern.category,
        bias: pattern.bias,
        confidence: Number(pattern.confidence.toFixed(2)),
      })),
      patternSummary: {
        bias: summary.bias,
        score: summary.score,
        count: summary.count,
        top: summary.top
          ? { name: summary.top.name, bias: summary.top.bias, confidence: Number(summary.top.confidence.toFixed(2)) }
          : null,
      },
    }
  } catch {
    return { patternBias: 'neutral', patternScore: 0, patterns: [], patternSummary: null }
  }
}

// Attaches the pattern insight to a completed signal snapshot.
function attachPatternInsight(snapshot, candles) {
  if (!snapshot) {
    return snapshot
  }

  const side = snapshot.checklistSide
    || snapshot.side
    || (snapshot.direction === 'SHORT' ? 'SHORT' : 'LONG')
  return { ...snapshot, ...computePatternInsight(candles, side) }
}

// Applies the bounded pattern nudge to an AI filter decision. The pattern can
// move the final score by at most ±PATTERN_AI_SCORE_WEIGHT and can NOT by
// itself flip accept <-> skip: if the nudge would cross the threshold, the
// original accept verdict is kept while the displayed score still moves.
export function applyPatternAiNudge(decision, patternScore) {
  const base = Number(decision?.finalScore || 0)
  const threshold = Number(decision?.thresholdScore || 0)
  const clamped = Math.max(-1, Math.min(1, Number(patternScore) || 0))
  const weight = clamped < 0 ? PATTERN_AI_CONFLICT_WEIGHT : PATTERN_AI_SCORE_WEIGHT
  const delta = Math.round(clamped * weight)
  const nudged = Math.max(0, Math.min(100, base + delta))
  // Bootstrap-mode passes (no learned policy yet) always go through to grow the
  // dataset; the pattern nudge only moves the displayed score there. Otherwise
  // the nudged score decides accept, so a confirming pattern near the threshold
  // can tip a ready setup in and a conflicting one can tip it out - but the
  // rule-based setup must already be trade-ready, so a pattern never creates a
  // trade on its own.
  const accept = decision?.bootstrapAccept
    ? Boolean(decision.accept)
    : nudged >= threshold

  return {
    delta,
    finalScore: nudged,
    accept,
    flipped: (base >= threshold) !== (nudged >= threshold),
  }
}

function buildSignalAnalysisAiAdvisory(
  analysis = null,
  effectiveStrategy = null,
  learningBotSettings = null,
  trainStatus = null,
) {
  const config = normalizeLearningBotSettings(learningBotSettings)
  const signalModelId = ensureSignalModelId(analysis?.signalModelId)
  const signalModelName = getSignalModelName(signalModelId)
  const perBotOverride = config.perBotOverrides?.[signalModelId] || null
  const thresholdScore = Number(
    perBotOverride?.thresholdScore
    ?? config.aiEntryFilter?.thresholdScore
    ?? defaultLearningBotSettings.aiEntryFilter.thresholdScore,
  )
  const liveFilterEnabled = Boolean(perBotOverride?.enabled || config.aiEntryFilter.enabled)
  const liveFilterPaperOnly = perBotOverride?.paperOnly ?? config.aiEntryFilter.paperOnly
  const liveMode = liveFilterEnabled
    ? (liveFilterPaperOnly ? 'paper-only' : 'hard-block')
    : 'disabled'
  const trainedAt = trainStatus?.artifactGeneratedAt
    || trainStatus?.lastSuccessfulCompletedAt
    || trainStatus?.lastCompletedAt
    || null
  const datasetRows = Number(trainStatus?.metrics?.rows || 0)
  const actionAlignment = Number(trainStatus?.metrics?.actionAlignment || 0)
  const setupFamily = inferLearningBotSetupFamily(analysis?.summary || '')

  if (!analysis) {
    return {
      advisoryOnly: true,
      available: false,
      signalReady: false,
      status: 'unavailable',
      signalModelId,
      signalModelName,
      setupFamily,
      thresholdScore,
      liveMode,
      trainedAt,
      datasetRows,
      actionAlignment,
      policySource: 'none',
      policyLabel: describeAiPolicySource('none', signalModelId),
      sampleCount: 0,
      entryQualityScore: null,
      finalScore: null,
      accept: null,
      setupWinRate: null,
      avgReward: null,
      avgEntryQuality: null,
      detail: 'AI advisory is unavailable because the model analysis did not complete.',
    }
  }

  if (!trainStatus?.metrics || datasetRows <= 0) {
    return {
      advisoryOnly: true,
      available: false,
      signalReady: Boolean(analysis.ready),
      status: 'unavailable',
      signalModelId,
      signalModelName,
      setupFamily,
      thresholdScore,
      liveMode,
      trainedAt,
      datasetRows,
      actionAlignment,
      policySource: 'none',
      policyLabel: describeAiPolicySource('none', signalModelId),
      sampleCount: 0,
      entryQualityScore: null,
      finalScore: null,
      accept: null,
      setupWinRate: null,
      avgReward: null,
      avgEntryQuality: null,
      detail: 'No trained AI artifact is available yet. Run AI training first to unlock advisory scoring.',
    }
  }

  if (!analysis.ready) {
    return {
      advisoryOnly: true,
      available: true,
      signalReady: false,
      status: 'waiting',
      signalModelId,
      signalModelName,
      setupFamily,
      thresholdScore,
      liveMode,
      trainedAt,
      datasetRows,
      actionAlignment,
      policySource: 'none',
      policyLabel: describeAiPolicySource('none', signalModelId),
      sampleCount: 0,
      entryQualityScore: null,
      finalScore: null,
      accept: null,
      setupWinRate: null,
      avgReward: null,
      avgEntryQuality: null,
      detail: 'The rule-based setup is not trade-ready yet, so AI advisory is standing by until a live candidate appears.',
    }
  }

  const leverage = Number(
    effectiveStrategy?.leverage
    || (Number(analysis.margin || 0) > 0
      ? Number(analysis.positionNotional || 0) / Number(analysis.margin || 1)
      : 0),
  )
  const decision = scoreCandidateWithAiFilter({
    summary: analysis.summary,
    configuredStopLossPercent: analysis.configuredStopLossPercent,
    leverage,
    signalModelId,
  }, trainStatus, config)
  const hasLearnedPolicy = Boolean(decision.setupStats)
  const sampleCount = Number(decision.setupStats?.count || 0)

  const patternScore = Number(analysis.patternScore || 0)
  const patternBias = analysis.patternBias || 'neutral'
  const nudge = applyPatternAiNudge(decision, patternScore)
  const patternNote = nudge.delta !== 0
    ? ` Chart patterns (${patternBias}) ${nudge.delta > 0 ? 'added' : 'removed'} ${Math.abs(nudge.delta)} point${Math.abs(nudge.delta) === 1 ? '' : 's'}${nudge.flipped ? ', but not enough on their own to change the verdict' : ''}.`
    : ''

  return {
    advisoryOnly: true,
    available: true,
    signalReady: true,
    status: nudge.accept ? 'accept' : 'caution',
    signalModelId: decision.signalModelId,
    signalModelName,
    setupFamily: decision.setupFamily,
    thresholdScore: decision.thresholdScore,
    liveMode,
    trainedAt,
    datasetRows,
    actionAlignment,
    policySource: decision.policySource,
    policyLabel: describeAiPolicySource(decision.policySource, decision.signalModelId),
    sampleCount,
    hasLearnedPolicy,
    entryQualityScore: decision.entryQualityScore,
    finalScore: nudge.finalScore,
    baseFinalScore: decision.finalScore,
    patternScore: Number(patternScore.toFixed(3)),
    patternBias,
    patternScoreDelta: nudge.delta,
    accept: nudge.accept,
    setupWinRate: decision.setupStats ? Number(decision.setupStats.winRate || 0) : null,
    avgReward: decision.setupStats ? Number(decision.setupStats.avgReward || 0) : null,
    avgEntryQuality: decision.setupStats ? Number(decision.setupStats.avgEntryQuality || 0) : null,
    detail: (hasLearnedPolicy
      ? (
        nudge.accept
          ? `AI would allow this ${decision.setupFamily.toLowerCase()} setup as an advisory pass.`
          : `AI would caution against this ${decision.setupFamily.toLowerCase()} setup for now.`
      )
      : (
        nudge.accept
          ? 'No learned policy matched this setup yet, but the heuristic entry-quality score clears the advisory threshold.'
          : 'No learned policy matched this setup yet, and the heuristic entry-quality score stays below the advisory threshold.'
      )) + patternNote,
  }
}

async function saveTradeHistory(history) {
  await writeJson(historyFilePath, history.slice(0, TRADE_HISTORY_LIMIT))
  return history
}

async function appendTradeHistory(orderRecord) {
  const history = await getTradeHistory()
  history.unshift(orderRecord)
  await saveTradeHistory(history)
  logTradeOpenedToTerminal(orderRecord)
  await persistBotSettingsLog({
    trigger: 'TRADE_OPEN',
    note: `Captured after opening ${orderRecord.symbol} ${orderRecord.side} (${orderRecord.source || 'UNKNOWN'}).`,
    history,
  }).catch((error) => {
    console.error('Failed to persist bot settings log after trade open:', error)
  })
  return orderRecord
}

async function getAutoTradeLog() {
  const items = await readJson(autoTradeLogFilePath, [])
  const sanitized = sanitizeAutoTradeLogItems(items)
  const settings = await getSettings()
  const wallets = normalizeWallets(settings.wallets)
  const hydrated = sanitized.map((item) => {
    const normalizedItem = replaceLegacySignalModelLabels(item)
    const order = hydrateWalletMetadata(
      normalizeSignalModelMetadata(normalizedItem?.result?.order, DEFAULT_SIGNAL_MODEL_ID),
      wallets,
    )

    if (order === normalizedItem?.result?.order && normalizedItem === item) {
      return item
    }

    return {
      ...normalizedItem,
      result: {
        ...normalizedItem.result,
        order,
      },
    }
  })

  if (JSON.stringify(hydrated) !== JSON.stringify(items)) {
    await writeJson(autoTradeLogFilePath, hydrated)
  }

  return hydrated
}

async function getWorkflowReviewLog() {
  return readJson(workflowReviewLogFilePath, [])
}

async function getBotSettingsLog() {
  return readJson(botSettingsLogFilePath, [])
}

function toLoggedNumber(value, decimals = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return 0
  }

  return Number(number.toFixed(decimals))
}

function pickLoggedStrategySettings(strategy = {}, { includeBot3RiskPreset = false } = {}) {
  return {
    ...(includeBot3RiskPreset ? { bot3RiskPresetId: resolveBot3RiskPresetId(strategy.bot3RiskPresetId) } : {}),
    tradeStylePresetId: String(strategy.tradeStylePresetId || MANUAL_TRADE_STYLE_PRESET_ID),
    marginMode: normalizeMarginMode(strategy.marginMode),
    marginPerTrade: toLoggedNumber(strategy.marginPerTrade),
    leverage: toLoggedNumber(strategy.leverage, 4),
    maxOpenPositions: Math.max(Math.floor(Number(strategy.maxOpenPositions || 0)), 0),
    stopLossPercent: toLoggedNumber(strategy.stopLossPercent, 4),
    takeProfitPercent: toLoggedNumber(strategy.takeProfitPercent, 4),
    maxTradesPerDay: Math.max(Math.floor(Number(strategy.maxTradesPerDay || 0)), 0),
    maxLossesPerDay: Math.max(Math.floor(Number(strategy.maxLossesPerDay || 0)), 0),
    maxLossPerDay: toLoggedNumber(strategy.maxLossPerDay),
    dailyProfitTarget: toLoggedNumber(strategy.dailyProfitTarget),
    maxLossPerTrade: toLoggedNumber(strategy.maxLossPerTrade),
  }
}

function pickLoggedAccountSnapshot(accountSnapshot = {}) {
  return {
    runningBalance: toLoggedNumber(accountSnapshot.runningBalance),
    availableBalance: toLoggedNumber(accountSnapshot.availableBalance),
    reservedMargin: toLoggedNumber(accountSnapshot.reservedMargin),
    walletBalance: toLoggedNumber(accountSnapshot.walletBalance),
    realizedPnl: toLoggedNumber(accountSnapshot.realizedPnl),
    unrealizedPnl: toLoggedNumber(accountSnapshot.unrealizedPnl),
    openTradeCount: Math.max(Math.floor(Number(accountSnapshot.openTradeCount || 0)), 0),
    closedTradeCount: Math.max(Math.floor(Number(accountSnapshot.closedTradeCount || 0)), 0),
    winCount: Math.max(Math.floor(Number(accountSnapshot.wins || 0)), 0),
    lossCount: Math.max(Math.floor(Number(accountSnapshot.losses || 0)), 0),
  }
}

function pushSettingsAuditChange(changes, label, beforeValue, afterValue) {
  if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) {
    return
  }

  changes.push(`${label}: ${JSON.stringify(beforeValue)} -> ${JSON.stringify(afterValue)}`)
}

function collectSettingsAuditChanges(beforeSettings = defaultSettings, afterSettings = defaultSettings) {
  const before = normalizeSettings(beforeSettings)
  const after = normalizeSettings(afterSettings)
  const changes = []

  const beforeApiSummary = summarizeSettingsCredential(before.apiKey)
  const afterApiSummary = summarizeSettingsCredential(after.apiKey)
  const beforeSecretSummary = summarizeSettingsCredential(before.secretKey)
  const afterSecretSummary = summarizeSettingsCredential(after.secretKey)

  pushSettingsAuditChange(changes, 'settingsRevision', before.settingsRevision, after.settingsRevision)
  pushSettingsAuditChange(changes, 'apiKey', beforeApiSummary, afterApiSummary)
  pushSettingsAuditChange(changes, 'secretKey', beforeSecretSummary, afterSecretSummary)
  pushSettingsAuditChange(changes, 'strategy.autoTradingEnabled', Boolean(before.strategy.autoTradingEnabled), Boolean(after.strategy.autoTradingEnabled))
  pushSettingsAuditChange(changes, 'strategy.activeSignalModelId', before.strategy.activeSignalModelId, after.strategy.activeSignalModelId)
  pushSettingsAuditChange(changes, 'strategy.sessionScheduleEnabled', Boolean(before.strategy.sessionScheduleEnabled), Boolean(after.strategy.sessionScheduleEnabled))
  pushSettingsAuditChange(changes, 'strategy.preferredSymbols.count', (before.strategy.preferredSymbols || []).length, (after.strategy.preferredSymbols || []).length)
  pushSettingsAuditChange(changes, 'strategy.preferredSymbols.sample', (before.strategy.preferredSymbols || []).slice(0, 5), (after.strategy.preferredSymbols || []).slice(0, 5))

  const beforeSignalModelStrategies = normalizeSignalModelStrategies(before.strategy.signalModelStrategies, before.strategy)
  const afterSignalModelStrategies = normalizeSignalModelStrategies(after.strategy.signalModelStrategies, after.strategy)

  for (const modelId of Object.keys(afterSignalModelStrategies)) {
    const beforeStrategy = pickLoggedStrategySettings(beforeSignalModelStrategies[modelId] || before.strategy)
    const afterStrategy = pickLoggedStrategySettings(afterSignalModelStrategies[modelId] || after.strategy)

    for (const key of Object.keys(afterStrategy)) {
      pushSettingsAuditChange(changes, `${modelId}.${key}`, beforeStrategy[key], afterStrategy[key])
    }
  }

  const beforeWallets = normalizeWallets(before.wallets)
  const afterWallets = normalizeWallets(after.wallets)
  const walletIds = Array.from(new Set([
    ...beforeWallets.map((wallet) => wallet.id),
    ...afterWallets.map((wallet) => wallet.id),
  ]))

  for (const walletId of walletIds) {
    const beforeWallet = beforeWallets.find((wallet) => wallet.id === walletId) || {}
    const afterWallet = afterWallets.find((wallet) => wallet.id === walletId) || {}
    pushSettingsAuditChange(changes, `${walletId}.enabled`, Boolean(beforeWallet.enabled), Boolean(afterWallet.enabled))
    pushSettingsAuditChange(changes, `${walletId}.balanceMode`, beforeWallet.balanceMode || null, afterWallet.balanceMode || null)
    pushSettingsAuditChange(changes, `${walletId}.allocationBalance`, toLoggedNumber(beforeWallet.allocationBalance), toLoggedNumber(afterWallet.allocationBalance))
    pushSettingsAuditChange(changes, `${walletId}.manualBalance`, toLoggedNumber(beforeWallet.manualBalance), toLoggedNumber(afterWallet.manualBalance))
    pushSettingsAuditChange(changes, `${walletId}.assignedSignalModelId`, beforeWallet.assignedSignalModelId || null, afterWallet.assignedSignalModelId || null)
    pushSettingsAuditChange(
      changes,
      `${walletId}.production.syncStatus`,
      beforeWallet.production?.syncStatus || null,
      afterWallet.production?.syncStatus || null,
    )
    pushSettingsAuditChange(
      changes,
      `${walletId}.production.lastError`,
      beforeWallet.production?.lastError || '',
      afterWallet.production?.lastError || '',
    )
  }

  return changes
}

function buildSettingsAuditSummary(changes = []) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return 'No field-level settings changes detected.'
  }

  return changes.slice(0, 8).join(' | ')
}

async function getSettingsAuditLog() {
  return readJson(settingsAuditLogFilePath, [])
}

async function appendSettingsAuditLog({
  trigger = 'SETTINGS_WRITE',
  source = 'unknown',
  note = '',
  beforeSettings = null,
  afterSettings = null,
  requestMeta = null,
  writeMeta = null,
} = {}) {
  const normalizedBefore = beforeSettings ? normalizeSettings(beforeSettings) : normalizeSettings(defaultSettings)
  const normalizedAfter = afterSettings ? normalizeSettings(afterSettings) : normalizeSettings(defaultSettings)
  const changes = collectSettingsAuditChanges(normalizedBefore, normalizedAfter)
  const items = await getSettingsAuditLog()
  const entry = {
    id: `settings-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    pid: process.pid,
    trigger,
    source,
    note,
    summary: buildSettingsAuditSummary(changes),
    changes,
    before: {
      settingsRevision: normalizedBefore.settingsRevision,
      apiKey: summarizeSettingsCredential(normalizedBefore.apiKey),
      secretKey: summarizeSettingsCredential(normalizedBefore.secretKey),
      autoTradingEnabled: Boolean(normalizedBefore.strategy.autoTradingEnabled),
      activeSignalModelId: normalizedBefore.strategy.activeSignalModelId,
    },
    after: {
      settingsRevision: normalizedAfter.settingsRevision,
      apiKey: summarizeSettingsCredential(normalizedAfter.apiKey),
      secretKey: summarizeSettingsCredential(normalizedAfter.secretKey),
      autoTradingEnabled: Boolean(normalizedAfter.strategy.autoTradingEnabled),
      activeSignalModelId: normalizedAfter.strategy.activeSignalModelId,
    },
    requestMeta,
    writeMeta,
  }

  items.unshift(entry)
  await writeJson(settingsAuditLogFilePath, items.slice(0, SETTINGS_AUDIT_LOG_LIMIT))

  if (changes.some((change) => (
    change.startsWith('apiKey:')
    || change.startsWith('secretKey:')
    || change.startsWith('strategy.autoTradingEnabled:')
  ))) {
    logTerminalLine(
      'SETTINGS',
      `${trigger} | ${source} | ${entry.summary}`,
      'warning',
    )
  }

  return entry
}

function syncObservedSettingsAuditState(settings) {
  const normalizedSettings = normalizeSettings(settings)
  lastObservedSettingsSnapshot = normalizedSettings
  lastObservedSettingsFileHash = getContentHash(JSON.stringify(normalizedSettings, null, 2))
}

async function auditObservedSettingsFileChange() {
  const fileState = await readSettingsFileAuditState()

  if (!lastObservedSettingsFileHash) {
    lastObservedSettingsFileHash = fileState.hash
    lastObservedSettingsSnapshot = fileState.settings
    return
  }

  if (fileState.hash === lastObservedSettingsFileHash) {
    return
  }

  const previousSettings = lastObservedSettingsSnapshot || defaultSettings
  await appendSettingsAuditLog({
    trigger: 'SETTINGS_FILE_CHANGE',
    source: 'settings-watchdog',
    note: fileState.parseError
      ? `Detected a direct settings.json rewrite with parse error: ${fileState.parseError}`
      : 'Detected a direct settings.json rewrite outside the normal audited save flow.',
    beforeSettings: previousSettings,
    afterSettings: fileState.settings,
    writeMeta: {
      previousHash: lastObservedSettingsFileHash,
      nextHash: fileState.hash,
      parseError: fileState.parseError,
    },
  })
  const regressionRisk = inspectSettingsRegressionRisk(fileState.settings, await getSettingsRecoverySnapshot())
  logSettingsRegressionWarningOnce(
    regressionRisk,
    `Direct rewrite detected; credentials ${regressionRisk.currentHasCredentials ? 'present' : 'missing'}; auto ${regressionRisk.currentAutoEnabled ? 'on' : 'off'}.`,
  )
  const recoveryResult = await selfHealSettingsIfNeeded(fileState.settings, {
    source: 'settings-watchdog',
    note: 'Validated direct settings rewrite against the armed recovery snapshot.',
  })

  if (recoveryResult.healed) {
    syncObservedSettingsAuditState(recoveryResult.settings)
    return
  }

  lastObservedSettingsFileHash = fileState.hash
  lastObservedSettingsSnapshot = fileState.settings
}

function buildBotSettingsSnapshot(settings = {}, trades = [], livePrices = {}) {
  const normalizedSettings = normalizeSettings(settings)
  const wallets = normalizeWallets(normalizedSettings.wallets)
  const signalModelStrategies = normalizeSignalModelStrategies(
    normalizedSettings.strategy.signalModelStrategies,
    normalizedSettings.strategy,
  )
  const bots = SIGNAL_MODELS.map((modelEntry) => {
    const modelId = modelEntry.id
    const signalModel = getSignalModel(modelId)
    const wallet = wallets.find((item) => item.assignedSignalModelId === modelId) || null
    const walletTrades = wallet
      ? trades.filter((trade) => trade.walletId === wallet.id)
      : trades.filter((trade) => trade.signalModelId === modelId)
    const startingBalance = wallet ? getWalletEffectiveStartingBalance(wallet) : 0
    const baseAccountSnapshot = summarizeAccount({
      trades: walletTrades,
      livePrices,
      strategy: normalizedSettings.strategy,
      startingBalance,
    })
    const effectiveStrategy = getEffectiveSignalModelStrategy(normalizedSettings.strategy, modelId, {
      runningBalance: wallet ? baseAccountSnapshot.runningBalance : null,
    })
    const effectiveAccountSnapshot = summarizeAccount({
      trades: walletTrades,
      livePrices,
      strategy: effectiveStrategy,
      startingBalance,
    })

    return {
      signalModelId: modelId,
      signalModelName: signalModel.name,
      walletId: wallet?.id || null,
      walletName: wallet?.name || null,
      walletEnabled: wallet ? Boolean(wallet.enabled) : false,
      walletBalanceMode: wallet?.balanceMode || null,
      configuredSettings: modelId === 'model-3'
        ? pickLoggedStrategySettings(normalizedSettings.strategy, { includeBot3RiskPreset: true })
        : pickLoggedStrategySettings(signalModelStrategies[modelId] || normalizedSettings.strategy),
      effectiveSettings: pickLoggedStrategySettings(effectiveStrategy, { includeBot3RiskPreset: modelId === 'model-3' }),
      accountSnapshot: pickLoggedAccountSnapshot(effectiveAccountSnapshot),
    }
  })
  const signatureSource = JSON.stringify({
    activeSignalModelId: normalizedSettings.strategy.activeSignalModelId,
    autoTradingEnabled: Boolean(normalizedSettings.strategy.autoTradingEnabled),
    bots,
  })

  return {
    signature: crypto.createHash('sha1').update(signatureSource).digest('hex').slice(0, 12),
    summary: bots.map((bot) => (
      `${bot.signalModelName}: margin ${bot.effectiveSettings.marginPerTrade} x${bot.effectiveSettings.leverage}, `
      + `SL ${bot.effectiveSettings.stopLossPercent}%, TP ${bot.effectiveSettings.takeProfitPercent}%, `
      + `max trades ${bot.effectiveSettings.maxTradesPerDay}, max loss/day ${bot.effectiveSettings.maxLossPerDay}, `
      + `target ${bot.effectiveSettings.dailyProfitTarget}`
    )).join(' | '),
    bots,
  }
}

async function persistBotSettingsLog({
  trigger = 'SYSTEM',
  note = '',
  settings = null,
  history = null,
  livePrices = null,
} = {}) {
  const resolvedSettings = settings ? normalizeSettings(settings) : await getSettings()
  const resolvedHistory = history || await getTradeHistory()
  const resolvedLivePrices = livePrices || (
    resolvedHistory.some((trade) => trade.status === 'OPEN')
      ? await getLivePriceMapForTrades(resolvedHistory.filter((trade) => trade.status === 'OPEN')).catch(() => ({}))
      : {}
  )
  const snapshot = buildBotSettingsSnapshot(resolvedSettings, resolvedHistory, resolvedLivePrices)
  const items = await getBotSettingsLog()

  if (snapshot.signature === lastBotSettingsLogSignature || items[0]?.signature === snapshot.signature) {
    lastBotSettingsLogSignature = snapshot.signature
    return items
  }

  const entry = {
    id: `bot-settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    trigger,
    note,
    signature: snapshot.signature,
    summary: snapshot.summary,
    bots: snapshot.bots,
  }

  items.unshift(entry)
  await writeJson(botSettingsLogFilePath, items.slice(0, 200))
  lastBotSettingsLogSignature = snapshot.signature
  return items
}

async function appendAutoTradeLog(entry) {
  const items = await getAutoTradeLog()
  const record = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...entry,
  }
  items.unshift(record)
  await writeJson(autoTradeLogFilePath, items.slice(0, AUTO_TRADE_LOG_LIMIT))
  broadcastAutoTradeEvent('log', record)

  if (record.type === 'AUTO_RUN') {
    const walletName = record.walletName || 'Wallet'
    const executed = Boolean(record?.result?.executed)
    logTerminalLine(
      'WALLET',
      `${styleTerminal(walletName, 'bold')} | ${record?.result?.reason || 'No reason provided.'}`,
      executed ? 'success' : 'muted',
    )
  }
}

function broadcastAutoTradeEvent(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of autoTradeClients) {
    client.write(message)
  }
}

function setAutoTradeRunningState(running, currentRunId = null) {
  autoTradeRuntime.running = running
  autoTradeRuntime.currentRunId = currentRunId
  if (!running) {
    autoTradeRuntime.cancelRequested = false
  }

  logTerminalBlock(
    running ? 'Auto Trader Started' : 'Auto Trader Finished',
    running
      ? [
        `Run ID : ${currentRunId || 'n/a'}`,
        'Mode   : Binance Demo / Testnet execution pipeline',
      ]
      : [
        `Last   : ${autoTradeRuntime.lastReason || 'No reason recorded.'}`,
      ],
    running ? 'accent' : 'muted',
  )

  broadcastAutoTradeEvent('state', {
    running,
    currentRunId,
    cancelRequested: autoTradeRuntime.cancelRequested,
    lastRunAt: autoTradeRuntime.lastRunAt,
    lastReason: autoTradeRuntime.lastReason,
    lastExecuted: autoTradeRuntime.lastExecuted,
  })
}

function setAutoTradeOutcome(result) {
  autoTradeRuntime.lastRunAt = Date.now()
  autoTradeRuntime.lastReason = result.reason
  autoTradeRuntime.lastExecuted = Boolean(result.executed)
  const orders = Array.isArray(result.orders)
    ? result.orders.filter(Boolean)
    : result.order
      ? [result.order]
      : []

  logTerminalBlock(
    'Auto Trader Result',
    [
      `Status : ${result.executed ? 'ORDER EXECUTED' : 'NO TRADE PLACED'}`,
      `Reason : ${result.reason}`,
      orders.length > 0 ? `Orders : ${orders.length}` : null,
      ...orders.slice(0, 5).map((order, index) => `${index + 1}. ${formatTradeRowForTerminal(order)}`),
    ],
    result.executed ? 'success' : 'warning',
  )

  broadcastAutoTradeEvent('state', {
    running: autoTradeRuntime.running,
    currentRunId: autoTradeRuntime.currentRunId,
    cancelRequested: autoTradeRuntime.cancelRequested,
    lastRunAt: autoTradeRuntime.lastRunAt,
    lastReason: autoTradeRuntime.lastReason,
    lastExecuted: autoTradeRuntime.lastExecuted,
  })
}

function ensureNotCancelled(runSteps) {
  if (autoTradeRuntime.cancelRequested) {
    runSteps.push({ message: 'Manual stop requested. Aborting auto-trade run.', status: 'blocked' })
    return false
  }
  return true
}

function getEffectiveCredentials(settings) {
  return {
    apiKey: settings.apiKey || process.env.BINANCE_TESTNET_API_KEY || '',
    secretKey: settings.secretKey || process.env.BINANCE_TESTNET_SECRET_KEY || '',
  }
}

function hasExchangeCredentials(settings) {
  const { apiKey, secretKey } = getEffectiveCredentials(settings)
  return Boolean(apiKey && secretKey)
}

function getExchangeSyncedWallets(wallets = []) {
  return normalizeWallets(wallets).filter((wallet) => isExchangeSyncWallet(wallet))
}

function getPrimaryExchangeSyncedWallet(wallets = []) {
  return getExchangeSyncedWallets(wallets)[0] || null
}

function requiresBinanceExecution({ wallet = null } = {}) {
  return isExchangeSyncWallet(wallet)
}

function safeParseJson(text, fallback = {}) {
  if (!text) {
    return fallback
  }

  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function toSignedParamValue(value) {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  return String(value)
}

async function fetchSignedFuturesApi(pathname, {
  method = 'GET',
  params = {},
  apiKey,
  secretKey,
} = {}) {
  if (!apiKey || !secretKey) {
    throw new Error('Binance testnet API credentials are required.')
  }

  const urlSearchParams = new URLSearchParams()
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value == null || value === '') {
      return
    }

    urlSearchParams.append(key, toSignedParamValue(value))
  })

  if (!urlSearchParams.has('recvWindow')) {
    urlSearchParams.append('recvWindow', '5000')
  }
  if (!urlSearchParams.has('timestamp')) {
    urlSearchParams.append('timestamp', String(Date.now()))
  }

  const signature = crypto.createHmac('sha256', secretKey).update(urlSearchParams.toString()).digest('hex')
  urlSearchParams.append('signature', signature)

  const requestInit = {
    method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-MBX-APIKEY': apiKey,
    },
  }

  const targetUrl = `${futuresTestnetBaseUrl}${pathname}`
  const response = method === 'GET'
    ? await fetch(`${targetUrl}?${urlSearchParams.toString()}`, requestInit)
    : await fetch(targetUrl, {
      ...requestInit,
      body: urlSearchParams.toString(),
    })

  const text = await response.text()
  const parsed = safeParseJson(text)

  if (!response.ok) {
    throw new Error(parsed.msg || `Binance Futures Testnet request failed: ${method} ${pathname}`)
  }

  return parsed
}

async function setBinanceMarginType({ symbol, marginMode, apiKey, secretKey }) {
  try {
    await fetchSignedFuturesApi('/fapi/v1/marginType', {
      method: 'POST',
      apiKey,
      secretKey,
      params: {
        symbol,
        marginType: marginMode,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const normalizedMessage = message.toLowerCase()
    const canIgnore = (
      normalizedMessage.includes('no need to change margin type')
      || normalizedMessage.includes('margin type cannot be changed if there exists open orders')
      || normalizedMessage.includes('margin type cannot be changed if there exists position')
      || normalizedMessage.includes('position side cannot be changed if there exists open orders')
      || normalizedMessage.includes('position side cannot be changed if there exists position')
    )

    if (!canIgnore) {
      throw error
    }
  }
}

async function setBinanceLeverage({ symbol, leverage, apiKey, secretKey }) {
  await fetchSignedFuturesApi('/fapi/v1/leverage', {
    method: 'POST',
    apiKey,
    secretKey,
    params: {
      symbol,
      leverage,
    },
  })
}

async function fetchBinanceAccountSnapshot({ apiKey, secretKey }) {
  return fetchSignedFuturesApi('/fapi/v2/account', {
    apiKey,
    secretKey,
  })
}

async function fetchBinanceOrderStatus({ symbol, orderId, apiKey, secretKey }) {
  if (!symbol || !orderId) {
    return null
  }

  return fetchSignedFuturesApi('/fapi/v1/order', {
    apiKey,
    secretKey,
    params: {
      symbol,
      orderId,
    },
  })
}

async function fetchBinanceAlgoOrderStatus({ algoId, clientAlgoId, apiKey, secretKey }) {
  if (!algoId && !clientAlgoId) {
    return null
  }

  return fetchSignedFuturesApi('/fapi/v1/algoOrder', {
    apiKey,
    secretKey,
    params: {
      algoId,
      clientAlgoId,
    },
  })
}

async function fetchBinanceUserTrades({ symbol, startTime = 0, limit = 100, apiKey, secretKey }) {
  return fetchSignedFuturesApi('/fapi/v1/userTrades', {
    apiKey,
    secretKey,
    params: {
      symbol,
      startTime,
      limit,
    },
  })
}

async function placeBinanceOrder({ apiKey, secretKey, ...params }) {
  return fetchSignedFuturesApi('/fapi/v1/order', {
    method: 'POST',
    apiKey,
    secretKey,
    params,
  })
}

async function placeBinanceAlgoOrder({ apiKey, secretKey, ...params }) {
  return fetchSignedFuturesApi('/fapi/v1/algoOrder', {
    method: 'POST',
    apiKey,
    secretKey,
    params,
  })
}

async function cancelBinanceOrder({ symbol, orderId, apiKey, secretKey }) {
  if (!symbol || !orderId) {
    return null
  }

  try {
    return await fetchSignedFuturesApi('/fapi/v1/order', {
      method: 'DELETE',
      apiKey,
      secretKey,
      params: {
        symbol,
        orderId,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.toLowerCase().includes('unknown order')) {
      return null
    }

    throw error
  }
}

async function cancelBinanceAlgoOrder({ algoId, clientAlgoId, apiKey, secretKey }) {
  if (!algoId && !clientAlgoId) {
    return null
  }

  try {
    return await fetchSignedFuturesApi('/fapi/v1/algoOrder', {
      method: 'DELETE',
      apiKey,
      secretKey,
      params: {
        algoId,
        clientAlgoId,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message.toLowerCase().includes('unknown order')
      || message.toLowerCase().includes('order does not exist')
      || message.toLowerCase().includes('too late to cancel')
    ) {
      return null
    }

    throw error
  }
}

function getOppositeTradeSide(side) {
  return String(side || '').toUpperCase() === 'BUY' ? 'SELL' : 'BUY'
}

function wasProtectiveOrderTriggered(order = {}) {
  const orderStatus = String(order?.status || '').toUpperCase()
  const algoStatus = String(order?.algoStatus || '').toUpperCase()

  return (
    orderStatus === 'FILLED'
    || ['FILLED', 'TRIGGERED', 'EXECUTED'].includes(algoStatus)
    || Number(order?.actualOrderId || 0) > 0
    || Number(order?.triggerTime || 0) > 0
  )
}

function getProtectiveOrderFillPrice(order = {}, fallbackPrice = 0) {
  const actualPrice = Number(order?.actualPrice || 0)
  if (actualPrice > 0) {
    return actualPrice
  }

  const triggerPrice = Number(order?.triggerPrice || 0)
  if (triggerPrice > 0) {
    return triggerPrice
  }

  return getExchangeOrderFillPrice(order, fallbackPrice)
}

async function fetchProtectiveOrderStatus({
  symbol,
  orderId,
  algoId,
  clientAlgoId,
  apiKey,
  secretKey,
}) {
  if (algoId || clientAlgoId) {
    return fetchBinanceAlgoOrderStatus({
      algoId,
      clientAlgoId,
      apiKey,
      secretKey,
    })
  }

  if (symbol && orderId) {
    return fetchBinanceOrderStatus({
      symbol,
      orderId,
      apiKey,
      secretKey,
    })
  }

  return null
}

async function cancelProtectiveOrder({
  symbol,
  orderId,
  algoId,
  clientAlgoId,
  apiKey,
  secretKey,
}) {
  if (algoId || clientAlgoId) {
    return cancelBinanceAlgoOrder({
      algoId,
      clientAlgoId,
      apiKey,
      secretKey,
    })
  }

  if (symbol && orderId) {
    return cancelBinanceOrder({
      symbol,
      orderId,
      apiKey,
      secretKey,
    })
  }

  return null
}

function getTrackedTradeQuantity(trade = {}) {
  return Number(trade.exchangeExecutedQuantity ?? trade.quantity ?? 0)
}

function isBinanceTestnetTrade(trade = {}) {
  return String(trade?.mode || '') === 'binance-futures-testnet'
}

function isOpenExchangeOrder(order) {
  return ['NEW', 'PARTIALLY_FILLED', 'ACCEPTED'].includes(String(order?.status || '').toUpperCase())
}

function getExchangeOrderFillPrice(order, fallbackPrice = 0) {
  const avgPrice = Number(order?.avgPrice || 0)
  if (avgPrice > 0) {
    return avgPrice
  }

  const stopPrice = Number(order?.stopPrice || 0)
  if (stopPrice > 0) {
    return stopPrice
  }

  const price = Number(order?.price || 0)
  if (price > 0) {
    return price
  }

  return Number(fallbackPrice || 0)
}

function getExchangePositionAmount(accountSnapshot = {}, symbol) {
  const matchingPosition = Array.isArray(accountSnapshot?.positions)
    ? accountSnapshot.positions.find((position) => String(position?.symbol || '') === String(symbol || ''))
    : null

  return Number(matchingPosition?.positionAmt || 0)
}

function isTradePositionStillOpenOnExchange(trade = {}, accountSnapshot = {}) {
  const positionAmount = getExchangePositionAmount(accountSnapshot, trade.symbol)
  if (!Number.isFinite(positionAmount) || Math.abs(positionAmount) < 1e-8) {
    return false
  }

  return String(trade.side || '').toUpperCase() === 'BUY'
    ? positionAmount > 0
    : positionAmount < 0
}

function getMarketDataCacheEntry(cacheKey) {
  if (!cacheKey) {
    return null
  }

  return marketDataCache.get(cacheKey) || null
}

function isMarketDataCircuitOpen() {
  return Date.now() < Number(marketDataReliability.circuitOpenUntil || 0)
}

function getMarketDataCacheTtlForKlineInterval(interval) {
  if (interval === '1m') {
    return MARKET_DATA_1M_KLINE_CACHE_TTL_MS
  }

  if (interval === '5m') {
    return MARKET_DATA_5M_KLINE_CACHE_TTL_MS
  }

  if (interval === '15m') {
    return MARKET_DATA_15M_KLINE_CACHE_TTL_MS
  }

  if (interval === '1h') {
    return MARKET_DATA_1H_KLINE_CACHE_TTL_MS
  }

  return MARKET_DATA_CONTEXT_CACHE_TTL_MS
}

function getHttpStatusFromError(error) {
  const match = String(error?.message || '').match(/Request failed: (\d+)/)
  return match ? Number(match[1]) : null
}

function isTimeoutLikeError(error) {
  const message = String(error?.message || '')
  return message.includes('aborted')
    || message.includes('fetch failed')
    || error?.name === 'AbortError'
    || error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
}

function recordMarketDataSuccess() {
  marketDataReliability.successes += 1
  marketDataReliability.consecutiveFailures = 0
  marketDataReliability.failureWindowStartedAt = 0
  marketDataReliability.lastSuccessAt = Date.now()
}

async function logMarketData4xx({ status, url = '', message = '' }) {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    status,
    universeLimit: VOLATILE_SYMBOL_LIMIT,
    url,
    message: String(message || '').slice(0, 300),
  })}\n`

  try {
    try {
      const stat = await fs.stat(marketData4xxLogFilePath)
      if (stat.size >= MARKET_DATA_4XX_LOG_MAX_BYTES) {
        await fs.rename(marketData4xxLogFilePath, `${marketData4xxLogFilePath}.1`)
      }
    } catch {
      // No existing file (or stat failed); appendFile will create it.
    }
    await fs.appendFile(marketData4xxLogFilePath, line)
  } catch {
    // Logging must never break a market-data request.
  }
}

function recordMarketDataFailure(error, context = {}) {
  const now = Date.now()
  const status = getHttpStatusFromError(error)
  marketDataReliability.failures += 1
  marketDataReliability.lastFailureAt = now
  marketDataReliability.lastFailureMessage = error instanceof Error ? error.message : String(error)
  marketDataReliability.lastFailureStatus = status

  if (status != null && status >= 400 && status < 500) {
    marketDataReliability.fourXx += 1
    marketDataReliability.fourXxByStatus[status] = (marketDataReliability.fourXxByStatus[status] || 0) + 1
    marketDataReliability.fourXxLastAt = now
    void logMarketData4xx({
      status,
      url: context.url || '',
      message: marketDataReliability.lastFailureMessage,
    })
  }

  if (status === 418 || status === 429) {
    marketDataReliability.rateLimited += 1
  }

  if (isTimeoutLikeError(error)) {
    marketDataReliability.timeouts += 1
  }

  if (!marketDataReliability.failureWindowStartedAt || now - marketDataReliability.failureWindowStartedAt > MARKET_DATA_CIRCUIT_WINDOW_MS) {
    marketDataReliability.failureWindowStartedAt = now
    marketDataReliability.consecutiveFailures = 1
  } else {
    marketDataReliability.consecutiveFailures += 1
  }

  if (
    status === 418
    || status === 429
    || marketDataReliability.consecutiveFailures >= MARKET_DATA_CIRCUIT_FAILURE_THRESHOLD
  ) {
    const cooldown = status === 418 || status === 429
      ? MARKET_DATA_CIRCUIT_COOLDOWN_MS * 2
      : MARKET_DATA_CIRCUIT_COOLDOWN_MS
    marketDataReliability.circuitOpenUntil = Math.max(marketDataReliability.circuitOpenUntil, now + cooldown)
    marketDataReliability.circuitOpened += 1
  }
}

function getMarketDataHealthSnapshot() {
  const now = Date.now()
  return {
    degraded: isMarketDataCircuitOpen(),
    circuitOpenUntil: marketDataReliability.circuitOpenUntil || null,
    circuitOpenForMs: Math.max(0, Number(marketDataReliability.circuitOpenUntil || 0) - now),
    requests: marketDataReliability.requests,
    cacheHits: marketDataReliability.cacheHits,
    inFlightHits: marketDataReliability.inFlightHits,
    staleServed: marketDataReliability.staleServed,
    successes: marketDataReliability.successes,
    failures: marketDataReliability.failures,
    timeouts: marketDataReliability.timeouts,
    rateLimited: marketDataReliability.rateLimited,
    circuitOpened: marketDataReliability.circuitOpened,
    consecutiveFailures: marketDataReliability.consecutiveFailures,
    lastSuccessAt: marketDataReliability.lastSuccessAt,
    lastFailureAt: marketDataReliability.lastFailureAt,
    lastFailureMessage: marketDataReliability.lastFailureMessage,
    lastFailureStatus: marketDataReliability.lastFailureStatus,
    fourXx: marketDataReliability.fourXx,
    fourXxByStatus: { ...marketDataReliability.fourXxByStatus },
    fourXxLastAt: marketDataReliability.fourXxLastAt,
    universeLimit: VOLATILE_SYMBOL_LIMIT,
    cacheEntries: marketDataCache.size,
    inflightRequests: marketDataInflightRequests.size,
  }
}

async function fetchJson(url, {
  timeoutMs = 15_000,
  retries = 1,
  fallbackUrl = null,
  cacheKey = '',
  cacheTtlMs = 0,
  allowStaleOnError = true,
  staleMaxAgeMs = MARKET_DATA_STALE_MAX_AGE_MS,
} = {}) {
  marketDataReliability.requests += 1
  const now = Date.now()
  const cached = getMarketDataCacheEntry(cacheKey)

  if (cached && cacheTtlMs > 0 && now - cached.updatedAt <= cacheTtlMs) {
    marketDataReliability.cacheHits += 1
    return cached.data
  }

  if (cacheKey && marketDataInflightRequests.has(cacheKey)) {
    marketDataReliability.inFlightHits += 1
    return marketDataInflightRequests.get(cacheKey)
  }

  if (cacheKey && cached && allowStaleOnError && isMarketDataCircuitOpen() && now - cached.updatedAt <= staleMaxAgeMs) {
    marketDataReliability.staleServed += 1
    return cached.data
  }

  const requestPromise = (async () => {
    const targets = [url, ...(fallbackUrl ? [fallbackUrl] : [])]
    let lastError = null
    let lastTarget = url

    for (const target of targets) {
      lastTarget = target
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const response = await fetch(target, { signal: controller.signal })

            if (!response.ok) {
              throw new Error(`Request failed: ${response.status}`)
            }

            const payload = await response.json()
            if (cacheKey && cacheTtlMs > 0) {
              marketDataCache.set(cacheKey, {
                data: payload,
                updatedAt: Date.now(),
              })
            }
            recordMarketDataSuccess()
            return payload
          } finally {
            clearTimeout(timeout)
          }
        } catch (error) {
          lastError = error
          if (attempt < retries) {
            // Exponential backoff with jitter; back off harder when the upstream
            // is rate-limiting or refusing connections so a retry storm doesn't
            // make things worse.
            const code = error?.cause?.code || ''
            const rateLimited = /Request failed: 429|Request failed: 418/.test(String(error?.message || ''))
            const connectStalled = code === 'UND_ERR_CONNECT_TIMEOUT' || error?.name === 'AbortError'
            const base = (rateLimited || connectStalled) ? 1200 : 350
            const wait = Math.round(base * (2 ** attempt) * (1 + Math.random() * 0.4))
            await new Promise((resolve) => setTimeout(resolve, wait))
            continue
          }
        }
      }
    }

    recordMarketDataFailure(lastError, { url: lastTarget })

    if (cacheKey && cached && allowStaleOnError && Date.now() - cached.updatedAt <= staleMaxAgeMs) {
      marketDataReliability.staleServed += 1
      return cached.data
    }

    throw lastError
  })()

  if (cacheKey) {
    marketDataInflightRequests.set(cacheKey, requestPromise)
  }

  try {
    return await requestPromise
  } finally {
    if (cacheKey) {
      marketDataInflightRequests.delete(cacheKey)
    }
  }
}

async function fetchKlines(symbol, interval, limit) {
  const path = `/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  return fetchJson(`${publicDataBaseUrl}${path}`, {
    retries: 1,
    timeoutMs: 9_000,
    fallbackUrl: `${publicDataFallbackBaseUrl}${path}`,
    cacheKey: `klines:${symbol}:${interval}:${limit}`,
    cacheTtlMs: getMarketDataCacheTtlForKlineInterval(interval),
  })
}

async function fetchFuturesDepth(symbol, limit = 20) {
  return fetchJson(`${futuresTestnetBaseUrl}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`, {
    retries: 1,
    timeoutMs: 9_000,
    cacheKey: `futures-depth:${symbol}:${limit}`,
    cacheTtlMs: MARKET_DATA_CONTEXT_CACHE_TTL_MS,
  })
}

async function fetchFuturesPremiumIndex(symbol) {
  return fetchJson(`${futuresTestnetBaseUrl}/fapi/v1/premiumIndex?symbol=${symbol}`, {
    timeoutMs: 9_000,
    retries: 1,
    cacheKey: `futures-premium:${symbol}`,
    cacheTtlMs: MARKET_DATA_CONTEXT_CACHE_TTL_MS,
  })
}

async function fetch24HourTickers() {
  const path = '/ticker/24hr'
  return fetchJson(`${publicDataBaseUrl}${path}`, {
    retries: 1,
    fallbackUrl: `${publicDataFallbackBaseUrl}${path}`,
    cacheKey: 'ticker-24hr:all',
    cacheTtlMs: VOLATILE_MARKET_CACHE_TTL_MS,
  })
}

async function fetchTickerPrice(symbol) {
  const path = `/ticker/price?symbol=${symbol}`
  return fetchJson(`${publicDataBaseUrl}${path}`, {
    retries: 1,
    fallbackUrl: `${publicDataFallbackBaseUrl}${path}`,
    cacheKey: `ticker-price:${symbol}`,
    cacheTtlMs: MARKET_DATA_TICKER_CACHE_TTL_MS,
  })
}

async function getLivePriceMapForTrades(trades) {
  const symbols = Array.from(new Set(trades.map((trade) => trade.symbol).filter(Boolean)))

  if (symbols.length === 0) {
    return {}
  }

  const settled = await Promise.allSettled(symbols.map(async (symbol) => {
    const ticker = await fetchTickerPrice(symbol)
    return [symbol, Number(ticker.price || 0)]
  }))

  return Object.fromEntries(
    settled
      .filter((result) => result.status === 'fulfilled' && Number.isFinite(result.value[1]) && result.value[1] > 0)
      .map((result) => result.value),
  )
}

function isTransientUpstreamError(error) {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message.startsWith('Request failed:')
    || error.message === 'fetch failed'
    || error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
}

async function fetchFuturesExchangeInfo({ forceRefresh = false, allowStale = true } = {}) {
  const now = Date.now()
  if (!forceRefresh && exchangeInfoCache.data && now - exchangeInfoCache.updatedAt < EXCHANGE_INFO_CACHE_TTL_MS) {
    return exchangeInfoCache.data
  }

  try {
    const exchangeInfo = await fetchJson(`${futuresTestnetBaseUrl}/fapi/v1/exchangeInfo`, {
      cacheKey: 'futures-exchange-info',
      cacheTtlMs: EXCHANGE_INFO_CACHE_TTL_MS,
    })
    exchangeInfoCache.updatedAt = now
    exchangeInfoCache.data = exchangeInfo
    return exchangeInfo
  } catch (error) {
    if (allowStale && exchangeInfoCache.data && isTransientUpstreamError(error)) {
      return exchangeInfoCache.data
    }

    throw error
  }
}

async function getVolatileMarketsSnapshot({ limit = VOLATILE_SYMBOL_LIMIT, exchangeInfo = null, forceRefresh = false } = {}) {
  const now = Date.now()

  if (!forceRefresh && volatileMarketCache.items.length >= limit && now - volatileMarketCache.updatedAt < VOLATILE_MARKET_CACHE_TTL_MS) {
    return volatileMarketCache.items.slice(0, limit)
  }

  try {
    const [tickers, resolvedExchangeInfo] = await Promise.all([
      fetch24HourTickers(),
      exchangeInfo ? Promise.resolve(exchangeInfo) : fetchFuturesExchangeInfo(),
    ])
    const tradableSymbols = getTradableUsdtSymbols(resolvedExchangeInfo)
    const items = rankVolatileMarkets(tickers, tradableSymbols, limit)

    if (items.length > 0) {
      volatileMarketCache.updatedAt = now
      volatileMarketCache.items = items
    }

    return items
  } catch (error) {
    if (volatileMarketCache.items.length > 0) {
      return volatileMarketCache.items.slice(0, limit)
    }

    throw error
  }
}

async function syncPreferredSymbolsWithVolatility(settings, exchangeInfo = null) {
  try {
    const volatileMarkets = await getVolatileMarketsSnapshot({ limit: VOLATILE_SYMBOL_LIMIT, exchangeInfo })
    const preferredSymbols = volatileMarkets.map((item) => item.symbol)

    if (preferredSymbols.length === 0) {
      return settings
    }

    const latestSettings = await getSettings()

    if (JSON.stringify(preferredSymbols) === JSON.stringify(latestSettings.strategy.preferredSymbols || [])) {
      return latestSettings
    }

    const nextSettings = {
      ...latestSettings,
      strategy: {
        ...latestSettings.strategy,
        preferredSymbols,
      },
    }

    await saveSettings(nextSettings, {
      currentSettings: latestSettings,
      audit: {
        trigger: 'PREFERRED_SYMBOLS_SYNC',
        source: 'syncPreferredSymbolsWithVolatility',
        note: `Updated preferred symbols from volatility scan (${preferredSymbols.length} symbols).`,
        writeMeta: {
          preferredSymbolsCount: preferredSymbols.length,
        },
      },
    })
    return nextSettings
  } catch {
    return settings
  }
}

function average(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return 0
  }

  return numbers.reduce((sum, value) => sum + Number(value || 0), 0) / numbers.length
}

function sumNumbers(numbers) {
  return Array.isArray(numbers)
    ? numbers.reduce((sum, value) => sum + Number(value || 0), 0)
    : 0
}

async function fetchSignalMarketContext(symbol) {
  const [depthResult, premiumResult] = await Promise.allSettled([
    fetchFuturesDepth(symbol, 20),
    fetchFuturesPremiumIndex(symbol),
  ])

  const orderBook = depthResult.status === 'fulfilled' ? depthResult.value : null
  const premiumIndex = premiumResult.status === 'fulfilled' ? premiumResult.value : null
  const bidVolume = orderBook ? sumNumbers(orderBook.bids?.map(([, quantity]) => Number(quantity || 0))) : 0
  const askVolume = orderBook ? sumNumbers(orderBook.asks?.map(([, quantity]) => Number(quantity || 0))) : 0

  return {
    orderBook,
    premiumIndex,
    bidVolume,
    askVolume,
    orderBookImbalance: askVolume > 0 ? bidVolume / askVolume : bidVolume > 0 ? Number.POSITIVE_INFINITY : null,
    fundingRate: premiumIndex ? Number(premiumIndex.lastFundingRate || 0) : null,
  }
}

export function toCandleData(klines) {
  return klines.map((entry) => ({
    time: entry[0],
    closeTime: Number(entry[6] || 0),
    open: Number(entry[1]),
    high: Number(entry[2]),
    low: Number(entry[3]),
    close: Number(entry[4]),
    volume: Number(entry[5]),
    takerBuyBaseVolume: Number(entry[9] || 0),
    takerSellBaseVolume: Math.max(Number(entry[5] || 0) - Number(entry[9] || 0), 0),
    deltaVolume: Number(entry[9] || 0) - Math.max(Number(entry[5] || 0) - Number(entry[9] || 0), 0),
  }))
}

function calculateEMA(values, period) {
  const result = []
  const multiplier = 2 / (period + 1)
  let ema = 0

  values.forEach((value, index) => {
    if (index === period - 1) {
      ema = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period
      result.push({ index, value: ema })
      return
    }

    if (index >= period) {
      ema = (value - ema) * multiplier + ema
      result.push({ index, value: ema })
    }
  })

  return result
}

function calculateMACDSeries(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastSeries = calculateEMA(values, fastPeriod)
  const slowSeries = calculateEMA(values, slowPeriod)
  const slowLookup = new Map(slowSeries.map((entry) => [entry.index, entry.value]))
  const macdLine = fastSeries.reduce((result, entry) => {
    const slowValue = slowLookup.get(entry.index)

    if (slowValue != null) {
      result.push({
        index: entry.index,
        value: entry.value - slowValue,
      })
    }

    return result
  }, [])

  if (macdLine.length < signalPeriod) {
    return {
      macdLine,
      signalLine: [],
    }
  }

  const signalLine = []
  const multiplier = 2 / (signalPeriod + 1)
  let signalEma = 0

  macdLine.forEach((entry, index) => {
    if (index === signalPeriod - 1) {
      signalEma = macdLine.slice(0, signalPeriod).reduce((sum, item) => sum + item.value, 0) / signalPeriod
      signalLine.push({
        index: entry.index,
        value: signalEma,
      })
      return
    }

    if (index >= signalPeriod) {
      signalEma = (entry.value - signalEma) * multiplier + signalEma
      signalLine.push({
        index: entry.index,
        value: signalEma,
      })
    }
  })

  return {
    macdLine,
    signalLine,
  }
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) {
    return 50
  }

  let avgGain = 0
  let avgLoss = 0

  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1]
    avgGain += Math.max(change, 0)
    avgLoss += Math.max(-change, 0)
  }

  avgGain /= period
  avgLoss /= period

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1]
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }

  if (avgLoss === 0) {
    return 100
  }

  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function calculateRSISeries(candles, period = 14) {
  if (candles.length <= period) {
    return []
  }

  let avgGain = 0
  let avgLoss = 0
  const result = []

  for (let index = 1; index <= period; index += 1) {
    const change = candles[index].close - candles[index - 1].close
    avgGain += Math.max(change, 0)
    avgLoss += Math.max(-change, 0)
  }

  avgGain /= period
  avgLoss /= period

  result.push({
    index: period,
    value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
  })

  for (let index = period + 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)

    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period

    result.push({
      index,
      value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
    })
  }

  return result
}

function calculateATRSeries(candles, period = 14) {
  if (candles.length <= period) {
    return []
  }

  const trueRanges = []
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]
    const previous = candles[index - 1]
    trueRanges.push({
      index,
      value: Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    })
  }

  if (trueRanges.length < period) {
    return []
  }

  const series = []
  let atr = trueRanges.slice(0, period).reduce((sum, item) => sum + item.value, 0) / period
  series.push({ index: trueRanges[period - 1].index, value: atr })

  for (let index = period; index < trueRanges.length; index += 1) {
    atr = ((atr * (period - 1)) + trueRanges[index].value) / period
    series.push({ index: trueRanges[index].index, value: atr })
  }

  return series
}

function calculateADXSeries(candles, period = 14) {
  if (candles.length <= period * 2) {
    return []
  }

  const directionalData = []
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]
    const previous = candles[index - 1]
    const upMove = current.high - previous.high
    const downMove = previous.low - current.low
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    )

    directionalData.push({
      index,
      plusDm,
      minusDm,
      trueRange,
    })
  }

  if (directionalData.length < period) {
    return []
  }

  let tr14 = directionalData.slice(0, period).reduce((sum, item) => sum + item.trueRange, 0)
  let plusDm14 = directionalData.slice(0, period).reduce((sum, item) => sum + item.plusDm, 0)
  let minusDm14 = directionalData.slice(0, period).reduce((sum, item) => sum + item.minusDm, 0)
  let adx = null
  const dxValues = []
  const series = []

  for (let index = period - 1; index < directionalData.length; index += 1) {
    if (index >= period) {
      const current = directionalData[index]
      tr14 = tr14 - (tr14 / period) + current.trueRange
      plusDm14 = plusDm14 - (plusDm14 / period) + current.plusDm
      minusDm14 = minusDm14 - (minusDm14 / period) + current.minusDm
    }

    if (tr14 === 0) {
      continue
    }

    const plusDi = (plusDm14 / tr14) * 100
    const minusDi = (minusDm14 / tr14) * 100
    const denominator = plusDi + minusDi
    const dx = denominator === 0 ? 0 : (Math.abs(plusDi - minusDi) / denominator) * 100
    dxValues.push(dx)

    if (dxValues.length === period) {
      adx = dxValues.reduce((sum, value) => sum + value, 0) / period
    } else if (dxValues.length > period && adx != null) {
      adx = ((adx * (period - 1)) + dx) / period
    }

    series.push({
      index: directionalData[index].index,
      plusDi,
      minusDi,
      adx,
    })
  }

  return series
}

function calculateVWAPSeries(candles) {
  let cumulativePriceVolume = 0
  let cumulativeVolume = 0

  return candles.map((candle, index) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3
    const volume = Number(candle.volume || 0)
    cumulativePriceVolume += typicalPrice * volume
    cumulativeVolume += volume

    return {
      index,
      value: cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : typicalPrice,
    }
  })
}

function calculateSupportResistance(candles, lookback = 30) {
  const recent = candles.slice(-(lookback + 1), -1)
  return {
    support: Math.min(...recent.map((item) => item.low)),
    resistance: Math.max(...recent.map((item) => item.high)),
  }
}

function candleBodySize(candle) {
  return Math.abs(candle.close - candle.open)
}

function candleRange(candle) {
  return Math.max(candle.high - candle.low, 0.0000001)
}

function candleMidpoint(candle) {
  return (Number(candle.high || 0) + Number(candle.low || 0)) / 2
}

function isAbsorptionCandle(candle, averageVolume, multiplier = 2) {
  if (!candle || averageVolume <= 0) {
    return false
  }

  const bodyShare = candleBodySize(candle) / candleRange(candle)
  return Number(candle.volume || 0) >= averageVolume * multiplier && bodyShare <= 0.4
}

function getSeriesValueAtOrBeforeIndex(series, index) {
  for (let pointer = series.length - 1; pointer >= 0; pointer -= 1) {
    if (series[pointer].index <= index) {
      return Number(series[pointer].value || 0)
    }
  }

  return null
}

function getRsiValueAtOrBeforeIndex(series, index) {
  return getSeriesValueAtOrBeforeIndex(series, index)
}

function findPivotLows(candles, span = 2) {
  if (candles.length < span * 2 + 1) {
    return []
  }

  const pivots = []

  for (let index = span; index < candles.length - span; index += 1) {
    const currentLow = Number(candles[index].low || 0)
    let isPivot = true

    for (let offset = 1; offset <= span; offset += 1) {
      const previousLow = Number(candles[index - offset].low || 0)
      const nextLow = Number(candles[index + offset].low || 0)

      if (previousLow <= currentLow || nextLow < currentLow) {
        isPivot = false
        break
      }
    }

    if (isPivot) {
      pivots.push({
        index,
        low: currentLow,
      })
    }
  }

  return pivots
}

function findPivotHighs(candles, span = 2) {
  if (candles.length < span * 2 + 1) {
    return []
  }

  const pivots = []

  for (let index = span; index < candles.length - span; index += 1) {
    const currentHigh = Number(candles[index].high || 0)
    let isPivot = true

    for (let offset = 1; offset <= span; offset += 1) {
      const previousHigh = Number(candles[index - offset].high || 0)
      const nextHigh = Number(candles[index + offset].high || 0)

      if (previousHigh >= currentHigh || nextHigh > currentHigh) {
        isPivot = false
        break
      }
    }

    if (isPivot) {
      pivots.push({
        index,
        high: currentHigh,
      })
    }
  }

  return pivots
}

function hasBullishStructure(candles) {
  const pivotLows = findPivotLows(candles)
  const pivotHighs = findPivotHighs(candles)

  if (pivotLows.length >= 2 && pivotHighs.length >= 2) {
    const latestLow = pivotLows.at(-1)
    const previousLow = pivotLows.at(-2)
    const latestHigh = pivotHighs.at(-1)
    const previousHigh = pivotHighs.at(-2)

    return latestLow.low > previousLow.low && latestHigh.high >= previousHigh.high
  }

  if (candles.length < 12) {
    return false
  }

  const earlier = candles.slice(-12, -6)
  const recent = candles.slice(-6)
  const earlierLow = Math.min(...earlier.map((item) => item.low))
  const earlierHigh = Math.max(...earlier.map((item) => item.high))
  const recentLow = Math.min(...recent.map((item) => item.low))
  const recentHigh = Math.max(...recent.map((item) => item.high))

  return recentLow > earlierLow && recentHigh >= earlierHigh
}

function hasBearishStructure(candles) {
  const pivotLows = findPivotLows(candles)
  const pivotHighs = findPivotHighs(candles)

  if (pivotLows.length >= 2 && pivotHighs.length >= 2) {
    const latestLow = pivotLows.at(-1)
    const previousLow = pivotLows.at(-2)
    const latestHigh = pivotHighs.at(-1)
    const previousHigh = pivotHighs.at(-2)

    return latestHigh.high < previousHigh.high && latestLow.low <= previousLow.low
  }

  if (candles.length < 12) {
    return false
  }

  const earlier = candles.slice(-12, -6)
  const recent = candles.slice(-6)
  const earlierLow = Math.min(...earlier.map((item) => item.low))
  const earlierHigh = Math.max(...earlier.map((item) => item.high))
  const recentLow = Math.min(...recent.map((item) => item.low))
  const recentHigh = Math.max(...recent.map((item) => item.high))

  return recentHigh < earlierHigh && recentLow <= earlierLow
}

function detectRsiDivergence(candles, rsiSeries, direction) {
  if (candles.length < 12 || rsiSeries.length < 4) {
    return false
  }

  const currentIndex = candles.length - 1
  const searchStart = Math.max(0, candles.length - 10)
  const searchEnd = Math.max(searchStart + 1, candles.length - 2)
  let priorIndex = searchStart

  for (let index = searchStart + 1; index < searchEnd; index += 1) {
    const isBetterLow = direction === 'LONG' && candles[index].low < candles[priorIndex].low
    const isBetterHigh = direction === 'SHORT' && candles[index].high > candles[priorIndex].high

    if (isBetterLow || isBetterHigh) {
      priorIndex = index
    }
  }

  const currentRsi = getRsiValueAtOrBeforeIndex(rsiSeries, currentIndex)
  const priorRsi = getRsiValueAtOrBeforeIndex(rsiSeries, priorIndex)

  if (currentRsi == null || priorRsi == null) {
    return false
  }

  if (direction === 'LONG') {
    return candles[currentIndex].low < candles[priorIndex].low && currentRsi > priorRsi + 2
  }

  return candles[currentIndex].high > candles[priorIndex].high && currentRsi < priorRsi - 2
}

function isWithinHighLiquidityWindow(timestamp) {
  if (!timestamp) {
    return false
  }

  const date = new Date(timestamp)
  const totalMinutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  const windows = [
    [7 * 60, 10 * 60 + 30],
    [12 * 60 + 30, 16 * 60 + 30],
  ]

  return windows.some(([start, end]) => totalMinutes >= start && totalMinutes <= end)
}

function calculateRewardToRisk(targetPrice, entryPrice, stopPrice, direction) {
  const risk = direction === 'LONG'
    ? entryPrice - stopPrice
    : stopPrice - entryPrice
  const reward = direction === 'LONG'
    ? targetPrice - entryPrice
    : entryPrice - targetPrice

  if (risk <= 0 || reward <= 0) {
    return 0
  }

  return reward / risk
}

function candleBodyHigh(candle) {
  return Math.max(Number(candle?.open || 0), Number(candle?.close || 0))
}

function candleBodyLow(candle) {
  return Math.min(Number(candle?.open || 0), Number(candle?.close || 0))
}

function getCandleWickRatios(candle) {
  const resolvedClose = Math.max(Number(candle?.close || 0), 0.0000001)
  const upperWick = Math.max(Number(candle?.high || 0) - candleBodyHigh(candle), 0)
  const lowerWick = Math.max(candleBodyLow(candle) - Number(candle?.low || 0), 0)

  return {
    upperRatio: upperWick / resolvedClose,
    lowerRatio: lowerWick / resolvedClose,
    maxRatio: Math.max(upperWick, lowerWick) / resolvedClose,
  }
}

function isBullishCandle(candle) {
  return Number(candle?.close || 0) > Number(candle?.open || 0)
}

function isBearishCandle(candle) {
  return Number(candle?.close || 0) < Number(candle?.open || 0)
}

export function getClosedCandleSeries(candles, intervalMs, timestamp = Date.now()) {
  return Array.isArray(candles)
    ? candles.filter((candle) => {
      const closeTime = Number(candle?.closeTime || 0)
      const fallbackCloseTime = Number(candle?.time || 0) + intervalMs
      return (closeTime > 0 ? closeTime : fallbackCloseTime) <= timestamp
    })
    : []
}

function createPriceZone(level, buffer) {
  return {
    level,
    lower: level - buffer,
    upper: level + buffer,
  }
}

function candleTouchesZone(candle, zone) {
  if (!candle || !zone) {
    return false
  }

  return Number(candle.low || 0) <= zone.upper && Number(candle.high || 0) >= zone.lower
}

function isBullishEngulfing(previous, current) {
  return Boolean(previous && current)
    && isBearishCandle(previous)
    && isBullishCandle(current)
    && current.open <= previous.close
    && current.close >= previous.open
}

function isBearishEngulfing(previous, current) {
  return Boolean(previous && current)
    && isBullishCandle(previous)
    && isBearishCandle(current)
    && current.open >= previous.close
    && current.close <= previous.open
}

function isHammer(candle) {
  const body = candleBodySize(candle)
  const range = candleRange(candle)
  const lowerWick = candleBodyLow(candle) - Number(candle.low || 0)
  const upperWick = Number(candle.high || 0) - candleBodyHigh(candle)
  return lowerWick >= body * 2 && upperWick <= body && body / range <= 0.4
}

function isShootingStar(candle) {
  const body = candleBodySize(candle)
  const range = candleRange(candle)
  const upperWick = Number(candle.high || 0) - candleBodyHigh(candle)
  const lowerWick = candleBodyLow(candle) - Number(candle.low || 0)
  return upperWick >= body * 2 && lowerWick <= body && body / range <= 0.4
}

function isInvertedHammer(candle) {
  const body = candleBodySize(candle)
  const range = candleRange(candle)
  const upperWick = Number(candle.high || 0) - candleBodyHigh(candle)
  const lowerWick = candleBodyLow(candle) - Number(candle.low || 0)
  return upperWick >= body * 2 && lowerWick <= body * 0.75 && body / range <= 0.4
}

function isTweezerBottom(previous, current) {
  if (!previous || !current) {
    return false
  }

  const averagePrice = Math.max((Number(previous.low || 0) + Number(current.low || 0)) / 2, 0.0000001)
  const tolerance = Math.max(averagePrice * 0.0015, (candleRange(previous) + candleRange(current)) * 0.02)
  return Math.abs(Number(previous.low || 0) - Number(current.low || 0)) <= tolerance
    && isBearishCandle(previous)
    && isBullishCandle(current)
    && current.close > previous.close
}

function isTweezerTop(previous, current) {
  if (!previous || !current) {
    return false
  }

  const averagePrice = Math.max((Number(previous.high || 0) + Number(current.high || 0)) / 2, 0.0000001)
  const tolerance = Math.max(averagePrice * 0.0015, (candleRange(previous) + candleRange(current)) * 0.02)
  return Math.abs(Number(previous.high || 0) - Number(current.high || 0)) <= tolerance
    && isBullishCandle(previous)
    && isBearishCandle(current)
    && current.close < previous.close
}

function isMorningStar(first, second, third) {
  if (!first || !second || !third) {
    return false
  }

  const firstBody = candleBodySize(first)
  const secondBody = candleBodySize(second)
  return isBearishCandle(first)
    && secondBody <= firstBody * 0.6
    && isBullishCandle(third)
    && third.close >= candleMidpoint(first)
}

function isEveningStar(first, second, third) {
  if (!first || !second || !third) {
    return false
  }

  const firstBody = candleBodySize(first)
  const secondBody = candleBodySize(second)
  return isBullishCandle(first)
    && secondBody <= firstBody * 0.6
    && isBearishCandle(third)
    && third.close <= candleMidpoint(first)
}

function isThreeWhiteSoldiers(first, second, third) {
  if (!first || !second || !third) {
    return false
  }

  return [first, second, third].every((candle) => isBullishCandle(candle) && candleBodySize(candle) / candleRange(candle) >= 0.45)
    && second.close > first.close
    && third.close > second.close
    && candleBodyLow(second) >= candleBodyLow(first)
    && candleBodyLow(third) >= candleBodyLow(second)
}

function isThreeBlackCrows(first, second, third) {
  if (!first || !second || !third) {
    return false
  }

  return [first, second, third].every((candle) => isBearishCandle(candle) && candleBodySize(candle) / candleRange(candle) >= 0.45)
    && second.close < first.close
    && third.close < second.close
    && candleBodyHigh(second) <= candleBodyHigh(first)
    && candleBodyHigh(third) <= candleBodyHigh(second)
}

function detectReversalPattern(candles, direction) {
  const latest = candles.at(-1)
  const previous = candles.at(-2)
  const earlier = candles.at(-3)

  if (!latest) {
    return { matched: false, label: 'No pattern', strength: 0, candleCount: 0 }
  }

  if (direction === 'LONG') {
    if (isThreeWhiteSoldiers(earlier, previous, latest)) {
      return { matched: true, label: 'Three White Soldiers', strength: 3, candleCount: 3 }
    }

    if (isMorningStar(earlier, previous, latest)) {
      return { matched: true, label: 'Morning Star', strength: 3, candleCount: 3 }
    }

    if (isBullishEngulfing(previous, latest)) {
      return { matched: true, label: 'Bullish Engulfing', strength: 2, candleCount: 2 }
    }

    if (isTweezerBottom(previous, latest)) {
      return { matched: true, label: 'Tweezer Bottom', strength: 2, candleCount: 2 }
    }

    if (isHammer(latest)) {
      return { matched: true, label: 'Hammer', strength: 1, candleCount: 1 }
    }

    if (isInvertedHammer(latest)) {
      return { matched: true, label: 'Inverted Hammer', strength: 1, candleCount: 1 }
    }

    return { matched: false, label: 'No bullish reversal pattern', strength: 0, candleCount: 0 }
  }

  if (isThreeBlackCrows(earlier, previous, latest)) {
    return { matched: true, label: 'Three Black Crows', strength: 3, candleCount: 3 }
  }

  if (isEveningStar(earlier, previous, latest)) {
    return { matched: true, label: 'Evening Star', strength: 3, candleCount: 3 }
  }

  if (isBearishEngulfing(previous, latest)) {
    return { matched: true, label: 'Bearish Engulfing', strength: 2, candleCount: 2 }
  }

  if (isTweezerTop(previous, latest)) {
    return { matched: true, label: 'Tweezer Top', strength: 2, candleCount: 2 }
  }

  if (isShootingStar(latest)) {
    return { matched: true, label: 'Shooting Star', strength: 1, candleCount: 1 }
  }

  if (isHammer(latest)) {
    return { matched: true, label: 'Hanging Man', strength: 1, candleCount: 1 }
  }

  return { matched: false, label: 'No bearish reversal pattern', strength: 0, candleCount: 0 }
}

function isStrongDirectionalClose(candle, direction, { minBodyShare = 0.5, minCloseLocation = 0.65 } = {}) {
  if (!candle) {
    return false
  }

  const range = candleRange(candle)
  const bodyShare = candleBodySize(candle) / range
  const closeLocation = direction === 'LONG'
    ? (Number(candle.close || 0) - Number(candle.low || 0)) / range
    : (Number(candle.high || 0) - Number(candle.close || 0)) / range

  return bodyShare >= minBodyShare
    && closeLocation >= minCloseLocation
    && (direction === 'LONG' ? isBullishCandle(candle) : isBearishCandle(candle))
}

function enrichSignalChecks(signalModel, checks) {
  const signalMetaByKey = new Map(signalModel.signals.map((signal) => [signal.key, signal]))

  return checks.map((check, index) => {
    const meta = signalMetaByKey.get(check.key) || {}

    return {
      key: check.key,
      label: meta.label || check.key,
      detail: meta.detail || '',
      sourceLabel: meta.sourceLabel || null,
      sourceUrl: meta.sourceUrl || null,
      passed: Boolean(check.passed),
      order: index + 1,
    }
  })
}

function buildEmptySignalSnapshot({
  symbol,
  signalModel,
  effectiveStrategy,
  entryPrice = null,
  summary = 'Waiting for enough closed candles to evaluate the active model.',
}) {
  return {
    symbol,
    side: null,
    direction: 'WAIT',
    checklistSide: 'WAIT',
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    status: signalModel.status === 'blank' ? 'blank' : 'waiting',
    ready: false,
    score: 0,
    maxScore: signalModel.totalSignals || 0,
    professionalSignalScore: 0,
    professionalRequiredCount: signalModel.id === 'model-2' ? 2 : 0,
    allSignalsPassed: false,
    entryPrice,
    stopLoss: null,
    takeProfit: null,
    confidence: 0,
    positionNotional: effectiveStrategy.marginPerTrade * effectiveStrategy.leverage,
    margin: effectiveStrategy.marginPerTrade,
    configuredStopLossPercent: effectiveStrategy.stopLossPercent,
    maxLossPerTrade: effectiveStrategy.maxLossPerTrade,
    summary,
    support: null,
    resistance: null,
    checklist: [],
    setupType: null,
    patternLabel: null,
  }
}

function buildBreakoutRetestState(previousEntry, latestEntry, zone, direction, buffer) {
  if (!previousEntry || !latestEntry || !zone) {
    return {
      retestTouched: false,
      retestHeld: false,
      continuation: false,
      passed: false,
    }
  }

  const tolerance = Math.max(buffer * 1.1, Math.abs(zone.level) * 0.0008)
  const retestTouched = direction === 'LONG'
    ? previousEntry.low <= zone.upper + tolerance && previousEntry.low >= zone.lower - tolerance
    : previousEntry.high >= zone.lower - tolerance && previousEntry.high <= zone.upper + tolerance
  const retestHeld = direction === 'LONG'
    ? previousEntry.close >= zone.lower && latestEntry.low >= zone.lower - tolerance * 0.75
    : previousEntry.close <= zone.upper && latestEntry.high <= zone.upper + tolerance * 0.75
  const continuation = direction === 'LONG'
    ? isBullishCandle(latestEntry)
      && latestEntry.high > previousEntry.high
      && latestEntry.close > Math.max(candleBodyHigh(previousEntry), zone.upper)
    : isBearishCandle(latestEntry)
      && latestEntry.low < previousEntry.low
      && latestEntry.close < Math.min(candleBodyLow(previousEntry), zone.lower)

  return {
    retestTouched,
    retestHeld,
    continuation,
    passed: retestTouched && retestHeld && continuation,
  }
}

function buildSignalCandidate({
  signalModel,
  effectiveStrategy,
  direction,
  setupType,
  baseChecks,
  professionalChecks = [],
  requiredCheckKeys = [],
  entryPrice,
  stopLoss,
  takeProfit,
  support,
  resistance,
  readySummary,
  waitingSummary,
  patternLabel = null,
}) {
  const profile = effectiveStrategy.symbolRiskProfile
  const profileStopLoss = profile
    ? direction === 'LONG'
      ? entryPrice * (1 - effectiveStrategy.stopLossPercent / 100)
      : entryPrice * (1 + effectiveStrategy.stopLossPercent / 100)
    : stopLoss
  const profileTakeProfit = profile
    ? direction === 'LONG'
      ? entryPrice * (1 + effectiveStrategy.takeProfitPercent / 100)
      : entryPrice * (1 - effectiveStrategy.takeProfitPercent / 100)
    : takeProfit
  const professionalRequiredCount = signalModel.id === 'model-2' ? 2 : 0
  const combinedChecks = signalModel.id === 'model-2'
    ? [...baseChecks, ...professionalChecks]
    : baseChecks
  const score = combinedChecks.filter((check) => check.passed).length
  const professionalSignalScore = professionalChecks.filter((check) => check.passed).length
  const thresholdPassed = signalModel.id === 'model-2'
    ? score >= signalModel.minimumScore && professionalSignalScore >= professionalRequiredCount
    : score >= signalModel.minimumScore
  const requiredPassed = requiredCheckKeys.every((key) => combinedChecks.some((check) => check.key === key && check.passed))
  const ready = requiredPassed && thresholdPassed
  const positionSizing = calculateSignalModelPositionSizing({
    strategy: effectiveStrategy,
    signalModelId: signalModel.id,
    entryPrice,
    stopLoss: profileStopLoss,
    runningBalance: effectiveStrategy.runningBalance,
  })

  return {
    side: ready ? (direction === 'LONG' ? 'BUY' : 'SELL') : null,
    direction,
    setupType,
    score,
    maxScore: combinedChecks.length,
    professionalSignalScore,
    professionalRequiredCount,
    allSignalsPassed: score === combinedChecks.length,
    ready,
    entryPrice,
    stopLoss: profileStopLoss,
    takeProfit: profileTakeProfit,
    confidence: combinedChecks.length > 0 ? score / combinedChecks.length : 0,
    positionNotional: positionSizing.positionNotional,
    margin: positionSizing.margin,
    leverage: positionSizing.strategy.leverage,
    configuredStopLossPercent: positionSizing.configuredStopLossPercent,
    maxLossPerTrade: positionSizing.maxLossPerTrade,
    summary: ready ? readySummary : waitingSummary,
    support: profile ? (direction === 'LONG' ? profileStopLoss : profileTakeProfit) : support,
    resistance: profile ? (direction === 'LONG' ? profileTakeProfit : profileStopLoss) : resistance,
    checklist: enrichSignalChecks(signalModel, combinedChecks),
    patternLabel,
  }
}

function chooseSignalCandidate(candidates = []) {
  return candidates
    .filter(Boolean)
    .sort((left, right) => (
      Number(right.ready) - Number(left.ready)
      || right.score - left.score
      || right.confidence - left.confidence
      || Number(right.setupType === 'REVERSAL') - Number(left.setupType === 'REVERSAL')
    ))[0] || null
}

function buildBot3SignalSnapshot({
  symbol,
  signalModel,
  effectiveStrategy,
  closedBiasTimeframe,
  closedSetupTimeframe,
  closedEntryTimeframe,
  latestBias,
  previousBias,
  latestSetup,
  latestEntry,
  previousEntry,
  averageSetupVolume,
  averageEntryVolume,
  setupAbsorption,
  entryAbsorption,
  recentEntryDelta,
}) {
  const biasCloses = closedBiasTimeframe.map((item) => item.close)
  const setupCloses = closedSetupTimeframe.map((item) => item.close)
  const entryCloses = closedEntryTimeframe.map((item) => item.close)
  const biasEma9Series = calculateEMA(biasCloses, 9)
  const setupEma9Series = calculateEMA(setupCloses, 9)
  const entryEma9Series = calculateEMA(entryCloses, 9)
  const setupVwapSeries = calculateVWAPSeries(closedSetupTimeframe)
  const entryVwapSeries = calculateVWAPSeries(closedEntryTimeframe)
  const biasAtrSeries = calculateATRSeries(closedBiasTimeframe, 14)
  const setupAtrSeries = calculateATRSeries(closedSetupTimeframe, 14)
  const entryAtrSeries = calculateATRSeries(closedEntryTimeframe, 14)
  const latestBiasEma9 = getSeriesValueAtOrBeforeIndex(biasEma9Series, closedBiasTimeframe.length - 1) ?? latestBias.close
  const previousBiasEma9 = getSeriesValueAtOrBeforeIndex(biasEma9Series, closedBiasTimeframe.length - 2) ?? latestBiasEma9
  const latestSetupEma9 = getSeriesValueAtOrBeforeIndex(setupEma9Series, closedSetupTimeframe.length - 1) ?? latestSetup.close
  const previousSetupEma9 = getSeriesValueAtOrBeforeIndex(setupEma9Series, closedSetupTimeframe.length - 2) ?? latestSetupEma9
  const latestEntryEma9 = getSeriesValueAtOrBeforeIndex(entryEma9Series, closedEntryTimeframe.length - 1) ?? latestEntry.close
  const latestSetupVwap = getSeriesValueAtOrBeforeIndex(setupVwapSeries, closedSetupTimeframe.length - 1) ?? latestSetup.close
  const latestEntryVwap = getSeriesValueAtOrBeforeIndex(entryVwapSeries, closedEntryTimeframe.length - 1) ?? latestEntry.close
  const latestBiasAtr = biasAtrSeries.at(-1)?.value ?? 0
  const latestSetupAtr = setupAtrSeries.at(-1)?.value ?? 0
  const latestEntryAtr = entryAtrSeries.at(-1)?.value ?? latestSetupAtr
  const { support: rangeSupport, resistance: rangeResistance } = calculateSupportResistance(closedSetupTimeframe, 30)
  const setupPivotLows = findPivotLows(closedSetupTimeframe)
  const setupPivotHighs = findPivotHighs(closedSetupTimeframe)
  const structureSupport = setupPivotLows.at(-1)?.low ?? rangeSupport
  const structureResistance = setupPivotHighs.at(-1)?.high ?? rangeResistance
  const setupRange = Math.max(rangeResistance - rangeSupport, latestSetup.close * 0.002)
  const zoneBuffer = Math.max(latestSetupAtr * 0.45, setupRange * 0.08, latestEntry.close * 0.0012)
  const supportZone = createPriceZone(structureSupport, zoneBuffer)
  const resistanceZone = createPriceZone(structureResistance, zoneBuffer)
  const emaStretchLimitRatio = Math.max(
    (Math.max(latestBiasAtr, latestSetupAtr, latestEntryAtr) / Math.max(latestEntry.close, 0.0000001)) * 0.85,
    0.006,
  )
  const longEmaDistanceRatio = (latestEntry.close - latestEntryEma9) / Math.max(latestEntryEma9, 0.0000001)
  const shortEmaDistanceRatio = (latestEntryEma9 - latestEntry.close) / Math.max(latestEntryEma9, 0.0000001)
  const longVwapStretchRatio = (latestEntry.close - latestEntryVwap) / Math.max(latestEntryVwap, 0.0000001)
  const shortVwapStretchRatio = (latestEntryVwap - latestEntry.close) / Math.max(latestEntryVwap, 0.0000001)
  const bullishBiasStructure = hasBullishStructure(closedBiasTimeframe)
    && hasBullishStructure(closedSetupTimeframe)
    && latestBias.close > latestBiasEma9
    && latestSetup.close > latestSetupEma9
    && latestBiasEma9 >= previousBiasEma9
    && latestSetupEma9 >= previousSetupEma9
  const bearishBiasStructure = hasBearishStructure(closedBiasTimeframe)
    && hasBearishStructure(closedSetupTimeframe)
    && latestBias.close < latestBiasEma9
    && latestSetup.close < latestSetupEma9
    && latestBiasEma9 <= previousBiasEma9
    && latestSetupEma9 <= previousSetupEma9
  const longVwapBias = latestSetup.close >= latestSetupVwap * 0.998 && latestEntry.close >= latestEntryVwap * 0.998
  const shortVwapBias = latestSetup.close <= latestSetupVwap * 1.002 && latestEntry.close <= latestEntryVwap * 1.002
  const longPullbackTouch = latestSetup.low <= latestSetupEma9 * 1.0035 || latestEntry.low <= latestEntryEma9 * 1.0025
  const shortPullbackTouch = latestSetup.high >= latestSetupEma9 * 0.9965 || latestEntry.high >= latestEntryEma9 * 0.9975
  const longBreakoutRetest = buildBreakoutRetestState(previousEntry, latestEntry, resistanceZone, 'LONG', zoneBuffer)
  const shortBreakoutRetest = buildBreakoutRetestState(previousEntry, latestEntry, supportZone, 'SHORT', zoneBuffer)
  const longUsingBreakoutRetest = latestSetup.close > resistanceZone.upper && isStrongDirectionalClose(latestSetup, 'LONG') && longBreakoutRetest.retestTouched
  const shortUsingBreakoutRetest = latestSetup.close < supportZone.lower && isStrongDirectionalClose(latestSetup, 'SHORT') && shortBreakoutRetest.retestTouched
  const longZoneContext = candleTouchesZone(latestSetup, supportZone) || candleTouchesZone(previousEntry, supportZone) || longBreakoutRetest.retestTouched
  const shortZoneContext = candleTouchesZone(latestSetup, resistanceZone) || candleTouchesZone(previousEntry, resistanceZone) || shortBreakoutRetest.retestTouched
  const longSetupContext = (
    longPullbackTouch
    && latestEntry.close >= latestEntryEma9
    && longEmaDistanceRatio <= emaStretchLimitRatio * 1.15
    && longZoneContext
  ) || longUsingBreakoutRetest
  const shortSetupContext = (
    shortPullbackTouch
    && latestEntry.close <= latestEntryEma9
    && shortEmaDistanceRatio <= emaStretchLimitRatio * 1.15
    && shortZoneContext
  ) || shortUsingBreakoutRetest
  const longStretchOkay = longVwapStretchRatio <= 0.08 && longEmaDistanceRatio <= emaStretchLimitRatio * 1.15
  const shortStretchOkay = shortVwapStretchRatio <= 0.08 && shortEmaDistanceRatio <= emaStretchLimitRatio * 1.15
  const structureHoldBuffer = Math.max(latestSetupAtr * 0.25, latestEntry.close * 0.001)
  const longSupportLine = longUsingBreakoutRetest ? structureResistance : Math.max(structureSupport, rangeSupport)
  const shortResistanceLine = shortUsingBreakoutRetest ? structureSupport : Math.min(structureResistance, rangeResistance)
  const longStructureHold = longUsingBreakoutRetest
    ? longBreakoutRetest.retestHeld
    : latestSetup.low >= longSupportLine - structureHoldBuffer && latestEntry.low >= longSupportLine - structureHoldBuffer
  const shortStructureHold = shortUsingBreakoutRetest
    ? shortBreakoutRetest.retestHeld
    : latestSetup.high <= shortResistanceLine + structureHoldBuffer && latestEntry.high <= shortResistanceLine + structureHoldBuffer
  const longTrigger = isBullishCandle(latestEntry)
    && latestEntry.close > latestEntryEma9
    && latestEntry.high > previousEntry.high
    && latestEntry.close > Math.max(candleBodyHigh(previousEntry), longUsingBreakoutRetest ? resistanceZone.upper : candleBodyHigh(latestSetup))
  const shortTrigger = isBearishCandle(latestEntry)
    && latestEntry.close < latestEntryEma9
    && latestEntry.low < previousEntry.low
    && latestEntry.close < Math.min(candleBodyLow(previousEntry), shortUsingBreakoutRetest ? supportZone.lower : candleBodyLow(latestSetup))
  const volumeBaseConfirmed = latestSetup.volume >= averageSetupVolume * 1.15
    || latestEntry.volume >= averageEntryVolume * 1.15
    || setupAbsorption
    || entryAbsorption
  const longVolumeConfirmed = volumeBaseConfirmed || recentEntryDelta > 0
  const shortVolumeConfirmed = volumeBaseConfirmed || recentEntryDelta < 0
  const stopBuffer = Math.max(latestSetupAtr * 0.35, latestEntry.close * 0.0012)
  const longStopBase = longUsingBreakoutRetest
    ? Math.min(previousEntry.low, latestEntry.low, resistanceZone.lower)
    : Math.min(longSupportLine, latestSetup.low, previousEntry.low, latestEntry.low)
  const shortStopBase = shortUsingBreakoutRetest
    ? Math.max(previousEntry.high, latestEntry.high, supportZone.upper)
    : Math.max(shortResistanceLine, latestSetup.high, previousEntry.high, latestEntry.high)
  const longStopLoss = longStopBase - stopBuffer
  const shortStopLoss = shortStopBase + stopBuffer
  const longRisk = Math.max(latestEntry.close - longStopLoss, latestEntry.close * 0.0005)
  const shortRisk = Math.max(shortStopLoss - latestEntry.close, latestEntry.close * 0.0005)
  const longTakeProfit = latestEntry.close + longRisk * 2
  const shortTakeProfit = latestEntry.close - shortRisk * 2
  const longExpansionTarget = longUsingBreakoutRetest
    ? latestEntry.close + Math.max(setupRange, latestSetupAtr * 3)
    : Math.max(rangeResistance, previousBias.high, latestSetup.high)
  const shortExpansionTarget = shortUsingBreakoutRetest
    ? latestEntry.close - Math.max(setupRange, latestSetupAtr * 3)
    : Math.min(rangeSupport, previousBias.low, latestSetup.low)
  const longRewardRoom = calculateRewardToRisk(longExpansionTarget, latestEntry.close, longStopLoss, 'LONG')
  const shortRewardRoom = calculateRewardToRisk(shortExpansionTarget, latestEntry.close, shortStopLoss, 'SHORT')

  const longCandidate = buildSignalCandidate({
    signalModel,
    effectiveStrategy,
    direction: 'LONG',
    setupType: longUsingBreakoutRetest ? 'BREAKOUT' : 'REVERSAL',
    baseChecks: [
      { key: 'bias-market-structure', passed: bullishBiasStructure },
      { key: 'setup-vwap-bias', passed: longVwapBias },
      { key: 'setup-pullback-into-ema', passed: longSetupContext },
      { key: 'setup-vwap-stretch-limit', passed: longStretchOkay },
      { key: 'setup-volume-confirmation', passed: longVolumeConfirmed },
      { key: 'entry-structure-hold', passed: longStructureHold },
      { key: 'entry-price-action-trigger', passed: longTrigger },
      { key: 'risk-reward-room', passed: longRewardRoom >= 2 },
    ],
    requiredCheckKeys: [
      // Loosened: higher-timeframe structure alignment and the separate structure-hold
      // check are still scored but no longer mandatory, so Bot 3 actually finds setups.
      'setup-pullback-into-ema',
      'entry-price-action-trigger',
      'risk-reward-room',
    ],
    entryPrice: latestEntry.close,
    stopLoss: longStopLoss,
    takeProfit: longTakeProfit,
    support: longSupportLine,
    resistance: structureResistance,
    readySummary: longUsingBreakoutRetest
      ? `${signalModel.name} bullish breakout retest aligned: higher-timeframe trend is up, the broken resistance held as support, and the latest 5M candle resumed higher.`
      : `${signalModel.name} bullish trend pullback aligned: price pulled back into the EMA/support zone, held structure, and the latest 5M candle reclaimed trend.`,
    waitingSummary: longUsingBreakoutRetest
      ? `${signalModel.name} long breakout retest is building: waiting for the broken resistance to keep holding and for the latest 5M candle to continue higher.`
      : `${signalModel.name} long pullback at support is building: waiting for the EMA/zone reclaim and the trigger candle to finish aligning.`,
    patternLabel: longUsingBreakoutRetest ? 'Breakout Retest' : 'EMA + Support Reclaim',
  })

  const shortCandidate = buildSignalCandidate({
    signalModel,
    effectiveStrategy,
    direction: 'SHORT',
    setupType: shortUsingBreakoutRetest ? 'BREAKOUT' : 'REVERSAL',
    baseChecks: [
      { key: 'bias-market-structure', passed: bearishBiasStructure },
      { key: 'setup-vwap-bias', passed: shortVwapBias },
      { key: 'setup-pullback-into-ema', passed: shortSetupContext },
      { key: 'setup-vwap-stretch-limit', passed: shortStretchOkay },
      { key: 'setup-volume-confirmation', passed: shortVolumeConfirmed },
      { key: 'entry-structure-hold', passed: shortStructureHold },
      { key: 'entry-price-action-trigger', passed: shortTrigger },
      { key: 'risk-reward-room', passed: shortRewardRoom >= 2 },
    ],
    requiredCheckKeys: [
      // Loosened: higher-timeframe structure alignment and the separate structure-hold
      // check are still scored but no longer mandatory, so Bot 3 actually finds setups.
      'setup-pullback-into-ema',
      'entry-price-action-trigger',
      'risk-reward-room',
    ],
    entryPrice: latestEntry.close,
    stopLoss: shortStopLoss,
    takeProfit: shortTakeProfit,
    support: structureSupport,
    resistance: shortResistanceLine,
    readySummary: shortUsingBreakoutRetest
      ? `${signalModel.name} bearish breakdown retest aligned: higher-timeframe trend is down, the broken support capped price on the retest, and the latest 5M candle resumed lower.`
      : `${signalModel.name} bearish trend pullback aligned: price pulled back into the EMA/resistance zone, held structure, and the latest 5M candle rejected back with trend.`,
    waitingSummary: shortUsingBreakoutRetest
      ? `${signalModel.name} short breakdown retest is building: waiting for the broken support to keep capping price and for the latest 5M candle to continue lower.`
      : `${signalModel.name} short pullback at resistance is building: waiting for the EMA/zone rejection and the trigger candle to finish aligning.`,
    patternLabel: shortUsingBreakoutRetest ? 'Breakdown Retest' : 'EMA + Resistance Rejection',
  })

  const selectedCandidate = chooseSignalCandidate([longCandidate, shortCandidate])

  if (!selectedCandidate) {
    return null
  }

  return {
    symbol,
    side: selectedCandidate.side,
    direction: selectedCandidate.ready ? selectedCandidate.direction : 'WAIT',
    checklistSide: selectedCandidate.direction,
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    status: selectedCandidate.ready ? 'ready' : 'watching',
    ready: selectedCandidate.ready,
    score: selectedCandidate.score,
    maxScore: selectedCandidate.maxScore,
    professionalSignalScore: selectedCandidate.professionalSignalScore,
    professionalRequiredCount: selectedCandidate.professionalRequiredCount,
    allSignalsPassed: selectedCandidate.allSignalsPassed,
    entryPrice: selectedCandidate.entryPrice,
    stopLoss: selectedCandidate.stopLoss,
    takeProfit: selectedCandidate.takeProfit,
    confidence: selectedCandidate.confidence,
    positionNotional: selectedCandidate.positionNotional,
    margin: selectedCandidate.margin,
    configuredStopLossPercent: selectedCandidate.configuredStopLossPercent,
    maxLossPerTrade: selectedCandidate.maxLossPerTrade,
    summary: selectedCandidate.summary,
    support: selectedCandidate.support,
    resistance: selectedCandidate.resistance,
    checklist: selectedCandidate.checklist,
    setupType: selectedCandidate.setupType,
    patternLabel: selectedCandidate.patternLabel,
  }
}

function buildBot12SignalSnapshot({
  symbol,
  signalModel,
  effectiveStrategy,
  closedBiasTimeframe,
  closedSetupTimeframe,
  latestBias,
  latestSetup,
  previousSetup,
  latestEntry,
  previousEntry,
  averageSetupVolume,
  averageEntryVolume,
  setupAbsorption,
  entryAbsorption,
  recentEntryDelta,
  marketContext,
}) {
  const biasCloses = closedBiasTimeframe.map((item) => item.close)
  const setupCloses = closedSetupTimeframe.map((item) => item.close)
  const biasEma9Series = calculateEMA(biasCloses, 9)
  const setupEma9Series = calculateEMA(setupCloses, 9)
  const latestBiasEma9 = getSeriesValueAtOrBeforeIndex(biasEma9Series, closedBiasTimeframe.length - 1) ?? latestBias.close
  const latestSetupEma9 = getSeriesValueAtOrBeforeIndex(setupEma9Series, closedSetupTimeframe.length - 1) ?? latestSetup.close
  const setupRsiSeries = calculateRSISeries(closedSetupTimeframe, 14)
  const setupRsi = getRsiValueAtOrBeforeIndex(setupRsiSeries, closedSetupTimeframe.length - 1) ?? calculateRSI(setupCloses, 14)
  const atrSeries = calculateATRSeries(closedSetupTimeframe, 14)
  const latestAtr = atrSeries.at(-1)?.value ?? 0
  const { support, resistance } = calculateSupportResistance(closedSetupTimeframe, 30)
  const range = Math.max(resistance - support, latestSetup.close * 0.002)
  const zoneBuffer = Math.max(latestAtr * 0.45, range * 0.08, latestEntry.close * 0.0015)
  const supportZone = createPriceZone(support, zoneBuffer)
  const resistanceZone = createPriceZone(resistance, zoneBuffer)
  const bullishPattern = detectReversalPattern(closedSetupTimeframe, 'LONG')
  const bearishPattern = detectReversalPattern(closedSetupTimeframe, 'SHORT')
  const bullishRsiDivergence = detectRsiDivergence(closedSetupTimeframe, setupRsiSeries, 'LONG')
  const bearishRsiDivergence = detectRsiDivergence(closedSetupTimeframe, setupRsiSeries, 'SHORT')
  const baseVolumeConfirmed = latestSetup.volume >= averageSetupVolume * 1.2
    || latestEntry.volume >= averageEntryVolume * 1.2
    || setupAbsorption
    || entryAbsorption
  const longVolumeConfirmed = baseVolumeConfirmed || recentEntryDelta > 0
  const shortVolumeConfirmed = baseVolumeConfirmed || recentEntryDelta < 0
  const biasLongAligned = (hasBullishStructure(closedBiasTimeframe) || hasBullishStructure(closedSetupTimeframe))
    && latestBias.close >= latestBiasEma9 * 0.995
    && latestSetup.close >= latestSetupEma9 * 0.99
  const biasShortAligned = (hasBearishStructure(closedBiasTimeframe) || hasBearishStructure(closedSetupTimeframe))
    && latestBias.close <= latestBiasEma9 * 1.005
    && latestSetup.close <= latestSetupEma9 * 1.01
  const longReversalZoneContext = candleTouchesZone(latestSetup, supportZone) || candleTouchesZone(previousSetup, supportZone)
  const shortReversalZoneContext = candleTouchesZone(latestSetup, resistanceZone) || candleTouchesZone(previousSetup, resistanceZone)
  const bullishSweepReclaim = latestSetup.low < supportZone.lower && latestSetup.close > support
  const bearishSweepReclaim = latestSetup.high > resistanceZone.upper && latestSetup.close < resistance
  const longReversalSetupProof = longReversalZoneContext && (bullishSweepReclaim || bullishPattern.matched)
  const shortReversalSetupProof = shortReversalZoneContext && (bearishSweepReclaim || bearishPattern.matched)
  const longReversalEntryConfirmation = isBullishCandle(latestEntry)
    && latestEntry.high > latestSetup.high
    && latestEntry.close > candleBodyHigh(latestSetup)
    && latestEntry.close > supportZone.level
  const shortReversalEntryConfirmation = isBearishCandle(latestEntry)
    && latestEntry.low < latestSetup.low
    && latestEntry.close < candleBodyLow(latestSetup)
    && latestEntry.close < resistanceZone.level
  const longBreakoutRetest = buildBreakoutRetestState(previousEntry, latestEntry, resistanceZone, 'LONG', zoneBuffer)
  const shortBreakoutRetest = buildBreakoutRetestState(previousEntry, latestEntry, supportZone, 'SHORT', zoneBuffer)
  const longBreakoutZoneContext = candleTouchesZone(latestSetup, resistanceZone) || latestSetup.close > resistanceZone.upper
  const shortBreakoutZoneContext = candleTouchesZone(latestSetup, supportZone) || latestSetup.close < supportZone.lower
  const longBreakoutSetupProof = longBreakoutZoneContext
    && latestSetup.close > resistanceZone.upper
    && isStrongDirectionalClose(latestSetup, 'LONG')
  const shortBreakoutSetupProof = shortBreakoutZoneContext
    && latestSetup.close < supportZone.lower
    && isStrongDirectionalClose(latestSetup, 'SHORT')
  const longReversalMomentum = bullishRsiDivergence || (setupRsi <= 50 && latestEntry.close > previousEntry.close)
  const shortReversalMomentum = bearishRsiDivergence || (setupRsi >= 50 && latestEntry.close < previousEntry.close)
  const longBreakoutMomentum = setupRsi >= 55 && latestEntry.close > previousEntry.close
  const shortBreakoutMomentum = setupRsi <= 45 && latestEntry.close < previousEntry.close
  const orderBookImbalance = Number(marketContext.orderBookImbalance || 0)
  const fundingRate = Number(marketContext.fundingRate || 0)
  const orderBookLongAligned = orderBookImbalance >= 1.35 && latestEntry.close >= previousEntry.close
  const orderBookShortAligned = orderBookImbalance > 0 && orderBookImbalance <= (1 / 1.35) && latestEntry.close <= previousEntry.close
  const fundingLongAligned = fundingRate <= -0.0003
  const fundingShortAligned = fundingRate >= 0.0003
  const highLiquidityWindow = isWithinHighLiquidityWindow(latestEntry.time)
  const stopBuffer = Math.max(latestAtr * 0.6, range * 0.08, latestEntry.close * 0.0015)
  const longReversalStopLoss = Math.min(latestSetup.low, latestEntry.low) - stopBuffer
  const shortReversalStopLoss = Math.max(latestSetup.high, latestEntry.high) + stopBuffer
  const longBreakoutStopLoss = Math.min(previousEntry.low, latestEntry.low, resistanceZone.lower) - stopBuffer * 0.75
  const shortBreakoutStopLoss = Math.max(previousEntry.high, latestEntry.high, supportZone.upper) + stopBuffer * 0.75
  const longReversalRisk = Math.max(latestEntry.close - longReversalStopLoss, latestEntry.close * 0.0005)
  const shortReversalRisk = Math.max(shortReversalStopLoss - latestEntry.close, latestEntry.close * 0.0005)
  const longBreakoutRisk = Math.max(latestEntry.close - longBreakoutStopLoss, latestEntry.close * 0.0005)
  const shortBreakoutRisk = Math.max(shortBreakoutStopLoss - latestEntry.close, latestEntry.close * 0.0005)
  const longReversalTakeProfit = latestEntry.close + longReversalRisk * 2
  const shortReversalTakeProfit = latestEntry.close - shortReversalRisk * 2
  const longBreakoutTakeProfit = latestEntry.close + longBreakoutRisk * 2
  const shortBreakoutTakeProfit = latestEntry.close - shortBreakoutRisk * 2
  const longReversalRewardRoom = calculateRewardToRisk(resistance, latestEntry.close, longReversalStopLoss, 'LONG')
  const shortReversalRewardRoom = calculateRewardToRisk(support, latestEntry.close, shortReversalStopLoss, 'SHORT')
  const longBreakoutRewardRoom = calculateRewardToRisk(latestEntry.close + Math.max(range, latestAtr * 3), latestEntry.close, longBreakoutStopLoss, 'LONG')
  const shortBreakoutRewardRoom = calculateRewardToRisk(latestEntry.close - Math.max(range, latestAtr * 3), latestEntry.close, shortBreakoutStopLoss, 'SHORT')
  const professionalLongChecks = [
    { key: 'entry-volume-delta', passed: recentEntryDelta > 0 },
    { key: 'setup-order-book-imbalance', passed: orderBookLongAligned },
    { key: 'macro-funding-bias', passed: fundingLongAligned },
  ]
  const professionalShortChecks = [
    { key: 'entry-volume-delta', passed: recentEntryDelta < 0 },
    { key: 'setup-order-book-imbalance', passed: orderBookShortAligned },
    { key: 'macro-funding-bias', passed: fundingShortAligned },
  ]

  const longReversalCandidate = buildSignalCandidate({
    signalModel,
    effectiveStrategy,
    direction: 'LONG',
    setupType: 'REVERSAL',
    baseChecks: [
      { key: 'setup-zone-context', passed: longReversalZoneContext },
      { key: 'bias-multi-timeframe', passed: biasLongAligned },
      { key: 'setup-price-action-pattern', passed: longReversalSetupProof },
      { key: 'setup-volume-confirmation', passed: longVolumeConfirmed },
      { key: 'entry-confirmation', passed: longReversalEntryConfirmation },
      { key: 'entry-momentum-confirmation', passed: longReversalMomentum },
      { key: 'session-liquidity-window', passed: highLiquidityWindow },
      { key: 'risk-reward-room', passed: longReversalRewardRoom >= 2 },
    ],
    professionalChecks: professionalLongChecks,
    requiredCheckKeys: [
      'setup-zone-context',
      'setup-price-action-pattern',
      'entry-confirmation',
      'risk-reward-room',
    ],
    entryPrice: latestEntry.close,
    stopLoss: longReversalStopLoss,
    takeProfit: longReversalTakeProfit,
    support,
    resistance,
    readySummary: `${signalModel.name} bullish support-zone reversal aligned: ${bullishSweepReclaim ? 'price swept support and reclaimed it' : bullishPattern.label} printed at the zone, and the latest 5M candle confirmed higher by taking out the signal high.`,
    waitingSummary: `${signalModel.name} long reversal at support is building: waiting for the zone reaction and next confirmed 5M continuation to fully align.`,
    patternLabel: bullishSweepReclaim ? 'Support Sweep Reclaim' : bullishPattern.label,
  })

  const shortReversalCandidate = buildSignalCandidate({
    signalModel,
    effectiveStrategy,
    direction: 'SHORT',
    setupType: 'REVERSAL',
    baseChecks: [
      { key: 'setup-zone-context', passed: shortReversalZoneContext },
      { key: 'bias-multi-timeframe', passed: biasShortAligned },
      { key: 'setup-price-action-pattern', passed: shortReversalSetupProof },
      { key: 'setup-volume-confirmation', passed: shortVolumeConfirmed },
      { key: 'entry-confirmation', passed: shortReversalEntryConfirmation },
      { key: 'entry-momentum-confirmation', passed: shortReversalMomentum },
      { key: 'session-liquidity-window', passed: highLiquidityWindow },
      { key: 'risk-reward-room', passed: shortReversalRewardRoom >= 2 },
    ],
    professionalChecks: professionalShortChecks,
    requiredCheckKeys: [
      'setup-zone-context',
      'setup-price-action-pattern',
      'entry-confirmation',
      'risk-reward-room',
    ],
    entryPrice: latestEntry.close,
    stopLoss: shortReversalStopLoss,
    takeProfit: shortReversalTakeProfit,
    support,
    resistance,
    readySummary: `${signalModel.name} bearish resistance-zone reversal aligned: ${bearishSweepReclaim ? 'price swept resistance and fell back inside' : bearishPattern.label} printed at the zone, and the latest 5M candle confirmed lower by taking out the signal low.`,
    waitingSummary: `${signalModel.name} short reversal at resistance is building: waiting for the zone rejection and next confirmed 5M continuation to fully align.`,
    patternLabel: bearishSweepReclaim ? 'Resistance Sweep Rejection' : bearishPattern.label,
  })

  const longBreakoutCandidate = buildSignalCandidate({
    signalModel,
    effectiveStrategy,
    direction: 'LONG',
    setupType: 'BREAKOUT',
    baseChecks: [
      { key: 'setup-zone-context', passed: longBreakoutZoneContext },
      { key: 'bias-multi-timeframe', passed: biasLongAligned },
      { key: 'setup-price-action-pattern', passed: longBreakoutSetupProof },
      { key: 'setup-volume-confirmation', passed: longVolumeConfirmed },
      { key: 'entry-confirmation', passed: longBreakoutRetest.passed },
      { key: 'entry-momentum-confirmation', passed: longBreakoutMomentum },
      { key: 'session-liquidity-window', passed: highLiquidityWindow },
      { key: 'risk-reward-room', passed: longBreakoutRewardRoom >= 2 },
    ],
    professionalChecks: professionalLongChecks,
    requiredCheckKeys: [
      'setup-zone-context',
      'bias-multi-timeframe',
      'setup-price-action-pattern',
      'entry-confirmation',
      'risk-reward-room',
    ],
    entryPrice: latestEntry.close,
    stopLoss: longBreakoutStopLoss,
    takeProfit: longBreakoutTakeProfit,
    support: resistance,
    resistance: resistance + range,
    readySummary: `${signalModel.name} bullish breakout aligned: price closed decisively through resistance, the retest held the broken zone, and the latest 5M candle continued higher.`,
    waitingSummary: `${signalModel.name} long breakout is building: waiting for the retest to hold the broken resistance and for the next confirmed push higher.`,
    patternLabel: 'Breakout + Retest',
  })

  const shortBreakoutCandidate = buildSignalCandidate({
    signalModel,
    effectiveStrategy,
    direction: 'SHORT',
    setupType: 'BREAKOUT',
    baseChecks: [
      { key: 'setup-zone-context', passed: shortBreakoutZoneContext },
      { key: 'bias-multi-timeframe', passed: biasShortAligned },
      { key: 'setup-price-action-pattern', passed: shortBreakoutSetupProof },
      { key: 'setup-volume-confirmation', passed: shortVolumeConfirmed },
      { key: 'entry-confirmation', passed: shortBreakoutRetest.passed },
      { key: 'entry-momentum-confirmation', passed: shortBreakoutMomentum },
      { key: 'session-liquidity-window', passed: highLiquidityWindow },
      { key: 'risk-reward-room', passed: shortBreakoutRewardRoom >= 2 },
    ],
    professionalChecks: professionalShortChecks,
    requiredCheckKeys: [
      'setup-zone-context',
      'bias-multi-timeframe',
      'setup-price-action-pattern',
      'entry-confirmation',
      'risk-reward-room',
    ],
    entryPrice: latestEntry.close,
    stopLoss: shortBreakoutStopLoss,
    takeProfit: shortBreakoutTakeProfit,
    support: support - range,
    resistance: support,
    readySummary: `${signalModel.name} bearish breakdown aligned: price closed decisively through support, the retest failed beneath the broken zone, and the latest 5M candle continued lower.`,
    waitingSummary: `${signalModel.name} short breakdown is building: waiting for the retest to fail below support and for the next confirmed push lower.`,
    patternLabel: 'Breakdown + Retest',
  })

  const selectedCandidate = chooseSignalCandidate([
    longReversalCandidate,
    shortReversalCandidate,
    longBreakoutCandidate,
    shortBreakoutCandidate,
  ])

  if (!selectedCandidate) {
    return null
  }

  return {
    symbol,
    side: selectedCandidate.side,
    direction: selectedCandidate.ready ? selectedCandidate.direction : 'WAIT',
    checklistSide: selectedCandidate.direction,
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    status: selectedCandidate.ready ? 'ready' : 'watching',
    ready: selectedCandidate.ready,
    score: selectedCandidate.score,
    maxScore: selectedCandidate.maxScore,
    professionalSignalScore: selectedCandidate.professionalSignalScore,
    professionalRequiredCount: selectedCandidate.professionalRequiredCount,
    allSignalsPassed: selectedCandidate.allSignalsPassed,
    entryPrice: selectedCandidate.entryPrice,
    stopLoss: selectedCandidate.stopLoss,
    takeProfit: selectedCandidate.takeProfit,
    confidence: selectedCandidate.confidence,
    positionNotional: selectedCandidate.positionNotional,
    margin: selectedCandidate.margin,
    configuredStopLossPercent: selectedCandidate.configuredStopLossPercent,
    maxLossPerTrade: selectedCandidate.maxLossPerTrade,
    summary: selectedCandidate.summary,
    support: selectedCandidate.support,
    resistance: selectedCandidate.resistance,
    checklist: selectedCandidate.checklist,
    setupType: selectedCandidate.setupType,
    patternLabel: selectedCandidate.patternLabel,
  }
}

function buildSignalAnalysisSnapshotLegacy(
  symbol,
  biasTimeframe,
  setupTimeframe,
  entryTimeframe,
  strategy,
  signalModelId = DEFAULT_SIGNAL_MODEL_ID,
  marketContext = {},
) {
  const latestBias = biasTimeframe.at(-1)
  const previousBias = biasTimeframe.at(-2)
  const latestSetup = setupTimeframe.at(-1)
  const previousSetup = setupTimeframe.at(-2)
  const latestEntry = entryTimeframe.at(-1)
  const previousEntry = entryTimeframe.at(-2)
  const signalModel = getSignalModel(signalModelId)
  const effectiveStrategy = getEffectiveSignalModelStrategy(strategy, signalModelId, {
    runningBalance: strategy?.runningBalance,
  })

  if (!latestBias || !previousBias || !latestSetup || !previousSetup || !latestEntry || !previousEntry) {
    return {
      symbol,
      side: null,
      direction: 'WAIT',
      checklistSide: 'WAIT',
      signalModelId: signalModel.id,
      signalModelName: signalModel.name,
      status: 'waiting',
      ready: false,
      score: 0,
      maxScore: signalModel.totalSignals || 0,
      professionalSignalScore: 0,
      professionalRequiredCount: signalModel.id === 'model-2' ? 2 : 0,
      allSignalsPassed: false,
      entryPrice: latestEntry?.close ?? null,
      stopLoss: null,
      takeProfit: null,
      confidence: 0,
      positionNotional: effectiveStrategy.marginPerTrade * effectiveStrategy.leverage,
      margin: effectiveStrategy.marginPerTrade,
      configuredStopLossPercent: effectiveStrategy.stopLossPercent,
      maxLossPerTrade: effectiveStrategy.maxLossPerTrade,
      summary: 'Waiting for enough candles to evaluate the active model.',
      support: null,
      resistance: null,
      checklist: [],
    }
  }

  if (signalModel.status === 'blank') {
    return {
      symbol,
      side: null,
      direction: 'WAIT',
      checklistSide: 'WAIT',
      signalModelId: signalModel.id,
      signalModelName: signalModel.name,
      status: 'blank',
      ready: false,
      score: 0,
      maxScore: 0,
      professionalSignalScore: 0,
      professionalRequiredCount: 0,
      allSignalsPassed: false,
      entryPrice: latestEntry.close,
      stopLoss: null,
      takeProfit: null,
      confidence: 0,
      positionNotional: effectiveStrategy.marginPerTrade * effectiveStrategy.leverage,
      margin: effectiveStrategy.marginPerTrade,
      configuredStopLossPercent: effectiveStrategy.stopLossPercent,
      maxLossPerTrade: effectiveStrategy.maxLossPerTrade,
      summary: `${signalModel.name} is blank and has no active rules yet.`,
      support: null,
      resistance: null,
      checklist: [],
    }
  }

  if (signalModelId === 'model-3') {
    const biasCloses = biasTimeframe.map((item) => item.close)
    const setupCloses = setupTimeframe.map((item) => item.close)
    const entryCloses = entryTimeframe.map((item) => item.close)
    const biasEma9Series = calculateEMA(biasCloses, 9)
    const setupEma9Series = calculateEMA(setupCloses, 9)
    const entryEma9Series = calculateEMA(entryCloses, 9)
    const setupVwapSeries = calculateVWAPSeries(setupTimeframe)
    const entryVwapSeries = calculateVWAPSeries(entryTimeframe)
    const biasAtrSeries = calculateATRSeries(biasTimeframe, 14)
    const setupAtrSeries = calculateATRSeries(setupTimeframe, 14)
    const entryAtrSeries = calculateATRSeries(entryTimeframe, 14)
    const latestBiasEma9 = getSeriesValueAtOrBeforeIndex(biasEma9Series, biasTimeframe.length - 1) ?? latestBias.close
    const previousBiasEma9 = getSeriesValueAtOrBeforeIndex(biasEma9Series, biasTimeframe.length - 2) ?? latestBiasEma9
    const latestSetupEma9 = getSeriesValueAtOrBeforeIndex(setupEma9Series, setupTimeframe.length - 1) ?? latestSetup.close
    const previousSetupEma9 = getSeriesValueAtOrBeforeIndex(setupEma9Series, setupTimeframe.length - 2) ?? latestSetupEma9
    const latestEntryEma9 = getSeriesValueAtOrBeforeIndex(entryEma9Series, entryTimeframe.length - 1) ?? latestEntry.close
    const latestSetupVwap = getSeriesValueAtOrBeforeIndex(setupVwapSeries, setupTimeframe.length - 1) ?? latestSetup.close
    const latestEntryVwap = getSeriesValueAtOrBeforeIndex(entryVwapSeries, entryTimeframe.length - 1) ?? latestEntry.close
    const latestBiasAtr = biasAtrSeries.at(-1)?.value ?? 0
    const latestSetupAtr = setupAtrSeries.at(-1)?.value ?? 0
    const latestEntryAtr = entryAtrSeries.at(-1)?.value ?? latestSetupAtr
    const { support: rangeSupport, resistance: rangeResistance } = calculateSupportResistance(setupTimeframe, 30)
    const setupPivotLows = findPivotLows(setupTimeframe)
    const setupPivotHighs = findPivotHighs(setupTimeframe)
    const structureSupport = setupPivotLows.at(-1)?.low ?? rangeSupport
    const structureResistance = setupPivotHighs.at(-1)?.high ?? rangeResistance
    const expansionTargetLong = Math.max(rangeResistance, previousBias.high, latestSetup.high)
    const expansionTargetShort = Math.min(rangeSupport, previousBias.low, latestSetup.low)
    const emaStretchLimitRatio = Math.max(
      (Math.max(latestBiasAtr, latestSetupAtr, latestEntryAtr) / Math.max(latestEntry.close, 0.0000001)) * 0.85,
      0.006,
    )
    const longEmaDistanceRatio = (latestEntry.close - latestEntryEma9) / Math.max(latestEntryEma9, 0.0000001)
    const shortEmaDistanceRatio = (latestEntryEma9 - latestEntry.close) / Math.max(latestEntryEma9, 0.0000001)
    const longVwapStretchRatio = (latestEntry.close - latestEntryVwap) / Math.max(latestEntryVwap, 0.0000001)
    const shortVwapStretchRatio = (latestEntryVwap - latestEntry.close) / Math.max(latestEntryVwap, 0.0000001)
    const bullishBiasStructure = hasBullishStructure(biasTimeframe)
      && hasBullishStructure(setupTimeframe)
      && latestBias.close > latestBiasEma9
      && latestSetup.close > latestSetupEma9
      && latestBiasEma9 >= previousBiasEma9
      && latestSetupEma9 >= previousSetupEma9
    const bearishBiasStructure = hasBearishStructure(biasTimeframe)
      && hasBearishStructure(setupTimeframe)
      && latestBias.close < latestBiasEma9
      && latestSetup.close < latestSetupEma9
      && latestBiasEma9 <= previousBiasEma9
      && latestSetupEma9 <= previousSetupEma9
    const longVwapBias = latestSetup.close >= latestSetupVwap * 0.998 && latestEntry.close >= latestEntryVwap * 0.998
    const shortVwapBias = latestSetup.close <= latestSetupVwap * 1.002 && latestEntry.close <= latestEntryVwap * 1.002
    const longPullbackTouch = latestSetup.low <= latestSetupEma9 * 1.0035
      || previousEntry.low <= latestEntryEma9 * 1.0025
      || latestEntry.low <= latestEntryEma9 * 1.0025
    const shortPullbackTouch = latestSetup.high >= latestSetupEma9 * 0.9965
      || previousEntry.high >= latestEntryEma9 * 0.9975
      || latestEntry.high >= latestEntryEma9 * 0.9975
    const longPullbackIntoEma = longPullbackTouch && latestEntry.close >= latestEntryEma9 && longEmaDistanceRatio <= emaStretchLimitRatio
    const shortPullbackIntoEma = shortPullbackTouch && latestEntry.close <= latestEntryEma9 && shortEmaDistanceRatio <= emaStretchLimitRatio
    const longVwapStretchOkay = longVwapStretchRatio <= 0.1
    const shortVwapStretchOkay = shortVwapStretchRatio <= 0.1
    const structureHoldBuffer = Math.max(latestSetupAtr * 0.2, latestEntry.close * 0.001)
    const longStructureHold = latestSetup.low >= structureSupport - structureHoldBuffer
      && latestEntry.low >= structureSupport - structureHoldBuffer
    const shortStructureHold = latestSetup.high <= structureResistance + structureHoldBuffer
      && latestEntry.high <= structureResistance + structureHoldBuffer
    const longTrigger = latestEntry.close > latestEntryEma9
      && latestEntry.close > previousEntry.high
      && latestEntry.close > previousEntry.close
      && latestEntry.close > latestEntry.open
    const shortTrigger = latestEntry.close < latestEntryEma9
      && latestEntry.close < previousEntry.low
      && latestEntry.close < previousEntry.close
      && latestEntry.close < latestEntry.open
    const stopBuffer = Math.max(latestSetupAtr * 0.35, latestEntry.close * 0.0012)
    const longStopBase = Math.min(structureSupport, latestSetup.low, previousEntry.low, latestEntry.low)
    const shortStopBase = Math.max(structureResistance, latestSetup.high, previousEntry.high, latestEntry.high)
    const longStopLoss = longStopBase - stopBuffer
    const shortStopLoss = shortStopBase + stopBuffer
    const longRisk = Math.max(latestEntry.close - longStopLoss, latestEntry.close * 0.0005)
    const shortRisk = Math.max(shortStopLoss - latestEntry.close, latestEntry.close * 0.0005)
    const longTakeProfit = latestEntry.close + longRisk * 2
    const shortTakeProfit = latestEntry.close - shortRisk * 2
    const longRewardRoom = calculateRewardToRisk(expansionTargetLong, latestEntry.close, longStopLoss, 'LONG')
    const shortRewardRoom = calculateRewardToRisk(expansionTargetShort, latestEntry.close, shortStopLoss, 'SHORT')
    const longChecks = [
      { key: 'bias-market-structure', passed: bullishBiasStructure },
      { key: 'setup-vwap-bias', passed: longVwapBias },
      { key: 'setup-pullback-into-ema', passed: longPullbackIntoEma },
      { key: 'setup-vwap-stretch-limit', passed: longVwapStretchOkay },
      { key: 'entry-structure-hold', passed: longStructureHold },
      { key: 'entry-price-action-trigger', passed: longTrigger },
      { key: 'risk-reward-room', passed: longRewardRoom >= 2 },
    ]
    const shortChecks = [
      { key: 'bias-market-structure', passed: bearishBiasStructure },
      { key: 'setup-vwap-bias', passed: shortVwapBias },
      { key: 'setup-pullback-into-ema', passed: shortPullbackIntoEma },
      { key: 'setup-vwap-stretch-limit', passed: shortVwapStretchOkay },
      { key: 'entry-structure-hold', passed: shortStructureHold },
      { key: 'entry-price-action-trigger', passed: shortTrigger },
      { key: 'risk-reward-room', passed: shortRewardRoom >= 2 },
    ]
    const longScore = longChecks.filter((check) => check.passed).length
    const shortScore = shortChecks.filter((check) => check.passed).length
    const selectedDirection = longScore >= shortScore ? 'LONG' : 'SHORT'
    const selectedChecks = selectedDirection === 'LONG' ? longChecks : shortChecks
    const selectedScore = selectedDirection === 'LONG' ? longScore : shortScore
    const selectedThresholdPassed = selectedScore >= signalModel.minimumScore
    const selectedSide = selectedDirection === 'LONG' ? 'BUY' : 'SELL'
    const structuralStopLoss = selectedDirection === 'LONG' ? longStopLoss : shortStopLoss
    const structuralTakeProfit = selectedDirection === 'LONG' ? longTakeProfit : shortTakeProfit
    const profileStopLoss = effectiveStrategy.symbolRiskProfile
      ? selectedDirection === 'LONG' ? latestEntry.close * (1 - effectiveStrategy.stopLossPercent / 100) : latestEntry.close * (1 + effectiveStrategy.stopLossPercent / 100)
      : structuralStopLoss
    const profileTakeProfit = effectiveStrategy.symbolRiskProfile
      ? selectedDirection === 'LONG' ? latestEntry.close * (1 + effectiveStrategy.takeProfitPercent / 100) : latestEntry.close * (1 - effectiveStrategy.takeProfitPercent / 100)
      : structuralTakeProfit
    const positionSizing = calculateSignalModelPositionSizing({
      strategy: effectiveStrategy,
      signalModelId,
      entryPrice: latestEntry.close,
      stopLoss: profileStopLoss,
      runningBalance: effectiveStrategy.runningBalance,
    })
    const selectedSupport = structureSupport
    const selectedResistance = structureResistance
    const ready = selectedDirection === 'LONG'
      ? selectedThresholdPassed && longScore > shortScore
      : selectedThresholdPassed && shortScore > longScore
    const checklist = enrichSignalChecks(signalModel, selectedChecks)
    const waitingSummary = selectedDirection === 'LONG'
      ? `${signalModel.name} long EMA/VWAP pullback is building: ${selectedScore}/${selectedChecks.length} signals are active.`
      : `${signalModel.name} short EMA/VWAP pullback is building: ${selectedScore}/${selectedChecks.length} signals are active.`

    return {
      symbol,
      side: ready ? selectedSide : null,
      direction: ready ? selectedDirection : 'WAIT',
      checklistSide: selectedDirection,
      signalModelId: signalModel.id,
      signalModelName: signalModel.name,
      status: ready ? 'ready' : 'watching',
      ready,
      score: selectedScore,
      maxScore: selectedChecks.length,
      professionalSignalScore: 0,
      professionalRequiredCount: 0,
      allSignalsPassed: selectedScore === selectedChecks.length,
      entryPrice: latestEntry.close,
      stopLoss: profileStopLoss,
      takeProfit: profileTakeProfit,
      confidence: selectedChecks.length > 0 ? selectedScore / selectedChecks.length : 0,
      positionNotional: positionSizing.positionNotional,
      margin: positionSizing.margin,
      leverage: positionSizing.strategy.leverage,
      configuredStopLossPercent: positionSizing.configuredStopLossPercent,
      maxLossPerTrade: positionSizing.maxLossPerTrade,
      summary: ready
        ? selectedDirection === 'LONG'
          ? 'Bot 3 bullish EMA/VWAP pullback aligned: higher-timeframe structure is up, price pulled back into the 9 EMA without getting too far from VWAP, and the current candle reclaimed trend.'
          : 'Bot 3 bearish EMA/VWAP pullback aligned: lower-timeframe structure is down, price pulled back into the 9 EMA without getting too far from VWAP, and the current candle rejected back with trend.'
        : waitingSummary,
      support: selectedSupport,
      resistance: selectedResistance,
      checklist,
    }
  }

  const setupCloses = setupTimeframe.map((item) => item.close)
  const setupRsiSeries = calculateRSISeries(setupTimeframe, 14)
  const setupRsi = getRsiValueAtOrBeforeIndex(setupRsiSeries, setupTimeframe.length - 1) ?? calculateRSI(setupCloses, 14)
  const atrSeries = calculateATRSeries(setupTimeframe, 14)
  const latestAtr = atrSeries.at(-1)?.value ?? 0
  const averageSetupVolume = average(setupTimeframe.slice(-21, -1).map((item) => item.volume))
  const averageEntryVolume = average(entryTimeframe.slice(-21, -1).map((item) => item.volume))
  const setupAbsorption = isAbsorptionCandle(latestSetup, averageSetupVolume, 2)
  const entryAbsorption = isAbsorptionCandle(latestEntry, averageEntryVolume, 2)
  const absorptionDetected = setupAbsorption || entryAbsorption
  const { support, resistance } = calculateSupportResistance(setupTimeframe, 30)
  const range = Math.max(resistance - support, latestSetup.close * 0.002)
  const bullishSweep = latestSetup.low < support && latestSetup.close > support
  const bearishSweep = latestSetup.high > resistance && latestSetup.close < resistance
  const nearSupportEdge = latestSetup.close <= support + range * 0.22 || bullishSweep
  const nearResistanceEdge = latestSetup.close >= resistance - range * 0.22 || bearishSweep
  const bullishConfirmation = bullishSweep
    && latestEntry.close > latestEntry.open
    && latestEntry.close > support
    && latestEntry.close > Math.max(candleMidpoint(latestSetup), latestSetup.close)
    && latestEntry.close > previousEntry.close
  const bearishConfirmation = bearishSweep
    && latestEntry.close < latestEntry.open
    && latestEntry.close < resistance
    && latestEntry.close < Math.min(candleMidpoint(latestSetup), latestSetup.close)
    && latestEntry.close < previousEntry.close
  const bullishRsiDivergence = detectRsiDivergence(setupTimeframe, setupRsiSeries, 'LONG')
  const bearishRsiDivergence = detectRsiDivergence(setupTimeframe, setupRsiSeries, 'SHORT')
  const highLiquidityWindow = isWithinHighLiquidityWindow(latestEntry.time)
  const stopBuffer = Math.max(latestAtr * 0.6, range * 0.08, latestEntry.close * 0.0015)
  const longStopLoss = Math.min(latestSetup.low, latestEntry.low) - stopBuffer
  const shortStopLoss = Math.max(latestSetup.high, latestEntry.high) + stopBuffer
  const longRisk = Math.max(latestEntry.close - longStopLoss, latestEntry.close * 0.0005)
  const shortRisk = Math.max(shortStopLoss - latestEntry.close, latestEntry.close * 0.0005)
  const longTakeProfit = latestEntry.close + longRisk * 2
  const shortTakeProfit = latestEntry.close - shortRisk * 2
  const longRewardRoom = calculateRewardToRisk(resistance, latestEntry.close, longStopLoss, 'LONG')
  const shortRewardRoom = calculateRewardToRisk(support, latestEntry.close, shortStopLoss, 'SHORT')
  const recentEntryDelta = sumNumbers(entryTimeframe.slice(-3).map((item) => item.deltaVolume))
  const deltaLongAligned = recentEntryDelta > 0 && (latestSetup.close <= previousSetup.close || bullishSweep)
  const deltaShortAligned = recentEntryDelta < 0 && (latestSetup.close >= previousSetup.close || bearishSweep)
  const orderBookImbalance = Number(marketContext.orderBookImbalance || 0)
  const orderBookFlatPrice = Math.abs(latestEntry.close - latestSetup.close) / Math.max(latestSetup.close, 0.0000001) <= 0.0035
  const orderBookLongAligned = orderBookImbalance >= 1.5 && orderBookFlatPrice
  const orderBookShortAligned = orderBookImbalance > 0 && orderBookImbalance <= (1 / 1.5) && orderBookFlatPrice
  const fundingRate = Number(marketContext.fundingRate || 0)
  const fundingLongAligned = fundingRate <= -0.0003
  const fundingShortAligned = fundingRate >= 0.0003

  const baseLongChecks = [
    { key: 'setup-range-edge', passed: nearSupportEdge },
    { key: 'setup-liquidity-sweep', passed: bullishSweep },
    { key: 'setup-volume-absorption', passed: absorptionDetected },
    { key: 'entry-confirmation-close', passed: bullishConfirmation },
    { key: 'entry-rsi-divergence', passed: bullishRsiDivergence && setupRsi <= 45 },
    { key: 'session-liquidity-window', passed: highLiquidityWindow },
    { key: 'risk-reward-room', passed: longRewardRoom >= 2 },
  ]

  const baseShortChecks = [
    { key: 'setup-range-edge', passed: nearResistanceEdge },
    { key: 'setup-liquidity-sweep', passed: bearishSweep },
    { key: 'setup-volume-absorption', passed: absorptionDetected },
    { key: 'entry-confirmation-close', passed: bearishConfirmation },
    { key: 'entry-rsi-divergence', passed: bearishRsiDivergence && setupRsi >= 55 },
    { key: 'session-liquidity-window', passed: highLiquidityWindow },
    { key: 'risk-reward-room', passed: shortRewardRoom >= 2 },
  ]

  const professionalLongChecks = [
    { key: 'entry-volume-delta', passed: deltaLongAligned },
    { key: 'setup-order-book-imbalance', passed: orderBookLongAligned },
    { key: 'macro-funding-bias', passed: fundingLongAligned },
  ]

  const professionalShortChecks = [
    { key: 'entry-volume-delta', passed: deltaShortAligned },
    { key: 'setup-order-book-imbalance', passed: orderBookShortAligned },
    { key: 'macro-funding-bias', passed: fundingShortAligned },
  ]

  const longChecks = signalModelId === 'model-2'
    ? [...baseLongChecks, ...professionalLongChecks]
    : baseLongChecks
  const shortChecks = signalModelId === 'model-2'
    ? [...baseShortChecks, ...professionalShortChecks]
    : baseShortChecks

  const longScore = longChecks.filter((check) => check.passed).length
  const shortScore = shortChecks.filter((check) => check.passed).length
  const professionalLongScore = professionalLongChecks.filter((check) => check.passed).length
  const professionalShortScore = professionalShortChecks.filter((check) => check.passed).length
  const positionNotional = effectiveStrategy.marginPerTrade * effectiveStrategy.leverage
  const longThresholdPassed = signalModelId === 'model-2'
    ? longScore >= signalModel.minimumScore && professionalLongScore >= 2
    : longScore >= signalModel.minimumScore
  const shortThresholdPassed = signalModelId === 'model-2'
    ? shortScore >= signalModel.minimumScore && professionalShortScore >= 2
    : shortScore >= signalModel.minimumScore

  const longSummary = signalModelId === 'model-2'
    ? 'Bot 2 bullish whale-rejection aligned: support sweep, absorption volume, reclaim close, RSI divergence, plus positive volume delta, bid-side order book absorption, and negative funding bias.'
    : 'Bot 1 bullish whale-rejection aligned: support sweep, absorption volume, reclaim close, RSI divergence, and a hidden stop beyond the liquidity grab.'
  const shortSummary = signalModelId === 'model-2'
    ? 'Bot 2 bearish whale-rejection aligned: resistance sweep, absorption volume, rejection close, RSI divergence, plus negative volume delta, ask-side order book absorption, and positive funding bias.'
    : 'Bot 1 bearish whale-rejection aligned: resistance sweep, absorption volume, rejection close, RSI divergence, and a hidden stop beyond the liquidity grab.'

  const selectedDirection = longScore >= shortScore ? 'LONG' : 'SHORT'
  const selectedChecks = selectedDirection === 'LONG' ? longChecks : shortChecks
  const selectedScore = selectedDirection === 'LONG' ? longScore : shortScore
  const selectedProfessionalScore = selectedDirection === 'LONG' ? professionalLongScore : professionalShortScore
  const selectedThresholdPassed = selectedDirection === 'LONG' ? longThresholdPassed : shortThresholdPassed
  const selectedSummary = selectedDirection === 'LONG' ? longSummary : shortSummary
  const selectedSide = selectedDirection === 'LONG' ? 'BUY' : 'SELL'
  const selectedStopLoss = selectedDirection === 'LONG' ? longStopLoss : shortStopLoss
  const selectedTakeProfit = selectedDirection === 'LONG' ? longTakeProfit : shortTakeProfit
  const ready = selectedDirection === 'LONG'
    ? longThresholdPassed && longScore > shortScore
    : shortThresholdPassed && shortScore > longScore
  const professionalRequiredCount = signalModelId === 'model-2' ? 2 : 0
  const checklist = enrichSignalChecks(signalModel, selectedChecks)
  const waitingSummary = selectedDirection === 'LONG'
    ? `${signalModel.name} long whale-rejection stack is building: ${selectedScore}/${selectedChecks.length} signals are active.`
    : `${signalModel.name} short whale-rejection stack is building: ${selectedScore}/${selectedChecks.length} signals are active.`

  return {
    symbol,
    side: ready ? selectedSide : null,
    direction: ready ? selectedDirection : 'WAIT',
    checklistSide: selectedDirection,
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    status: ready ? 'ready' : 'watching',
    ready,
    score: selectedScore,
    maxScore: selectedChecks.length,
    professionalSignalScore: selectedProfessionalScore,
    professionalRequiredCount,
    allSignalsPassed: selectedScore === selectedChecks.length,
    entryPrice: latestEntry.close,
    stopLoss: selectedStopLoss,
    takeProfit: selectedTakeProfit,
    confidence: selectedChecks.length > 0 ? selectedScore / selectedChecks.length : 0,
    positionNotional,
    margin: effectiveStrategy.marginPerTrade,
    configuredStopLossPercent: effectiveStrategy.stopLossPercent,
    maxLossPerTrade: effectiveStrategy.maxLossPerTrade,
    summary: ready ? selectedSummary : waitingSummary,
    support,
    resistance,
    checklist,
  }
}

// Bot 4 is intentionally simple: a 15M EMA20/EMA50 + 5M RSI14 directional bias only.
// It never blocks on its own checklist - it always emits a ready candidate whenever a
// direction bias exists, and the AI entry filter (hard block) is the sole entry decision.
function buildBot4SignalSnapshot({
  symbol,
  signalModel,
  effectiveStrategy,
  closedSetupTimeframe,
  closedEntryTimeframe,
  latestEntry,
}) {
  const setupCloses = closedSetupTimeframe.map((item) => item.close)
  const setupEma20 = calculateEMA(setupCloses, 20).at(-1)?.value ?? latestEntry.close
  const setupEma50 = calculateEMA(setupCloses, 50).at(-1)?.value ?? setupEma20
  const entryRsiSeries = calculateRSISeries(closedEntryTimeframe, 14)
  const entryRsi14 = getRsiValueAtOrBeforeIndex(entryRsiSeries, closedEntryTimeframe.length - 1) ?? 50
  const atr = calculateATRSeries(closedEntryTimeframe, 14).at(-1)?.value ?? Math.max(latestEntry.close * 0.003, 0)

  const stopLossPercent = Math.max(Number(effectiveStrategy.stopLossPercent || 0.2), 0.05)
  const takeProfitPercent = Math.max(Number(effectiveStrategy.takeProfitPercent || 0.4), 0.05)

  const emaTrendLong = setupEma20 > setupEma50
  const emaTrendShort = setupEma20 < setupEma50
  const rsiSideLong = entryRsi14 >= 50
  const rsiSideShort = entryRsi14 <= 50
  const longBias = emaTrendLong && rsiSideLong
  const shortBias = emaTrendShort && rsiSideShort
  const direction = longBias ? 'LONG' : shortBias ? 'SHORT' : 'WAIT'
  const ready = direction !== 'WAIT'
  const side = direction === 'LONG' ? 'BUY' : direction === 'SHORT' ? 'SELL' : null

  const entryPrice = latestEntry.close
  const stopLoss = direction === 'SHORT'
    ? entryPrice * (1 + stopLossPercent / 100)
    : entryPrice * (1 - stopLossPercent / 100)
  const takeProfit = direction === 'SHORT'
    ? entryPrice * (1 - takeProfitPercent / 100)
    : entryPrice * (1 + takeProfitPercent / 100)

  const positionSizing = calculateSignalModelPositionSizing({
    strategy: effectiveStrategy,
    signalModelId: signalModel.id,
    entryPrice,
    stopLoss,
    runningBalance: effectiveStrategy.runningBalance,
  })

  const biasChecks = [
    { key: 'bias-ema-trend', passed: direction === 'LONG' ? emaTrendLong : direction === 'SHORT' ? emaTrendShort : false },
    { key: 'bias-rsi-side', passed: direction === 'LONG' ? rsiSideLong : direction === 'SHORT' ? rsiSideShort : false },
  ]
  const score = biasChecks.filter((check) => check.passed).length
  const readySummary = `${signalModel.name} ${direction === 'SHORT' ? 'short' : 'long'} EMA/RSI bias: 15M EMA20 ${direction === 'SHORT' ? 'below' : 'above'} EMA50, 5M RSI14 ${entryRsi14.toFixed(1)}. AI entry score decides execution.`
  const waitingSummary = `${signalModel.name} has no clean EMA/RSI bias yet: 15M EMA20 vs EMA50 and 5M RSI14 do not agree on a direction.`

  return {
    symbol,
    side,
    direction,
    checklistSide: ready ? direction : 'WAIT',
    signalModelId: signalModel.id,
    signalModelName: signalModel.name,
    status: ready ? 'ready' : 'watching',
    ready,
    score,
    maxScore: biasChecks.length,
    professionalSignalScore: 0,
    professionalRequiredCount: 0,
    allSignalsPassed: score === biasChecks.length,
    entryPrice,
    stopLoss,
    takeProfit,
    confidence: ready ? 0.5 : 0,
    positionNotional: positionSizing.positionNotional,
    margin: positionSizing.margin,
    leverage: positionSizing.strategy.leverage,
    configuredStopLossPercent: positionSizing.configuredStopLossPercent,
    maxLossPerTrade: positionSizing.maxLossPerTrade,
    summary: ready ? readySummary : waitingSummary,
    support: setupEma50,
    resistance: takeProfit,
    checklist: enrichSignalChecks(signalModel, biasChecks),
    setupType: 'CONTINUATION',
    patternLabel: 'AI-Gated EMA/RSI Bias',
    aiFeatures: {
      ema20_15m: Number(setupEma20.toFixed(8)),
      ema50_15m: Number(setupEma50.toFixed(8)),
      rsi14_5m: Number(entryRsi14.toFixed(4)),
      atr: Number(atr.toFixed(8)),
    },
  }
}

export function buildSignalAnalysisSnapshot(
  symbol,
  biasTimeframe,
  setupTimeframe,
  entryTimeframe,
  strategy,
  signalModelId = DEFAULT_SIGNAL_MODEL_ID,
  marketContext = {},
  triggerTimeframe = [],
) {
  const signalModel = getSignalModel(signalModelId)
  const effectiveStrategy = getEffectiveSignalModelStrategy(strategy, signalModelId, {
    runningBalance: strategy?.runningBalance,
    symbol,
  })
  const closedBiasTimeframe = getClosedCandleSeries(biasTimeframe, 60 * 60_000)
  const closedSetupTimeframe = getClosedCandleSeries(setupTimeframe, 15 * 60_000)
  const closedEntryTimeframe = getClosedCandleSeries(entryTimeframe, 5 * 60_000)
  const closedTriggerTimeframe = getClosedCandleSeries(triggerTimeframe, 60_000)
  const latestEntry = closedEntryTimeframe.at(-1)

  if (signalModel.status === 'blank') {
    return buildEmptySignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      entryPrice: latestEntry?.close ?? null,
      summary: `${signalModel.name} is blank and has no active rules yet.`,
    })
  }

  if (signalModel.id === 'model-4') {
    if (closedSetupTimeframe.length < 50 || closedEntryTimeframe.length < 16) {
      return buildEmptySignalSnapshot({
        symbol,
        signalModel,
        effectiveStrategy,
        entryPrice: latestEntry?.close ?? null,
        summary: `Waiting for enough closed 15M and 5M candles to read ${signalModel.name}'s EMA/RSI bias.`,
      })
    }

    const latestEntryForBot4 = closedEntryTimeframe.at(-1)

    if (!latestEntryForBot4) {
      return buildEmptySignalSnapshot({
        symbol,
        signalModel,
        effectiveStrategy,
        entryPrice: latestEntry?.close ?? null,
      })
    }

    return attachPatternInsight(buildBot4SignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      closedSetupTimeframe,
      closedEntryTimeframe,
      latestEntry: latestEntryForBot4,
    }) || buildEmptySignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      entryPrice: latestEntryForBot4.close,
    }), closedEntryTimeframe)
  }

  // Bots 5-8 — mean-reversion / volatility-breakout / range-fade / funding-contrarian.
  // Genuinely different families with their own indicator stacks; they read mostly
  // from the closed 5m window plus the 1h window for regime context.
  if (BOT5TO8_BUILDERS[signalModel.id]) {
    const builder = BOT5TO8_BUILDERS[signalModel.id]
    const snapshot = builder({
      symbol,
      signalModel,
      effectiveStrategy,
      closedBiasTimeframe,
      closedSetupTimeframe,
      closedEntryTimeframe,
      marketContext,
      regime4hTimeframe: marketContext?.regime4hCandles || null,
    }) || buildEmptySignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      entryPrice: latestEntry?.close ?? null,
    })
    return attachPatternInsight(snapshot, closedEntryTimeframe)
  }

  if (
    closedBiasTimeframe.length < 24
    || closedSetupTimeframe.length < 34
    || closedEntryTimeframe.length < 4
  ) {
    return buildEmptySignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      entryPrice: latestEntry?.close ?? null,
    })
  }

  const latestBias = closedBiasTimeframe.at(-1)
  const latestSetup = closedSetupTimeframe.at(-1)
  const previousSetup = closedSetupTimeframe.at(-2)
  const previousBias = closedBiasTimeframe.at(-2)
  const previousEntry = closedEntryTimeframe.at(-2)

  if (!latestBias || !previousBias || !latestSetup || !previousSetup || !latestEntry || !previousEntry) {
    return buildEmptySignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      entryPrice: latestEntry?.close ?? null,
    })
  }

  if (signalModel.id === 'model-3') {
    return attachPatternInsight(buildBot3SignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      closedBiasTimeframe,
      closedSetupTimeframe,
      closedEntryTimeframe,
      latestBias,
      previousBias,
      latestSetup,
      latestEntry,
      previousEntry,
      averageSetupVolume: average(closedSetupTimeframe.slice(-21, -1).map((item) => item.volume)),
      averageEntryVolume: average(closedEntryTimeframe.slice(-21, -1).map((item) => item.volume)),
      setupAbsorption: isAbsorptionCandle(latestSetup, average(closedSetupTimeframe.slice(-21, -1).map((item) => item.volume)), 1.8),
      entryAbsorption: isAbsorptionCandle(latestEntry, average(closedEntryTimeframe.slice(-21, -1).map((item) => item.volume)), 1.8),
      recentEntryDelta: sumNumbers(closedEntryTimeframe.slice(-3).map((item) => item.deltaVolume)),
    }) || buildEmptySignalSnapshot({
      symbol,
      signalModel,
      effectiveStrategy,
      entryPrice: latestEntry.close,
    }), closedEntryTimeframe)
  }

  return attachPatternInsight(buildBot12SignalSnapshot({
    symbol,
    signalModel,
    effectiveStrategy,
    closedBiasTimeframe,
    closedSetupTimeframe,
    latestBias,
    latestSetup,
    previousSetup,
    latestEntry,
    previousEntry,
    averageSetupVolume: average(closedSetupTimeframe.slice(-21, -1).map((item) => item.volume)),
    averageEntryVolume: average(closedEntryTimeframe.slice(-21, -1).map((item) => item.volume)),
    setupAbsorption: isAbsorptionCandle(latestSetup, average(closedSetupTimeframe.slice(-21, -1).map((item) => item.volume)), 1.8),
    entryAbsorption: isAbsorptionCandle(latestEntry, average(closedEntryTimeframe.slice(-21, -1).map((item) => item.volume)), 1.8),
    recentEntryDelta: sumNumbers(closedEntryTimeframe.slice(-3).map((item) => item.deltaVolume)),
    marketContext,
  }) || buildEmptySignalSnapshot({
    symbol,
    signalModel,
    effectiveStrategy,
    entryPrice: latestEntry.close,
  }), closedEntryTimeframe)
}

export function analyzeSymbolStrategy(
  symbol,
  biasTimeframe,
  setupTimeframe,
  entryTimeframe,
  strategy,
  signalModelId = DEFAULT_SIGNAL_MODEL_ID,
  marketContext = {},
  triggerTimeframe = [],
) {
  const snapshot = buildSignalAnalysisSnapshot(
    symbol,
    biasTimeframe,
    setupTimeframe,
    entryTimeframe,
    strategy,
    signalModelId,
    marketContext,
    triggerTimeframe,
  )

  if (!snapshot || !snapshot.ready) {
    return null
  }

  return {
    symbol: snapshot.symbol,
    side: snapshot.side,
    direction: snapshot.direction,
    signalModelId: snapshot.signalModelId,
    signalModelName: snapshot.signalModelName,
    strategyFamily: snapshot.strategyFamily || getSignalModel(snapshot.signalModelId)?.strategyFamily || null,
    setupFamily: snapshot.setupFamily || null,
    score: snapshot.score,
    maxScore: snapshot.maxScore,
    professionalSignalScore: snapshot.professionalSignalScore,
    entryPrice: snapshot.entryPrice,
    stopLoss: snapshot.stopLoss,
    takeProfit: snapshot.takeProfit,
    confidence: snapshot.confidence,
    positionNotional: snapshot.positionNotional,
    margin: snapshot.margin,
    configuredStopLossPercent: snapshot.configuredStopLossPercent,
    maxLossPerTrade: snapshot.maxLossPerTrade,
    summary: snapshot.summary,
    patternScore: Number(snapshot.patternScore || 0),
    patternBias: snapshot.patternBias || 'neutral',
    patterns: Array.isArray(snapshot.patterns) ? snapshot.patterns : [],
    patternSummary: snapshot.patternSummary || null,
  }
}

function manilaDateKey(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp)
}

function roundDownToStep(value, stepSize) {
  if (!stepSize || stepSize <= 0) {
    return value
  }

  const precision = getStepPrecision(stepSize)
  const rounded = Math.floor(value / stepSize) * stepSize
  return Number(rounded.toFixed(precision))
}

function getStepPrecision(stepSize) {
  const normalized = String(stepSize || '').toLowerCase()
  if (!normalized) {
    return 0
  }

  if (normalized.includes('e-')) {
    return Number(normalized.split('e-')[1] || 0)
  }

  const decimals = normalized.split('.')[1] || ''
  return decimals.length
}

function findSymbolRules(exchangeInfo, symbol) {
  return exchangeInfo.symbols.find((item) => item.symbol === symbol)
}

function getFilter(symbolInfo, type) {
  return symbolInfo.filters.find((item) => item.filterType === type)
}

function roundToStep(value, stepSize, mode = 'nearest') {
  const numericValue = Number(value)
  const numericStep = Number(stepSize)

  if (!Number.isFinite(numericValue)) {
    return 0
  }

  if (!Number.isFinite(numericStep) || numericStep <= 0) {
    return numericValue
  }

  const precision = getStepPrecision(numericStep)
  const scaled = numericValue / numericStep
  const epsilon = 1e-10

  let roundedUnits
  if (mode === 'up') {
    roundedUnits = Math.ceil(scaled - epsilon)
  } else if (mode === 'down') {
    roundedUnits = Math.floor(scaled + epsilon)
  } else {
    roundedUnits = Math.round(scaled)
  }

  return Number((roundedUnits * numericStep).toFixed(precision))
}

function formatStepAlignedNumber(value, stepSize, mode = 'nearest') {
  const numericStep = Number(stepSize)
  const numericValue = roundToStep(value, numericStep, mode)

  if (!Number.isFinite(numericValue)) {
    return '0'
  }

  const precision = getStepPrecision(numericStep)
  if (precision <= 0) {
    return String(Math.trunc(numericValue))
  }

  return numericValue.toFixed(precision).replace(/\.?0+$/, '')
}

function getQuantityStepSize(symbolInfo) {
  const marketLot = getFilter(symbolInfo, 'MARKET_LOT_SIZE') || getFilter(symbolInfo, 'LOT_SIZE')
  return Number(marketLot?.stepSize || 0)
}

function getPriceTickSize(symbolInfo) {
  return Number(getFilter(symbolInfo, 'PRICE_FILTER')?.tickSize || 0)
}

function formatFuturesQuantity(symbolInfo, value) {
  const stepSize = getQuantityStepSize(symbolInfo)
  return stepSize > 0
    ? formatStepAlignedNumber(value, stepSize, 'down')
    : formatExchangeNumber(value)
}

function normalizeFuturesPrice(symbolInfo, value, mode = 'nearest') {
  const tickSize = getPriceTickSize(symbolInfo)
  return tickSize > 0 ? roundToStep(value, tickSize, mode) : Number(value || 0)
}

function formatFuturesPrice(symbolInfo, value, mode = 'nearest') {
  const tickSize = getPriceTickSize(symbolInfo)
  return tickSize > 0
    ? formatStepAlignedNumber(value, tickSize, mode)
    : formatExchangeNumber(value)
}

function getProtectiveTriggerRoundMode(side, type) {
  const normalizedSide = String(side || '').toUpperCase()
  const normalizedType = String(type || '').toUpperCase()
  const isLong = normalizedSide === 'BUY'

  if (normalizedType === 'STOP_MARKET') {
    return isLong ? 'up' : 'down'
  }

  if (normalizedType === 'TAKE_PROFIT_MARKET') {
    return isLong ? 'down' : 'up'
  }

  return 'nearest'
}

function buildFuturesQuantity(symbolInfo, positionNotional, entryPrice) {
  const marketLot = getFilter(symbolInfo, 'MARKET_LOT_SIZE') || getFilter(symbolInfo, 'LOT_SIZE')
  const minNotional = getFilter(symbolInfo, 'MIN_NOTIONAL')

  if (!marketLot) {
    throw new Error(`Missing futures lot size filter for ${symbolInfo.symbol}`)
  }

  const rawQty = positionNotional / entryPrice
  const qty = roundDownToStep(rawQty, Number(marketLot.stepSize))
  const minQty = Number(marketLot.minQty)
  const maxQty = Number(marketLot.maxQty)
  const minNotionalValue = minNotional ? Number(minNotional.notional) : 0

  if (qty < minQty) {
    throw new Error(`Calculated quantity is below minQty for ${symbolInfo.symbol}`)
  }

  if (qty > maxQty) {
    throw new Error(`Calculated quantity exceeds maxQty for ${symbolInfo.symbol}`)
  }

  if (qty * entryPrice < minNotionalValue) {
    throw new Error(`Calculated quantity is below minNotional for ${symbolInfo.symbol}`)
  }

  return qty
}

function getManilaHour(timestamp = Date.now()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp))
}

function isWithinTradingSession(strategy, timestamp = Date.now()) {
  if (!strategy?.sessionScheduleEnabled) {
    return true
  }

  const hour = getManilaHour(timestamp)
  return isHourWithinScheduledSessions(hour, strategy?.scheduledSessions)
}

function summarizeToday(history, dateKey, { walletId = null, autoOnly = true } = {}) {
  const today = history.filter((item) => (
    item.tradeDateKey === dateKey
    && (!autoOnly || isAutoTradeSource(item.source))
    && (!walletId || item.walletId === walletId)
  ))
  const closed = today.filter((item) => isClosedTrade(item))
  return {
    tradeCount: today.length,
    lossCount: closed.filter((item) => item.pnl < 0).length,
    pnl: Number(closed.reduce((sum, item) => sum + (item.pnl || 0), 0).toFixed(2)),
    realizedLoss: Number(closed.reduce((sum, item) => sum + Math.max(0, -Number(item.pnl || 0)), 0).toFixed(2)),
    hasAutoTrade: today.length > 0,
  }
}

function getLatestAutoTradeTimestamp(history = []) {
  return history
    .filter((item) => isAutoTradeSource(item?.source))
    .reduce((latest, item) => {
      const timestamp = Number(item?.closedAt || item?.transactTime || 0)
      return timestamp > latest ? timestamp : latest
    }, 0)
}

function getConsecutiveAutoLossStreak(history = []) {
  const closedAutoTrades = history
    .filter((item) => isAutoTradeSource(item?.source) && isClosedTrade(item))
    .sort((left, right) => (
      Number(right.closedAt || right.transactTime || 0) - Number(left.closedAt || left.transactTime || 0)
    ))

  let streak = 0
  for (const trade of closedAutoTrades) {
    if (Number(trade?.pnl || 0) < 0) {
      streak += 1
      continue
    }

    break
  }

  return streak
}

function buildJournalItems(trades) {
  const grouped = trades.reduce((accumulator, trade) => {
    const key = trade.journalDateKey || trade.tradeDateKey || manilaDateKey(trade.transactTime)
    if (!accumulator[key]) {
      accumulator[key] = {
        date: key,
        entries: 0,
        closed: 0,
        longs: 0,
        shorts: 0,
        wins: 0,
        losses: 0,
        open: 0,
        pnl: 0,
        symbols: new Set(),
      }
    }

    const item = accumulator[key]
    item.entries += 1
    item.symbols.add(trade.symbol)

    if (trade.side === 'BUY') {
      item.longs += 1
    } else if (trade.side === 'SELL') {
      item.shorts += 1
    }

    if (isClosedTrade(trade)) {
      item.closed += 1

      if (Number(trade.pnl || 0) > 0) {
        item.wins += 1
      } else if (Number(trade.pnl || 0) < 0) {
        item.losses += 1
      }
    } else if (trade.status === 'OPEN') {
      item.open += 1
    }

    if (isClosedTrade(trade)) {
      item.pnl += Number(trade.pnl || 0)
    }

    return accumulator
  }, {})

  return Object.values(grouped)
    .map((item) => ({
      ...item,
      trades: item.entries,
      symbols: Array.from(item.symbols).sort((left, right) => left.localeCompare(right)),
      winRate: item.closed > 0 ? item.wins / Math.max(item.closed, 1) : 0,
      pnl: Number(item.pnl.toFixed(2)),
    }))
    .sort((left, right) => String(right.date).localeCompare(String(left.date)))
}

function buildJournalSummary(trades, items) {
  const closedTrades = trades.filter((trade) => isClosedTrade(trade))
  const wins = closedTrades.filter((trade) => Number(trade.pnl || 0) > 0).length
  const losses = closedTrades.filter((trade) => Number(trade.pnl || 0) < 0).length

  return {
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    openTrades: trades.filter((trade) => trade.status === 'OPEN').length,
    wins,
    losses,
    pnl: Number(closedTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0).toFixed(2)),
    winRate: closedTrades.length > 0 ? wins / closedTrades.length : 0,
    activeDays: items.length,
  }
}

function isAutoTradeSource(source) {
  return String(source || '').startsWith('AUTO')
}

function isClosedTrade(trade) {
  return trade.status === 'CLOSED_TP'
    || trade.status === 'CLOSED_SL'
    || trade.status === 'CLOSED_MANUAL'
    || trade.pnl != null
    || trade.exitPrice != null
}

function isSuccessfulTrade(trade) {
  return isClosedTrade(trade) && Number(trade.pnl || 0) > 0
}

function getTradeCloseTimestamp(trade) {
  return trade.closedAt || trade.transactTime || Date.now()
}

function createPhase(key, title, subtitle, status, summary, checks, highlights) {
  return {
    key,
    title,
    subtitle,
    status,
    summary,
    checks,
    highlights,
  }
}

function createNotification(id, level, title, message) {
  return {
    id,
    level,
    title,
    message,
  }
}

function getPhaseStatus(passed, unlocked = true, finalReady = false) {
  if (passed && finalReady) {
    return 'ready'
  }

  if (passed) {
    return 'passed'
  }

  if (!unlocked) {
    return 'locked'
  }

  return 'pending'
}

function summarizeMissingChecks(checks) {
  return checks.filter((check) => !check.passed).map((check) => check.label)
}

function evaluateWorkflowReadiness(settings, history, autoTradeLog, learningBotTrainStatus = defaultLearningBotTrainStatus, backtestRuns = []) {
  const { apiKey, secretKey } = getEffectiveCredentials(settings)
  const trackedSymbols = Array.from(new Set((settings.strategy.preferredSymbols || []).filter(Boolean)))
  const validatedTestnetTrades = history.filter((trade) => (
    ['VALIDATED', 'EXECUTED'].includes(String(trade.validationStatus || '').toUpperCase())
    && trade.mode === 'binance-futures-testnet'
  ))
  const automatedTestnetTrades = validatedTestnetTrades.filter((trade) => trade.source === 'AUTO')
  const closedAutomatedTestnetTrades = automatedTestnetTrades.filter(isClosedTrade)
  const successfulAutomatedTestnetTrades = closedAutomatedTestnetTrades.filter(isSuccessfulTrade)
  const validatedSymbols = Array.from(new Set(closedAutomatedTestnetTrades.map((trade) => trade.symbol))).sort((a, b) => a.localeCompare(b))
  const executedAutoRuns = autoTradeLog.filter((entry) => entry.result?.executed)
  const hasExecutionEvidence = history.length > 0 || executedAutoRuns.length > 0
  const missingCoverage = trackedSymbols.filter((symbol) => !validatedSymbols.includes(symbol))
  const todayKey = manilaDateKey()
  const trailingMonthStart = Date.now() - 30 * 24 * 60 * 60 * 1000
  const realizedDailyPnl = closedAutomatedTestnetTrades
    .filter((trade) => manilaDateKey(getTradeCloseTimestamp(trade)) === todayKey)
    .reduce((sum, trade) => sum + Number(trade.pnl || 0), 0)
  const realizedMonthlyPnl = closedAutomatedTestnetTrades
    .filter((trade) => getTradeCloseTimestamp(trade) >= trailingMonthStart)
    .reduce((sum, trade) => sum + Number(trade.pnl || 0), 0)
  const successfulTradeCount = successfulAutomatedTestnetTrades.length
  const closedTrades = history.filter(isClosedTrade)
  const openLocalPaperTrades = history.filter((trade) => (
    String(trade.status || '').toUpperCase() === 'OPEN'
    && trade.mode !== 'binance-futures-testnet'
  ))
  const liveGateValidationStartedAt = Date.parse('2026-06-08T21:00:00.000Z')
  const postHardeningClosedAutoTrades = closedTrades.filter((trade) => (
    trade.source === 'AUTO'
    && getTradeCloseTimestamp(trade) >= liveGateValidationStartedAt
  ))
  const trainMetrics = learningBotTrainStatus?.metrics || {}
  const aiSettings = settings?.learningBot || {}
  const aiTrainerSettings = aiSettings.aiTrainer || {}
  const aiFilterSettings = aiSettings.aiEntryFilter || {}
  const aiActionAlignment = Number(trainMetrics.actionAlignment || 0)
  const aiRows = Number(trainMetrics.rows || 0)
  const marketDataHealth = getMarketDataHealthSnapshot()
  const wallets = Array.isArray(settings.wallets) ? settings.wallets : []
  const botWallets = wallets.filter((wallet) => /^model-/i.test(String(wallet.id || '')))
  const phase2BotWallets = botWallets.filter((wallet) => String(wallet.stage || '').toUpperCase() === PHASE_2_WALLET_STAGE)

  const phase1Checks = [
    { label: 'Settings storage is available', passed: true },
    { label: 'Trade history storage is available', passed: true },
    { label: 'Tracked symbols are configured', passed: trackedSymbols.length > 0 },
    { label: 'Execution pipeline has been exercised', passed: hasExecutionEvidence },
  ]
  const phase1Passed = phase1Checks.every((check) => check.passed)

  const phase2Checks = [
    { label: 'Phase 1 self-validation passed', passed: phase1Passed },
    { label: 'Binance Testnet credentials are configured', passed: Boolean(apiKey && secretKey) },
    { label: 'Binance Testnet execution pipeline is active', passed: hasExecutionEvidence },
    { label: 'Self-review logging is active', passed: true },
  ]
  const phase2Passed = phase2Checks.every((check) => check.passed)

  const phase3Checks = [
    { label: 'Phase 2 Binance Testnet validation passed', passed: phase2Passed },
    { label: 'Tracked symbols have closed Testnet coverage', passed: trackedSymbols.length > 0 && missingCoverage.length === 0 },
    { label: `Post-hardening paper/testnet AUTO closed trades >= 50 (current ${postHardeningClosedAutoTrades.length})`, passed: postHardeningClosedAutoTrades.length >= 50 },
    { label: `Realized daily profit >= 50 USDT (current ${realizedDailyPnl.toFixed(2)})`, passed: realizedDailyPnl >= 50 },
    { label: `Realized trailing 30-day profit >= 1500 USDT (current ${realizedMonthlyPnl.toFixed(2)})`, passed: realizedMonthlyPnl >= 1500 },
    { label: `AI learning/trainer/filter enabled and persisted (rows ${aiRows})`, passed: Boolean(aiSettings.enabled && aiTrainerSettings.enabled && aiFilterSettings.enabled && aiRows >= 500) },
    { label: `AI action alignment >= 55% before hard blocking trades (current ${aiActionAlignment.toFixed(2)}%)`, passed: aiActionAlignment >= 55 },
    { label: 'Market-data health is green: no degraded state, timeouts, rate limits, or circuit openings since restart', passed: Boolean(!marketDataHealth.degraded && marketDataHealth.timeouts === 0 && marketDataHealth.rateLimited === 0 && marketDataHealth.circuitOpened === 0) },
    { label: `Open local-paper trades cleared before live API (current ${openLocalPaperTrades.length})`, passed: openLocalPaperTrades.length === 0 },
    { label: `At least one bot wallet intentionally promoted to Phase 2/Testnet before Phase 3 (current ${phase2BotWallets.length})`, passed: phase2BotWallets.length >= 1 },
    { label: 'Self-review logging is active', passed: true },
  ]
  const phase3Ready = phase3Checks.every((check) => check.passed)

  const phase1 = createPhase(
    'phase-1',
    'Phase 1',
    'Paper trading (mock)',
    getPhaseStatus(phase1Passed),
    phase1Passed
      ? 'Mock trading passed self-validation and is safe for fast iteration.'
      : `Finish Phase 1 checks: ${summarizeMissingChecks(phase1Checks).join(', ')}.`,
    phase1Checks,
    ['Fast testing', 'No API risk'],
  )

  const phase2 = createPhase(
    'phase-2',
    'Phase 2',
    'Binance Testnet orders',
    getPhaseStatus(phase2Passed, phase1Passed),
    phase2Passed
      ? `Binance Testnet execution is active with ${successfulTradeCount} successful closed AUTO trades recorded so far.`
      : phase1Passed
        ? `Phase 2 needs Binance Testnet credentials and execution evidence before Phase 3 preparation can continue.`
        : 'Phase 2 is locked until the mock workflow passes self-validation.',
    phase2Checks,
    ['Real exchange execution', 'Validate API logic'],
  )

  const phase3 = createPhase(
    'phase-3',
    'Phase 3',
    'Production trading',
    getPhaseStatus(phase3Ready, phase2Passed, true),
    phase3Ready
      ? 'Phase 3 can begin with controlled live Binance API only: one bot, tiny size, one open position max, strict daily loss cap, and manual supervision.'
      : phase2Passed
        ? `Phase 3 is blocked until the live-money gate passes: ${summarizeMissingChecks(phase3Checks).join(', ')}.`
        : 'Phase 3 stays locked until Phase 2 passes on Binance Testnet.',
    phase3Checks,
    ['Live Binance API locked', 'Real-money gate'],
  )

  const notifications = []
  if (!phase1Passed) {
    notifications.push(createNotification(
      'phase-1-progress',
      'warning',
      'Phase 1 still in progress',
      `Mock workflow is missing: ${summarizeMissingChecks(phase1Checks).join(', ')}.`,
    ))
  }

  if (phase3Ready) {
    notifications.push(createNotification(
      'phase-3-ready',
      'success',
      'Phase 3 ready',
      'All live-money gates passed. Live API integration can begin only with production safeguards: one bot, tiny size, one open position max, strict daily loss cap, and manual supervision.',
    ))
  } else if (phase2Passed) {
    notifications.push(createNotification(
      'phase-3-pending',
      'info',
      'Phase 3 prep in progress',
      `Live Binance/real-money trading remains locked. Missing: ${summarizeMissingChecks(phase3Checks).join(', ')}.`,
    ))
  } else if (phase1Passed) {
    notifications.push(createNotification(
      'phase-2-progress',
      'warning',
      'Phase 2 still in progress',
      `Configure Binance Testnet credentials and keep execution evidence flowing. Successful closed AUTO Testnet trades so far: ${successfulTradeCount}.`,
    ))
  }

  if (phase2Passed) {
    notifications.push(createNotification(
      'phase-2-ready',
      'success',
      'Phase 2 ready',
      `Binance Testnet execution is active. Successful closed AUTO Testnet trades recorded so far: ${successfulTradeCount}.`,
    ))
  }

  // ---- Operational self-check: is the box actually able to trade right now? ----
  const opsChecks = []
  const opsNote = (label, ok, detail) => opsChecks.push({ label, ok: Boolean(ok), detail })

  // 1. Backend process / crash-loop
  const uptimeSec = Math.round(process.uptime())
  const uptimeH = Math.floor(uptimeSec / 3600)
  const uptimeM = Math.floor((uptimeSec % 3600) / 60)
  opsNote(
    'Backend process',
    uptimeSec >= 300,
    uptimeSec >= 300
      ? `UP — uptime ${uptimeH}h ${uptimeM}m`
      : `restarted ${uptimeSec}s ago — if this keeps resetting the server is crash-looping (check memory below)`,
  )
  if (uptimeSec < 180) {
    notifications.push(createNotification('ops-restart', 'warning', 'Backend restarted moments ago',
      `Process uptime is only ${uptimeSec}s. If it does not stabilise the AI filter and auto-trader will not run reliably.`))
  }

  // 2. Machine specs — memory headroom (the OOM / "can't trade because of specs" check)
  const totalMemMb = Math.round(os.totalmem() / 1048576)
  const freeMemMb = Math.round(os.freemem() / 1048576)
  const rssMb = Math.round(process.memoryUsage().rss / 1048576)
  const memOk = freeMemMb >= 300 && rssMb < totalMemMb * 0.62
  opsNote(
    'Machine memory headroom',
    memOk,
    `process ${rssMb} MB • free ${freeMemMb} MB / ${totalMemMb} MB total` +
      (memOk ? '' : ' — headroom low; a policy refresh or dataset load can OOM-kill the process and stop trading'),
  )
  if (!memOk) {
    notifications.push(createNotification('ops-memory', 'warning', 'Server memory is constrained',
      `${rssMb} MB in use, ${freeMemMb} MB free of ${totalMemMb} MB. Large in-memory work (training / flagged-dataset assembly) will OOM this box and interrupt trading.`))
  }

  // 3. Flagged training data vs this box's budget (why the checkbox must stay off here)
  const flaggedRuns = (Array.isArray(backtestRuns) ? backtestRuns : [])
    .filter((r) => r && r.includeInTraining === true && r.dataFile)
  let flaggedBytes = 0
  const flaggedPresent = []
  for (const r of flaggedRuns) {
    try {
      const st = statSync(path.resolve(dataDir, String(r.dataFile)))
      flaggedBytes += st.size
      flaggedPresent.push(`${r.id} (${Math.round(st.size / 1048576)} MB)`)
    } catch { /* file not on this box — contributes nothing */ }
  }
  const flaggedMb = Math.round(flaggedBytes / 1048576)
  const trainBudgetMb = Math.max(30, Math.round((totalMemMb * 0.6 - rssMb) / 16)) // ~16 MB heap per 1k feature rows
  const flaggedOk = flaggedMb <= 40
  opsNote(
    'Flagged training data within box budget',
    flaggedOk,
    flaggedPresent.length === 0
      ? 'no flagged backtest datasets are present on this box (training happens on the workstation)'
      : `${flaggedMb} MB present: ${flaggedPresent.join(', ')}` +
        (flaggedOk ? '' : ` — exceeds this box's ~40 MB safe budget; loading it will OOM. Un-flag these runs here.`),
  )
  if (!flaggedOk) {
    notifications.push(createNotification('ops-flagged-data', 'warning', 'Flagged backtest data too large for this server',
      `${flaggedMb} MB of flagged training data is on this box. This deployment does not train — un-flag includeInTraining for these runs or it will OOM-loop.`))
  }

  // 4. Trading actually enabled + market data healthy
  const autoOn = Boolean(settings?.strategy?.autoTradingEnabled)
  opsNote('Auto-trading enabled', autoOn, autoOn ? 'ON' : 'OFF — no orders will be placed regardless of signals')
  if (!autoOn) {
    notifications.push(createNotification('ops-autotrade-off', 'warning', 'Auto-trading is OFF',
      'The auto-trader is disabled in settings, so no trades will be placed even when bots find setups.'))
  }
  const mdOk = !marketDataHealth.degraded && marketDataHealth.timeouts === 0 && marketDataHealth.rateLimited === 0 && marketDataHealth.circuitOpened === 0
  opsNote('Market data feed', mdOk,
    mdOk ? 'healthy' : `degraded=${marketDataHealth.degraded} timeouts=${marketDataHealth.timeouts} rateLimited=${marketDataHealth.rateLimited} circuitOpened=${marketDataHealth.circuitOpened} — candidate scanning is impaired`)
  if (!mdOk) {
    notifications.push(createNotification('ops-marketdata', 'warning', 'Market-data feed degraded',
      'Upstream market data is throttled or circuit-broken; the scanner cannot evaluate all symbols.'))
  }

  // 5. Recent order flow — is something blocking every trade?
  const recentRuns = (Array.isArray(autoTradeLog) ? autoTradeLog : []).slice(0, 15)
  const executedRuns = recentRuns.filter((e) => e?.result?.executed)
  const blockReasonCounts = {}
  for (const e of recentRuns) {
    if (e?.result?.executed) continue
    const reason = String(e?.result?.reason || 'unspecified').slice(0, 80)
    blockReasonCounts[reason] = (blockReasonCounts[reason] || 0) + 1
  }
  const topBlock = Object.entries(blockReasonCounts).sort((a, b) => b[1] - a[1])[0]
  const flowOk = recentRuns.length === 0 || executedRuns.length > 0
  opsNote('Recent auto-trade flow', flowOk,
    recentRuns.length === 0
      ? 'no auto-trade runs recorded yet'
      : `last ${recentRuns.length} runs: ${executedRuns.length} placed an order, ${recentRuns.length - executedRuns.length} blocked` +
        (topBlock ? ` (top reason: "${topBlock[0]}")` : ''))
  if (!flowOk && recentRuns.length >= 5) {
    notifications.push(createNotification('ops-flow-blocked', 'info', 'No orders placed in recent runs',
      `The last ${recentRuns.length} auto-trade runs placed 0 orders${topBlock ? ` — most common reason: "${topBlock[0]}"` : ''}.`))
  }

  // 6. AI policy in use (trained off-box)
  const policyBots = Object.keys(learningBotTrainStatus?.metrics?.policy?.bySignalModel || {})
  const aiOn = Boolean(settings?.learningBot?.aiEntryFilter?.enabled)
  opsNote('AI entry filter', policyBots.length > 0 && aiOn,
    `${aiOn ? 'ON' : 'OFF'} — policy covers ${policyBots.length} bot(s), ${aiRows} rows, ${trainMetrics.deviceUsed || 'n/a'} (trained off this server${settings?.learningBot?.aiTrainer?.enabled ? '' : '; on-box training disabled'})`)

  const operations = {
    checks: opsChecks,
    allOk: opsChecks.every((c) => c.ok),
    canTrade: autoOn && memOk && uptimeSec >= 60,
    memory: { totalMemMb, freeMemMb, rssMb },
    uptimeSec,
    generatedAt: Date.now(),
  }

  const currentPhase = !phase1Passed
    ? 'phase-1'
    : !phase2Passed
      ? 'phase-2'
      : 'phase-3'

  const signatureSource = JSON.stringify({
    currentPhase,
    phase1: phase1.status,
    phase2: phase2.status,
    phase3: phase3.status,
    trackedSymbols,
    validatedSymbols,
    validatedTestnetTrades: validatedTestnetTrades.length,
    closedAutomatedTestnetTrades: closedAutomatedTestnetTrades.length,
    successfulTradeCount,
    realizedDailyPnl,
    realizedMonthlyPnl,
    notifications: notifications.map((item) => item.id),
    ops: operations.checks.map((c) => `${c.label}:${c.ok ? 1 : 0}`).join('|'),
  })

  return {
    currentPhase,
    phases: [phase1, phase2, phase3],
    notifications,
    operations,
    trackedSymbols,
    validatedSymbols,
    summary: notifications[0]?.message || phase3.summary,
    signature: crypto.createHash('sha1').update(signatureSource).digest('hex').slice(0, 12),
  }
}

async function persistWorkflowReview(snapshot) {
  const items = await getWorkflowReviewLog()
  if (items[0]?.signature === snapshot.signature) {
    return items
  }

  const entry = {
    id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    signature: snapshot.signature,
    currentPhase: snapshot.currentPhase,
    headline: snapshot.notifications[0]?.title || 'Workflow status updated',
    summary: snapshot.summary,
    notifications: snapshot.notifications,
    operations: snapshot.operations || null,
    phases: snapshot.phases.map((phase) => ({
      key: phase.key,
      title: phase.title,
      status: phase.status,
      summary: phase.summary,
    })),
  }

  items.unshift(entry)
  await writeJson(workflowReviewLogFilePath, items.slice(0, 80))
  return items.slice(0, 80)
}

function formatExchangeNumber(value, maxDecimals = 12) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) {
    return '0'
  }

  return number.toFixed(maxDecimals).replace(/\.?0+$/, '')
}

function updateWalletSyncState(wallets, walletId, productionUpdates = {}) {
  return normalizeWallets(wallets).map((wallet) => (
    wallet.id === walletId
      ? {
        ...wallet,
        balanceMode: isExchangeSyncWallet(wallet) ? EXCHANGE_SYNC_WALLET_BALANCE_MODE : MANUAL_WALLET_BALANCE_MODE,
        production: {
          ...wallet.production,
          ...productionUpdates,
        },
      }
      : wallet
  ))
}

async function persistWalletSyncResult(settings, walletId, productionUpdates = {}) {
  if (!walletId) {
    return settings
  }

  const latestSettings = await getSettings()
  const nextWallets = updateWalletSyncState(latestSettings.wallets, walletId, productionUpdates)
  const nextSettings = {
    ...latestSettings,
    wallets: nextWallets,
  }

  if (JSON.stringify(nextWallets) === JSON.stringify(latestSettings.wallets)) {
    return latestSettings
  }

  return saveSettings(nextSettings, {
    currentSettings: latestSettings,
    audit: {
      trigger: 'WALLET_SYNC_RESULT',
      source: 'persistWalletSyncResult',
      note: `Updated wallet sync state for ${walletId}.`,
      writeMeta: {
        walletId,
        productionUpdateKeys: Object.keys(productionUpdates || {}).sort(),
      },
    },
  })
}

async function syncExchangeWalletBalance({
  settings = null,
  walletId = null,
  suppressErrors = false,
} = {}) {
  const currentSettings = settings ? normalizeSettings(settings) : await getSettings()
  const syncedWallet = walletId
    ? getWalletById(walletId, currentSettings.wallets)
    : getPrimaryExchangeSyncedWallet(currentSettings.wallets)

  if (!syncedWallet || !isExchangeSyncWallet(syncedWallet)) {
    return {
      settings: currentSettings,
      wallet: null,
      accountSnapshot: null,
    }
  }

  const { apiKey, secretKey } = getEffectiveCredentials(currentSettings)
  if (!apiKey || !secretKey) {
    const nextSettings = await persistWalletSyncResult(currentSettings, syncedWallet.id, {
      syncStatus: 'MISSING_CREDENTIALS',
      lastError: 'Binance Futures Testnet API key and secret are required for Phase 2 wallet sync.',
      lastSyncedAt: Date.now(),
    })

    const error = new Error('Binance Futures Testnet API key and secret are required for Phase 2 wallet sync.')
    if (!suppressErrors) {
      throw error
    }

    return {
      settings: nextSettings,
      wallet: getWalletById(syncedWallet.id, nextSettings.wallets),
      accountSnapshot: null,
      error,
    }
  }

  try {
    const accountSnapshot = await fetchBinanceAccountSnapshot({ apiKey, secretKey })
    const openPositionCount = Array.isArray(accountSnapshot.positions)
      ? accountSnapshot.positions.filter((position) => Math.abs(Number(position?.positionAmt || 0)) > 1e-8).length
      : 0
    const nextSettings = await persistWalletSyncResult(currentSettings, syncedWallet.id, {
      syncStatus: 'CONNECTED',
      lastSyncedBalance: Number(accountSnapshot.totalWalletBalance || 0),
      lastSyncedAvailableBalance: Number(accountSnapshot.availableBalance || 0),
      lastSyncedUnrealizedPnl: Number(accountSnapshot.totalUnrealizedProfit || 0),
      lastOpenPositionCount: openPositionCount,
      lastSyncedAt: Date.now(),
      lastError: '',
    })

    return {
      settings: nextSettings,
      wallet: getWalletById(syncedWallet.id, nextSettings.wallets),
      accountSnapshot,
    }
  } catch (error) {
    const nextSettings = await persistWalletSyncResult(currentSettings, syncedWallet.id, {
      syncStatus: 'ERROR',
      lastError: error instanceof Error ? error.message : String(error),
      lastSyncedAt: Date.now(),
    })

    if (!suppressErrors) {
      throw error
    }

    return {
      settings: nextSettings,
      wallet: getWalletById(syncedWallet.id, nextSettings.wallets),
      accountSnapshot: null,
      error,
    }
  }
}

async function closeExchangePositionImmediately({
  symbol,
  side,
  quantity,
  symbolInfo = null,
  apiKey,
  secretKey,
}) {
  if (!symbol || !side || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw new Error('A valid symbol, side, and quantity are required to close the exchange position.')
  }

  const resolvedSymbolInfo = symbolInfo || findSymbolRules(await fetchFuturesExchangeInfo(), symbol)
  const closeOrder = await placeBinanceOrder({
    apiKey,
    secretKey,
    symbol,
    side: getOppositeTradeSide(side),
    type: 'MARKET',
    quantity: resolvedSymbolInfo ? formatFuturesQuantity(resolvedSymbolInfo, quantity) : formatExchangeNumber(quantity),
    reduceOnly: true,
  })

  const closeOrderStatus = await fetchBinanceOrderStatus({
    symbol,
    orderId: closeOrder.orderId,
    apiKey,
    secretKey,
  })

  return {
    order: closeOrderStatus || closeOrder,
    exitPrice: getExchangeOrderFillPrice(closeOrderStatus || closeOrder),
    closedAt: Number(closeOrderStatus?.updateTime || Date.now()),
  }
}

async function cancelProtectiveOrdersForTrade(trade, { apiKey, secretKey }) {
  await Promise.allSettled([
    cancelProtectiveOrder({
      symbol: trade.symbol,
      orderId: trade.exchangeStopOrderId,
      algoId: trade.exchangeStopAlgoId,
      clientAlgoId: trade.exchangeStopAlgoClientId || trade.exchangeStopClientOrderId,
      apiKey,
      secretKey,
    }),
    cancelProtectiveOrder({
      symbol: trade.symbol,
      orderId: trade.exchangeTakeProfitOrderId,
      algoId: trade.exchangeTakeProfitAlgoId,
      clientAlgoId: trade.exchangeTakeProfitAlgoClientId || trade.exchangeTakeProfitClientOrderId,
      apiKey,
      secretKey,
    }),
  ])
}

// Create the replacement first, then cancel the existing TP. This order keeps
// the exchange position protected if Binance rejects the replacement request.
async function extendExchangeTakeProfitForBot8(trade, nextTakeProfit, { apiKey, secretKey }) {
  const symbolInfo = findSymbolRules(await fetchFuturesExchangeInfo(), trade.symbol)
  if (!symbolInfo) throw new Error(`No futures symbol rules found for ${trade.symbol}.`)

  const quantity = getTrackedTradeQuantity(trade)
  const triggerPrice = normalizeFuturesPrice(
    symbolInfo,
    nextTakeProfit,
    getProtectiveTriggerRoundMode(trade.side, 'TAKE_PROFIT_MARKET'),
  )
  const replacement = await placeBinanceAlgoOrder({
    apiKey,
    secretKey,
    algoType: 'CONDITIONAL',
    symbol: trade.symbol,
    side: getOppositeTradeSide(trade.side),
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice: formatFuturesPrice(symbolInfo, triggerPrice, getProtectiveTriggerRoundMode(trade.side, 'TAKE_PROFIT_MARKET')),
    quantity: formatFuturesQuantity(symbolInfo, quantity),
    reduceOnly: 'true',
    workingType: 'CONTRACT_PRICE',
    priceProtect: 'TRUE',
    clientAlgoId: `xenios${Date.now()}ai_tp`,
  })

  try {
    await cancelProtectiveOrder({
      symbol: trade.symbol,
      orderId: trade.exchangeTakeProfitOrderId,
      algoId: trade.exchangeTakeProfitAlgoId,
      clientAlgoId: trade.exchangeTakeProfitAlgoClientId || trade.exchangeTakeProfitClientOrderId,
      apiKey,
      secretKey,
    })
  } catch (error) {
    await cancelProtectiveOrder({
      symbol: trade.symbol,
      orderId: replacement?.orderId,
      algoId: replacement?.algoId,
      clientAlgoId: replacement?.clientAlgoId,
      apiKey,
      secretKey,
    }).catch(() => null)
    throw error
  }

  return {
    ...trade,
    takeProfit: triggerPrice,
    exchangeTakeProfitOrderId: replacement.orderId || null,
    exchangeTakeProfitClientOrderId: replacement.clientOrderId || null,
    exchangeTakeProfitAlgoId: replacement.algoId || null,
    exchangeTakeProfitAlgoClientId: replacement.clientAlgoId || null,
  }
}

async function createExchangeTradeExecution(payload, settings, { forceBinance = false } = {}) {
  const { apiKey, secretKey } = getEffectiveCredentials(settings)
  const marginMode = normalizeMarginMode(payload.marginMode ?? settings.strategy.marginMode)

  if (!forceBinance) {
    return {
      mode: 'local-paper',
      validationStatus: 'SIMULATED',
      message: 'Saved as local paper trade for the Phase 2 bot wallet.',
    }
  }

  if (!apiKey || !secretKey) {
    return {
      mode: 'local-paper',
      validationStatus: 'SIMULATED',
      message: 'Binance testnet keys are not configured. Saved as local paper trade.',
    }
  }

  const resolvedSymbolInfo = payload.symbolInfo || findSymbolRules(await fetchFuturesExchangeInfo(), payload.symbol)

  if (!resolvedSymbolInfo) {
    throw new Error(`No futures symbol rules found for ${payload.symbol}.`)
  }

  const normalizedStopLoss = normalizeFuturesPrice(
    resolvedSymbolInfo,
    payload.stopLoss,
    getProtectiveTriggerRoundMode(payload.side, 'STOP_MARKET'),
  )
  const normalizedTakeProfit = normalizeFuturesPrice(
    resolvedSymbolInfo,
    payload.takeProfit,
    getProtectiveTriggerRoundMode(payload.side, 'TAKE_PROFIT_MARKET'),
  )

  await setBinanceMarginType({
    symbol: payload.symbol,
    marginMode,
    apiKey,
    secretKey,
  })
  await setBinanceLeverage({
    symbol: payload.symbol,
    leverage: payload.leverage,
    apiKey,
    secretKey,
  })

  const clientOrderSeed = `xenios${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const entryOrder = await placeBinanceOrder({
    apiKey,
    secretKey,
    symbol: payload.symbol,
    side: payload.side,
    type: 'MARKET',
    quantity: formatFuturesQuantity(resolvedSymbolInfo, payload.quantity),
    newClientOrderId: `${clientOrderSeed}_entry`,
  })
  const entryOrderStatus = await fetchBinanceOrderStatus({
    symbol: payload.symbol,
    orderId: entryOrder.orderId,
    apiKey,
    secretKey,
  })
  const executedQuantity = Number(entryOrderStatus?.executedQty || entryOrder.executedQty || payload.quantity)
  const resolvedEntryPrice = getExchangeOrderFillPrice(entryOrderStatus || entryOrder, payload.entryPrice)

  if (!Number.isFinite(executedQuantity) || executedQuantity <= 0) {
    throw new Error('Binance testnet did not return a valid executed quantity for the entry order.')
  }

  let stopOrder = null
  let takeProfitOrder = null

  try {
    stopOrder = await placeBinanceAlgoOrder({
      apiKey,
      secretKey,
      algoType: 'CONDITIONAL',
      symbol: payload.symbol,
      side: getOppositeTradeSide(payload.side),
      type: 'STOP_MARKET',
      triggerPrice: formatFuturesPrice(
        resolvedSymbolInfo,
        normalizedStopLoss,
        getProtectiveTriggerRoundMode(payload.side, 'STOP_MARKET'),
      ),
      quantity: formatFuturesQuantity(resolvedSymbolInfo, executedQuantity),
      reduceOnly: 'true',
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'TRUE',
      clientAlgoId: `${clientOrderSeed}_sl`,
    })
    takeProfitOrder = await placeBinanceAlgoOrder({
      apiKey,
      secretKey,
      algoType: 'CONDITIONAL',
      symbol: payload.symbol,
      side: getOppositeTradeSide(payload.side),
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: formatFuturesPrice(
        resolvedSymbolInfo,
        normalizedTakeProfit,
        getProtectiveTriggerRoundMode(payload.side, 'TAKE_PROFIT_MARKET'),
      ),
      quantity: formatFuturesQuantity(resolvedSymbolInfo, executedQuantity),
      reduceOnly: 'true',
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'TRUE',
      clientAlgoId: `${clientOrderSeed}_tp`,
    })

    return {
      mode: 'binance-futures-testnet',
      validationStatus: 'EXECUTED',
      message: `Order executed on Binance USD-M Futures Testnet in ${marginMode.toLowerCase()} margin mode with exchange-side protective algo orders.`,
      entryPrice: resolvedEntryPrice > 0 ? resolvedEntryPrice : Number(payload.entryPrice || 0),
      quantity: executedQuantity,
      notional: Number(((resolvedEntryPrice > 0 ? resolvedEntryPrice : Number(payload.entryPrice || 0)) * executedQuantity).toFixed(8)),
      stopLoss: normalizedStopLoss,
      takeProfit: normalizedTakeProfit,
      exchangeEntryOrderId: entryOrderStatus?.orderId || entryOrder.orderId || null,
      exchangeEntryClientOrderId: entryOrderStatus?.clientOrderId || entryOrder.clientOrderId || null,
      exchangeStopOrderId: null,
      exchangeStopClientOrderId: null,
      exchangeTakeProfitOrderId: null,
      exchangeTakeProfitClientOrderId: null,
      exchangeStopAlgoId: stopOrder.algoId || null,
      exchangeStopAlgoClientId: stopOrder.clientAlgoId || null,
      exchangeTakeProfitAlgoId: takeProfitOrder.algoId || null,
      exchangeTakeProfitAlgoClientId: takeProfitOrder.clientAlgoId || null,
    }
  } catch (error) {
    await Promise.allSettled([
      cancelProtectiveOrder({
        symbol: payload.symbol,
        orderId: stopOrder?.orderId,
        algoId: stopOrder?.algoId,
        clientAlgoId: stopOrder?.clientAlgoId,
        apiKey,
        secretKey,
      }),
      cancelProtectiveOrder({
        symbol: payload.symbol,
        orderId: takeProfitOrder?.orderId,
        algoId: takeProfitOrder?.algoId,
        clientAlgoId: takeProfitOrder?.clientAlgoId,
        apiKey,
        secretKey,
      }),
    ])

    await closeExchangePositionImmediately({
      symbol: payload.symbol,
      side: payload.side,
      quantity: executedQuantity,
      symbolInfo: resolvedSymbolInfo,
      apiKey,
      secretKey,
    }).catch(() => null)

    throw new Error(`Failed to place exchange-side stop loss / take profit after entry: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function resolveExchangeClosePriceFromUserTrades(trade, { apiKey, secretKey }) {
  const fills = await fetchBinanceUserTrades({
    symbol: trade.symbol,
    startTime: Math.max(Number(trade.transactTime || 0) - 60_000, 0),
    limit: 100,
    apiKey,
    secretKey,
  })

  const trackedQuantity = getTrackedTradeQuantity(trade)
  const knownOrderIds = new Set([
    Number(trade.exchangeEntryOrderId || 0),
  ])
  const closingFills = (Array.isArray(fills) ? fills : [])
    .filter((fill) => {
      const orderId = Number(fill?.orderId || 0)
      if (!orderId || knownOrderIds.has(orderId)) {
        return false
      }

      const buyer = Boolean(fill?.buyer)
      return String(trade.side || '').toUpperCase() === 'BUY' ? !buyer : buyer
    })
    .sort((left, right) => Number(left?.time || 0) - Number(right?.time || 0))

  if (closingFills.length === 0) {
    return null
  }

  let remainingQuantity = trackedQuantity > 0 ? trackedQuantity : null
  let totalQuantity = 0
  let totalNotional = 0
  let closedAt = 0

  for (const fill of closingFills) {
    const fillQuantity = Number(fill?.qty || 0)
    const fillPrice = Number(fill?.price || 0)
    if (!Number.isFinite(fillQuantity) || fillQuantity <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
      continue
    }

    const usedQuantity = remainingQuantity == null
      ? fillQuantity
      : Math.min(fillQuantity, Math.max(remainingQuantity, 0))
    totalQuantity += usedQuantity
    totalNotional += usedQuantity * fillPrice
    closedAt = Math.max(closedAt, Number(fill?.time || 0))

    if (remainingQuantity != null) {
      remainingQuantity = Math.max(0, remainingQuantity - usedQuantity)
      if (remainingQuantity <= 1e-8) {
        break
      }
    }
  }

  if (totalQuantity <= 0) {
    return null
  }

  return {
    exitPrice: totalNotional / totalQuantity,
    closedAt: closedAt || Date.now(),
  }
}

async function reconcileExchangeTradeState(trade, accountSnapshot, { apiKey, secretKey }, latestPrices) {
  const [stopOrderStatus, takeProfitOrderStatus] = await Promise.all([
    fetchProtectiveOrderStatus({
      symbol: trade.symbol,
      orderId: trade.exchangeStopOrderId,
      algoId: trade.exchangeStopAlgoId,
      clientAlgoId: trade.exchangeStopAlgoClientId || trade.exchangeStopClientOrderId,
      apiKey,
      secretKey,
    }).catch(() => null),
    fetchProtectiveOrderStatus({
      symbol: trade.symbol,
      orderId: trade.exchangeTakeProfitOrderId,
      algoId: trade.exchangeTakeProfitAlgoId,
      clientAlgoId: trade.exchangeTakeProfitAlgoClientId || trade.exchangeTakeProfitClientOrderId,
      apiKey,
      secretKey,
    }).catch(() => null),
  ])

  if (wasProtectiveOrderTriggered(stopOrderStatus)) {
    await cancelProtectiveOrder({
      symbol: trade.symbol,
      orderId: trade.exchangeTakeProfitOrderId,
      algoId: trade.exchangeTakeProfitAlgoId,
      clientAlgoId: trade.exchangeTakeProfitAlgoClientId || trade.exchangeTakeProfitClientOrderId,
      apiKey,
      secretKey,
    }).catch(() => null)
    return closeTradeRecord({
      trade,
      exitPrice: getProtectiveOrderFillPrice(stopOrderStatus, trade.stopLoss),
      status: 'CLOSED_SL',
      result: 'SL',
      closedAt: Number(stopOrderStatus?.triggerTime || stopOrderStatus?.updateTime || Date.now()),
    })
  }

  if (wasProtectiveOrderTriggered(takeProfitOrderStatus)) {
    await cancelProtectiveOrder({
      symbol: trade.symbol,
      orderId: trade.exchangeStopOrderId,
      algoId: trade.exchangeStopAlgoId,
      clientAlgoId: trade.exchangeStopAlgoClientId || trade.exchangeStopClientOrderId,
      apiKey,
      secretKey,
    }).catch(() => null)
    return closeTradeRecord({
      trade,
      exitPrice: getProtectiveOrderFillPrice(takeProfitOrderStatus, trade.takeProfit),
      status: 'CLOSED_TP',
      result: 'TP',
      closedAt: Number(takeProfitOrderStatus?.triggerTime || takeProfitOrderStatus?.updateTime || Date.now()),
    })
  }

  if (isTradePositionStillOpenOnExchange(trade, accountSnapshot)) {
    return trade
  }

  await cancelProtectiveOrdersForTrade(trade, { apiKey, secretKey })
  const reconciledFill = await resolveExchangeClosePriceFromUserTrades(trade, { apiKey, secretKey }).catch(() => null)
  let exitPrice = Number(reconciledFill?.exitPrice || 0)

  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    if (!latestPrices.has(trade.symbol)) {
      const ticker = await fetchTickerPrice(trade.symbol)
      latestPrices.set(trade.symbol, Number(ticker?.price || 0))
    }
    exitPrice = Number(latestPrices.get(trade.symbol) || 0)
  }

  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    return trade
  }

  return closeTradeRecord({
    trade,
    exitPrice,
    status: 'CLOSED_MANUAL',
    result: 'SYNC',
    closedAt: Number(reconciledFill?.closedAt || Date.now()),
  })
}

async function recordTrade({
  symbol,
  side,
  quantity,
  stopLoss,
  takeProfit,
  symbolInfo = null,
  entryPrice,
  notional,
  margin,
  marginMode,
  leverage,
  configuredStopLossPercent,
  source,
  signalSummary,
  signalModelId,
  signalModelName,
  aiDecision,
  aiReview,
  walletId,
  walletName,
}) {
  const settings = await getSettings()
  const wallets = normalizeWallets(settings.wallets)
  const wallet = getWalletById(walletId, wallets)
  const mustExecuteOnBinance = requiresBinanceExecution({ wallet, source })
  if (mustExecuteOnBinance && !hasExchangeCredentials(settings)) {
    throw new Error(
      isAutoTradeSource(source)
        ? 'Auto trades must execute on Binance Futures Testnet. Configure the Binance Testnet API key and secret before the bot can open a trade.'
        : 'Binance Futures Testnet API key and secret are required before a Phase 2 wallet can place a trade.',
    )
  }
  const resolvedConfiguredStopLossPercent = Number(
    configuredStopLossPercent ?? settings.strategy.stopLossPercent ?? 0,
  )
  const normalizedOrder = normalizeTradeRisk({
    symbol,
    side,
    stopLoss,
    entryPrice,
    notional,
    configuredStopLossPercent: resolvedConfiguredStopLossPercent,
  }, settings.strategy)
  const resolvedMarginMode = normalizeMarginMode(marginMode ?? settings.strategy.marginMode)
  const execution = await createExchangeTradeExecution({
    symbol,
    side,
    quantity,
    symbolInfo,
    stopLoss: normalizedOrder.stopLoss,
    takeProfit,
    entryPrice,
    leverage,
    marginMode: resolvedMarginMode,
  }, settings, { forceBinance: mustExecuteOnBinance })
  if (mustExecuteOnBinance && execution.mode !== 'binance-futures-testnet') {
    throw new Error(
      isAutoTradeSource(source)
        ? 'Auto trades must execute on Binance Futures Testnet. The order was blocked because Binance execution was not confirmed.'
        : 'Phase 2 wallets must execute on Binance Futures Testnet. Check the API credentials and wallet sync state.',
    )
  }
  const resolvedQuantity = Number(execution.quantity || quantity)
  const resolvedEntryPrice = Number(execution.entryPrice || entryPrice)
  const resolvedNotional = Number(execution.notional || notional || (resolvedEntryPrice * resolvedQuantity))
  const resolvedStopLoss = Number(execution.stopLoss || normalizedOrder.stopLoss)
  const resolvedTakeProfit = Number(execution.takeProfit || takeProfit)
  const order = {
    id: `${source.toLowerCase()}-${Date.now()}`,
    symbol,
    side,
    type: 'MARKET',
    quantity: resolvedQuantity,
    stopLoss: resolvedStopLoss,
    takeProfit: resolvedTakeProfit,
    entryPrice: resolvedEntryPrice,
    notional: resolvedNotional,
    margin,
    marginMode: resolvedMarginMode,
    leverage,
    status: 'OPEN',
    validationStatus: execution.validationStatus,
    mode: execution.mode,
    source,
    signalSummary,
    signalModelId: signalModelId || null,
    signalModelName: signalModelName || null,
    aiDecision: aiDecision || null,
    aiReview: aiReview || null,
    walletId: wallet?.id || walletId || null,
    walletName: wallet?.name || walletName || null,
    walletColorKey: wallet?.colorKey || null,
    transactTime: Date.now(),
    tradeDateKey: manilaDateKey(),
    journalDateKey: manilaDateKey(),
    maxLossPerTrade: normalizedOrder.maxLossPerTrade,
    configuredStopLossPercent: normalizedOrder.configuredStopLossPercent,
    exchangeEntryOrderId: execution.exchangeEntryOrderId || null,
    exchangeEntryClientOrderId: execution.exchangeEntryClientOrderId || null,
    exchangeStopOrderId: execution.exchangeStopOrderId || null,
    exchangeStopClientOrderId: execution.exchangeStopClientOrderId || null,
    exchangeTakeProfitOrderId: execution.exchangeTakeProfitOrderId || null,
    exchangeTakeProfitClientOrderId: execution.exchangeTakeProfitClientOrderId || null,
    exchangeStopAlgoId: execution.exchangeStopAlgoId || null,
    exchangeStopAlgoClientId: execution.exchangeStopAlgoClientId || null,
    exchangeTakeProfitAlgoId: execution.exchangeTakeProfitAlgoId || null,
    exchangeTakeProfitAlgoClientId: execution.exchangeTakeProfitAlgoClientId || null,
    exchangeExecutedQuantity: resolvedQuantity,
    pnl: null,
    exitPrice: null,
    result: null,
  }

  await appendTradeHistory(order)
  if (wallet && isExchangeSyncWallet(wallet)) {
    await syncExchangeWalletBalance({
      settings,
      walletId: wallet.id,
      suppressErrors: true,
    })
  }
  return {
    message: execution.message,
    mode: execution.mode,
    order,
  }
}

function closeTradeRecord({
  trade,
  exitPrice,
  status,
  result,
  closedAt = Date.now(),
}) {
  const resolvedExitPrice = Number(exitPrice)

  if (!Number.isFinite(resolvedExitPrice) || resolvedExitPrice <= 0) {
    throw new Error('A valid exit price is required to close the trade.')
  }

  return {
    ...trade,
    status,
    exitPrice: resolvedExitPrice,
    result,
    closedAt,
    closedDateKey: manilaDateKey(closedAt),
    pnl: getTradePnlForExitPrice(trade, resolvedExitPrice),
  }
}

function applyAiOpenTradeManagement(trade = {}, currentPrice = 0, trainStatus = null, learningBotSettings = defaultLearningBotSettings) {
  const signalModelId = ensureSignalModelId(trade.signalModelId)
  const isBot8Trade = signalModelId === 'model-8'
  // Bot 8 is intentionally managed on Testnet too. Other exchange trades keep
  // their existing exchange-side brackets unchanged by this local policy layer.
  if (trade.status !== 'OPEN' || (isBinanceTestnetTrade(trade) && !isBot8Trade)) {
    return trade
  }

  const entryPrice = Number(trade.entryPrice || 0)
  const stopLoss = Number(trade.stopLoss || 0)
  const takeProfit = Number(trade.takeProfit || 0)
  const livePrice = Number(currentPrice || 0)

  if (![entryPrice, stopLoss, takeProfit, livePrice].every((value) => Number.isFinite(value) && value > 0)) {
    return trade
  }

  const config = normalizeLearningBotSettings(learningBotSettings)
  const perBotOverride = config.perBotOverrides?.[signalModelId] || null
  const aiEnabled = isBot8Trade || Boolean(perBotOverride?.enabled || config.aiEntryFilter.enabled)

  if (!aiEnabled || !trainStatus?.metrics) {
    return trade
  }

  const decision = scoreCandidateWithAiFilter({
    summary: trade.signalSummary,
    configuredStopLossPercent: trade.configuredStopLossPercent,
    leverage: trade.leverage,
    signalModelId,
  }, trainStatus, config)
  const direction = trade.side === 'BUY' ? 1 : -1
  const initialRisk = direction === 1 ? entryPrice - stopLoss : stopLoss - entryPrice
  const initialReward = direction === 1 ? takeProfit - entryPrice : entryPrice - takeProfit

  if (!(initialRisk > 0) || !(initialReward > 0)) {
    return trade
  }

  const progressToTarget = direction === 1
    ? (livePrice - entryPrice) / initialReward
    : (entryPrice - livePrice) / initialReward
  const inProfit = progressToTarget > 0
  let nextStopLoss = stopLoss
  let nextTakeProfit = takeProfit
  let managementAction = null
  let managementReason = ''

  // At 50x, the structural stop is deliberately well inside the theoretical
  // liquidation distance. A policy rejection plus an early adverse move is an
  // emergency exit signal; it is not presented as a prediction of liquidation.
  if (isBot8Trade && !decision.accept && progressToTarget <= -0.2) {
    managementAction = 'emergency-exit'
    managementReason = `Bot 8 AI rejected ${decision.setupFamily} at ${decision.finalScore}/${decision.thresholdScore} after an adverse move; closing well before the liquidation zone.`
  }

  if (!managementAction && decision.accept) {
    if (progressToTarget >= 0.45) {
      nextStopLoss = direction === 1
        ? Math.max(stopLoss, entryPrice)
        : Math.min(stopLoss, entryPrice)
      managementAction = 'protect-profit'
      managementReason = `AI accepted ${decision.setupFamily} and moved stop toward breakeven at score ${decision.finalScore}/${decision.thresholdScore}.`
    }

    if (progressToTarget >= (isBot8Trade ? 0.7 : 0.75) && Number(decision.setupStats?.avgReward || 0) > 0) {
      nextTakeProfit = direction === 1
        ? Math.max(nextTakeProfit, entryPrice + (initialReward * (isBot8Trade ? 1.2 : 1.12)))
        : Math.min(nextTakeProfit, entryPrice - (initialReward * (isBot8Trade ? 1.2 : 1.12)))
      managementAction = 'extend-target'
      managementReason = `AI accepted ${decision.setupFamily} and extended take profit using profitable policy data.`
    }
  } else if (!managementAction && inProfit && progressToTarget >= 0.2) {
    nextStopLoss = direction === 1
      ? Math.max(stopLoss, entryPrice - (initialRisk * 0.35))
      : Math.min(stopLoss, entryPrice + (initialRisk * 0.35))
    nextTakeProfit = direction === 1
      ? Math.min(takeProfit, entryPrice + (initialReward * 0.82))
      : Math.max(takeProfit, entryPrice - (initialReward * 0.82))
    managementAction = 'tighten-risk'
    managementReason = `AI cautioned on ${decision.setupFamily} at ${decision.finalScore}/${decision.thresholdScore}, so the open trade tightened TP/SL.`
  }

  const roundedStopLoss = Number(nextStopLoss.toFixed(8))
  const roundedTakeProfit = Number(nextTakeProfit.toFixed(8))

  if (roundedStopLoss === Number(stopLoss.toFixed(8)) && roundedTakeProfit == Number(takeProfit.toFixed(8))) {
    return trade
  }

  return {
    ...trade,
    stopLoss: roundedStopLoss,
    takeProfit: roundedTakeProfit,
    aiManagement: {
      finalScore: decision.finalScore,
      thresholdScore: decision.thresholdScore,
      setupFamily: decision.setupFamily,
      policySource: decision.policySource,
      action: managementAction || 'adjusted',
      reason: managementReason || 'AI adjusted the open-trade management levels.',
      managedAt: Date.now(),
      referencePrice: livePrice,
    },
  }
}

async function updateOpenTrades() {
  let settings = await getSettings()
  const learningBotTrainStatus = await getLearningBotTrainStatus().catch(() => defaultLearningBotTrainStatus)
  const exchangeCredentials = getEffectiveCredentials(settings)
  const syncedWallet = getPrimaryExchangeSyncedWallet(settings.wallets)
  let exchangeAccountSnapshot = null

  if (syncedWallet) {
    const syncResult = await syncExchangeWalletBalance({
      settings,
      walletId: syncedWallet.id,
      suppressErrors: true,
    })
    settings = syncResult.settings
    exchangeAccountSnapshot = syncResult.accountSnapshot
  }

  const history = await getTradeHistory()
  const openTrades = history.filter((item) => item.status === 'OPEN')
  const shouldRefreshTerminalMonitor = Date.now() - lastTerminalTradeMonitorAt >= TERMINAL_TRADE_MONITOR_INTERVAL_MS

  if (shouldRefreshTerminalMonitor) {
    const livePriceMap = openTrades.length > 0
      ? await getLivePriceMapForTrades(openTrades).catch(() => ({}))
      : {}
    logTerminalMonitorSnapshot(settings, openTrades, livePriceMap, learningBotTrainStatus)
    lastTerminalTradeMonitorAt = Date.now()
  }

  if (openTrades.length === 0) {
    return
  }

  const latestPrices = new Map()
  let changed = false
  const updated = []

  for (const trade of history) {
    const normalizedTrade = normalizeTradeRisk(trade, settings.strategy)
    if (JSON.stringify(normalizedTrade) !== JSON.stringify(trade)) {
      changed = true
    }

    if (normalizedTrade.status !== 'OPEN') {
      updated.push(normalizedTrade)
      continue
    }

    if (isBinanceTestnetTrade(normalizedTrade) && exchangeAccountSnapshot && exchangeCredentials.apiKey && exchangeCredentials.secretKey) {
      let reconciledTrade = await reconcileExchangeTradeState(
        normalizedTrade,
        exchangeAccountSnapshot,
        exchangeCredentials,
        latestPrices,
      )

      if (reconciledTrade.status === 'OPEN' && ensureSignalModelId(reconciledTrade.signalModelId) === 'model-8') {
        const ticker = await fetchTickerPrice(reconciledTrade.symbol).catch(() => null)
        const livePrice = Number(ticker?.price || 0)
        const managedTrade = applyAiOpenTradeManagement(reconciledTrade, livePrice, learningBotTrainStatus, settings.learningBot)
        const managementAction = managedTrade.aiManagement?.action

        if (managementAction === 'emergency-exit') {
          await cancelProtectiveOrdersForTrade(reconciledTrade, exchangeCredentials)
          const closeResult = await closeExchangePositionImmediately({
            symbol: reconciledTrade.symbol,
            side: reconciledTrade.side,
            quantity: getTrackedTradeQuantity(reconciledTrade),
            apiKey: exchangeCredentials.apiKey,
            secretKey: exchangeCredentials.secretKey,
          })
          reconciledTrade = closeTradeRecord({
            trade: managedTrade,
            exitPrice: Number(closeResult.exitPrice || livePrice),
            status: 'CLOSED_AI_RISK',
            result: 'AI_RISK',
            closedAt: closeResult.closedAt,
          })
        } else if (managementAction === 'extend-target' && Number(managedTrade.takeProfit) !== Number(reconciledTrade.takeProfit)) {
          reconciledTrade = await extendExchangeTakeProfitForBot8(reconciledTrade, managedTrade.takeProfit, exchangeCredentials)
          reconciledTrade = { ...reconciledTrade, aiManagement: managedTrade.aiManagement }
        } else if (JSON.stringify(managedTrade) !== JSON.stringify(reconciledTrade)) {
          reconciledTrade = managedTrade
        }
      }

      if (JSON.stringify(reconciledTrade) !== JSON.stringify(normalizedTrade)) {
        changed = true
      }

      if (normalizedTrade.status === 'OPEN' && reconciledTrade.status !== 'OPEN') {
        logTradeClosedToTerminal(normalizedTrade, reconciledTrade)
      }

      updated.push(reconciledTrade)
      continue
    }

    if (!latestPrices.has(normalizedTrade.symbol)) {
      const [ticker, candles] = await Promise.all([
        fetchTickerPrice(normalizedTrade.symbol),
        fetchKlines(normalizedTrade.symbol, '1m', 2),
      ])
      const latestCandle = candles[candles.length - 1]
      const currentPrice = Number(ticker.price)
      const candleHigh = Number(latestCandle?.[2] || currentPrice)
      const candleLow = Number(latestCandle?.[3] || currentPrice)
      latestPrices.set(normalizedTrade.symbol, {
        currentPrice,
        latestCandleOpenTime: Number(latestCandle?.[0] || 0),
        observedHigh: Math.max(currentPrice, candleHigh),
        observedLow: Math.min(currentPrice, candleLow),
      })
    }

    const priceSnapshot = latestPrices.get(normalizedTrade.symbol)
    if (!priceSnapshot) {
      updated.push(normalizedTrade)
      continue
    }

    const currentPrice = Number(priceSnapshot.currentPrice)
    const managedTrade = applyAiOpenTradeManagement(normalizedTrade, currentPrice, learningBotTrainStatus, settings.learningBot)

    if (JSON.stringify(managedTrade) !== JSON.stringify(normalizedTrade)) {
      changed = true
      const action = managedTrade.aiManagement?.action || 'adjusted'
      const reason = managedTrade.aiManagement?.reason || 'AI adjusted the open-trade management levels.'
      logTerminalLine('AI', `${managedTrade.symbol} open trade ${action}: ${reason}`, 'accent')
    }

    if (managedTrade.aiManagement?.action === 'emergency-exit') {
      changed = true
      const closedTrade = closeTradeRecord({
        trade: managedTrade,
        exitPrice: currentPrice,
        status: 'CLOSED_AI_RISK',
        result: 'AI_RISK',
      })
      logTradeClosedToTerminal(normalizedTrade, closedTrade)
      updated.push(closedTrade)
      continue
    }

    const tradeAgeHours = (Date.now() - Number(managedTrade.transactTime || 0)) / 3_600_000
    if (tradeAgeHours >= PAPER_TRADE_MAX_HOLD_HOURS) {
      changed = true
      const closedTrade = closeTradeRecord({
        trade: managedTrade,
        exitPrice: currentPrice,
        status: 'CLOSED_TIMEOUT',
        result: 'TIMEOUT',
      })
      logTradeClosedToTerminal(normalizedTrade, closedTrade)
      updated.push(closedTrade)
      continue
    }

    const canUseObservedRange = Number(managedTrade.transactTime || 0) < Number(priceSnapshot.latestCandleOpenTime || 0)
    const observedHigh = canUseObservedRange ? Number(priceSnapshot.observedHigh) : currentPrice
    const observedLow = canUseObservedRange ? Number(priceSnapshot.observedLow) : currentPrice
    const effectiveStopLoss = Number(managedTrade.stopLoss)
    const hitTakeProfit = managedTrade.side === 'BUY'
      ? observedHigh >= managedTrade.takeProfit
      : observedLow <= managedTrade.takeProfit
    const hitPriceStopLoss = managedTrade.side === 'BUY'
      ? observedLow <= effectiveStopLoss
      : observedHigh >= effectiveStopLoss

    // Bot 4 hard money stop: cut the position the moment it is worth -1 USDT or worse,
    // regardless of where the price-based stop sits. Winners are left to run to the take-profit.
    const isBot4Trade = ensureSignalModelId(managedTrade.signalModelId) === 'model-4'
    const unrealizedPnlNow = getTradePnlForExitPrice(managedTrade, currentPrice)
    const hitMoneyStop = isBot4Trade
      && Number.isFinite(unrealizedPnlNow)
      && unrealizedPnlNow <= -MODEL4_HARD_MONEY_STOP_USDT
    const hitStopLoss = hitPriceStopLoss || hitMoneyStop

    if (!hitTakeProfit && !hitStopLoss) {
      updated.push(managedTrade)
      continue
    }

    // If both levels were touched in the same observed range, prefer the stop for conservative risk handling.
    // A money-stop-only exit settles at the current price where the -1 USDT threshold was crossed.
    const exitPrice = hitStopLoss
      ? (hitPriceStopLoss ? effectiveStopLoss : currentPrice)
      : Number(managedTrade.takeProfit)
    changed = true
    const closedTrade = closeTradeRecord({
      trade: managedTrade,
      exitPrice,
      status: hitStopLoss ? 'CLOSED_SL' : 'CLOSED_TP',
      result: hitStopLoss ? 'SL' : 'TP',
    })
    logTradeClosedToTerminal(normalizedTrade, closedTrade)
    updated.push(closedTrade)
  }

  if (changed) {
    await saveTradeHistory(updated)
    await maybeRefreshLearningBotPolicy('TRADE_RECONCILE_CLOSE', settings)
    await persistBotSettingsLog({
      trigger: 'TRADE_RECONCILE',
      note: 'Captured after open-trade reconciliation updated the saved trade history.',
      settings,
      history: updated,
    }).catch((error) => {
      console.error('Failed to persist bot settings log after trade reconciliation:', error)
    })
  }
}

// Runs `worker` over `items` with at most `limit` in flight at once, keeping
// the results in input order.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

async function runAutoTrader(trigger = 'MANUAL') {
  const runSteps = []
  const pushStep = (message, status = 'info', extra = {}) => {
    const step = { message, status, ...extra }
    runSteps.push(step)
    logAutoTradeStepToTerminal(step)
    broadcastAutoTradeEvent('step', step)
  }
  const runId = `run-${Date.now()}`

  if (autoTradeRuntime.running) {
    const result = { executed: false, reason: 'Auto trade is already running.', steps: runSteps, runId }
    setAutoTradeOutcome(result)
    return result
  }

  setAutoTradeRunningState(true, runId)

  try {
    let settings = await getSettings()
    pushStep('Loaded strategy settings.', 'info')

    if (trigger === 'SCHEDULED' && !settings.strategy.autoTradingEnabled) {
      pushStep('Auto trading is disabled in settings.', 'blocked')
      const result = { executed: false, reason: 'Auto trading is disabled.', steps: runSteps, runId }
      setAutoTradeOutcome(result)
      return result
    }

    if (trigger === 'SCHEDULED' && !isWithinTradingSession(settings.strategy)) {
      pushStep('Skipped run because current Manila time is outside trading sessions.', 'blocked')
      const result = { executed: false, reason: 'Outside configured trading sessions.', steps: runSteps, runId }
      setAutoTradeOutcome(result)
      return result
    }

    if (!ensureNotCancelled(runSteps)) {
      const result = { executed: false, reason: 'Auto trade stopped by user.', steps: runSteps, runId }
      setAutoTradeOutcome(result)
      return result
    }

    const history = await getTradeHistory()
    const todayKey = manilaDateKey()
    const openTrades = history.filter((item) => item.status === 'OPEN')
    const openTradePrices = await getLivePriceMapForTrades(openTrades)
    const marketDataHealth = getMarketDataHealthSnapshot()
    if (marketDataHealth.degraded) {
      pushStep(`Paused scan because market data is degraded for another ${Math.ceil(marketDataHealth.circuitOpenForMs / 1000)}s.`, 'blocked', {
        marketDataHealth,
      })
      const result = {
        executed: false,
        reason: 'Market data is degraded. Auto-trade scan paused until the upstream cooldown clears.',
        steps: runSteps,
        runId,
      }
      setAutoTradeOutcome(result)
      return result
    }
    let exchangeInfo

    try {
      exchangeInfo = await fetchFuturesExchangeInfo()
      settings = await syncPreferredSymbolsWithVolatility(settings, exchangeInfo)
    } catch (error) {
      pushStep('Skipped run because Binance market data is temporarily unavailable.', 'blocked')
      const result = {
        executed: false,
        reason: 'Binance market data is temporarily unavailable. Try again shortly.',
        steps: runSteps,
        runId,
      }
      setAutoTradeOutcome(result)
      return result
    }

    const universeSymbols = settings.strategy.preferredSymbols || []
    const enabledWallets = getTradingWallets(settings.wallets).filter((wallet) => wallet.enabled)
    pushStep('Fetched Binance Futures exchange info.', 'info')
    pushStep(`Liquidity x volatility scan selected the top ${universeSymbols.length} symbols: ${universeSymbols.join(', ')}.`, 'info')
    pushStep(
      `Enabled wallets: ${enabledWallets.length > 0 ? enabledWallets.map((wallet) => `${wallet.name} -> ${getSignalModel(wallet.assignedSignalModelId).name}`).join(', ') : 'none'}.`,
      enabledWallets.length > 0 ? 'info' : 'blocked',
    )

    if (universeSymbols.length === 0) {
      pushStep('No volatile futures symbols available to scan.', 'blocked')
      const result = { executed: false, reason: 'No volatile futures symbols available.', steps: runSteps, runId }
      setAutoTradeOutcome(result)
      return result
    }

    if (enabledWallets.length === 0) {
      const result = { executed: false, reason: 'No enabled wallets are configured for automated testing.', steps: runSteps, runId }
      setAutoTradeOutcome(result)
      return result
    }

    const symbolInputCache = new Map()
    async function getSymbolInputs(symbol) {
      if (!symbolInputCache.has(symbol)) {
        symbolInputCache.set(symbol, Promise.all([
          fetchKlines(symbol, '1h', 120),
          fetchKlines(symbol, '15m', 120),
          fetchKlines(symbol, '5m', 120),
          fetchKlines(symbol, '1m', 180),
          fetchSignalMarketContext(symbol),
        ]).then(([bias, higher, entry, trigger, marketContext]) => ({
          bias: toCandleData(bias),
          higher: toCandleData(higher),
          entry: toCandleData(entry),
          trigger: toCandleData(trigger),
          marketContext,
        })))
      }

      return symbolInputCache.get(symbol)
    }

    const walletResults = []
    for (const wallet of enabledWallets) {
      const walletSteps = []
      const walletSignalModelId = ensureSignalModelId(wallet.assignedSignalModelId)
      const walletSignalModel = getSignalModel(walletSignalModelId)
      let resolvedWallet = wallet
      let syncedAccountSnapshot = null
      const pushWalletStep = (message, status = 'info', extra = {}) => {
        const walletStep = {
          message,
          status,
          walletId: resolvedWallet.id,
          walletName: resolvedWallet.name,
          ...extra,
        }
        walletSteps.push(walletStep)
        pushStep(`[${wallet.name}] ${message}`, status, {
          walletId: resolvedWallet.id,
          walletName: resolvedWallet.name,
          ...extra,
        })
      }
      const finishWallet = async (result) => {
        const walletResult = {
          walletId: resolvedWallet.id,
          walletName: resolvedWallet.name,
          signalModelId: walletSignalModelId,
          signalModelName: walletSignalModel.name,
          steps: walletSteps,
          ...result,
        }
        walletResults.push(walletResult)
        await appendAutoTradeLog({
          type: 'AUTO_RUN',
          trigger,
          walletId: resolvedWallet.id,
          walletName: resolvedWallet.name,
          signalModelId: walletSignalModelId,
          signalModelName: walletSignalModel.name,
          result: walletResult,
        })
        return walletResult
      }
      const walletCancelled = async () => {
        pushWalletStep('Manual stop requested. Aborting this wallet scan.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'Auto trade stopped by user.',
          order: null,
        })
        return {
          executed: false,
          reason: 'Auto trade stopped by user.',
          steps: runSteps,
          runId,
          walletResults,
        }
      }

      if (isExchangeSyncWallet(wallet)) {
        const syncResult = await syncExchangeWalletBalance({
          settings,
          walletId: wallet.id,
          suppressErrors: true,
        })
        settings = syncResult.settings
        resolvedWallet = getWalletById(wallet.id, settings.wallets) || wallet
        syncedAccountSnapshot = syncResult.accountSnapshot

        if (!syncedAccountSnapshot) {
          pushWalletStep(
            resolvedWallet.production.lastError || 'Phase 2 wallet sync is not connected to Binance Futures Testnet yet.',
            'blocked',
          )
          await finishWallet({
            executed: false,
            reason: 'Phase 2 wallet sync is not connected.',
            order: null,
          })
          continue
        }
      }

      pushWalletStep(`Assigned model: ${walletSignalModel.name} (${walletSignalModel.tag}).`, 'info')
      pushWalletStep(
        `Capital mode ${resolvedWallet.balanceMode}. Starting balance ${getWalletEffectiveStartingBalance(resolvedWallet).toFixed(2)} USDT.`,
        'info',
      )

      if (walletSignalModel.status === 'blank') {
        pushWalletStep('Assigned model has no trade rules yet.', 'blocked')
        await finishWallet({
          executed: false,
          reason: `${walletSignalModel.name} is blank and cannot trade yet.`,
          order: null,
        })
        continue
      }

      const walletHistory = history.filter((trade) => trade.walletId === resolvedWallet.id)
      const walletToday = summarizeToday(walletHistory, todayKey)
      const walletOpenTrades = walletHistory.filter((trade) => trade.status === 'OPEN')
      const walletOpenAutoTrades = walletOpenTrades.filter((trade) => isAutoTradeSource(trade.source))
      const walletOpenPaperAutoTrades = walletOpenAutoTrades.filter((trade) => trade.mode === 'local-paper')
      // This clean-slate gate only matters for wallets promoted to live/Testnet
      // execution. Local-paper bot wallets run continuously and are capped by
      // their own maxOpenPositions, so an open paper trade must not freeze them.
      if (walletOpenPaperAutoTrades.length > 0 && isExchangeSyncWallet(resolvedWallet)) {
        pushWalletStep(
          `Found ${walletOpenPaperAutoTrades.length} open local-paper auto trade${walletOpenPaperAutoTrades.length === 1 ? '' : 's'} in this wallet. Close them manually before Phase 3 Binance execution can continue.`,
          'blocked',
        )
        await finishWallet({
          executed: false,
          reason: 'Open local-paper auto trades must be cleared before new Binance Testnet auto trades are allowed.',
          order: null,
        })
        continue
      }
      const baseWalletAccountSnapshot = summarizeAccount({
        trades: walletHistory,
        livePrices: openTradePrices,
        strategy: settings.strategy,
        startingBalance: getWalletEffectiveStartingBalance(resolvedWallet),
      })
      const walletStrategy = getEffectiveSignalModelStrategy(settings.strategy, walletSignalModelId, {
        runningBalance: baseWalletAccountSnapshot.runningBalance,
      })
      let walletAccountSnapshot = summarizeAccount({
        trades: walletHistory,
        livePrices: openTradePrices,
        strategy: walletStrategy,
        startingBalance: getWalletEffectiveStartingBalance(resolvedWallet),
      })

      if (isExchangeSyncWallet(resolvedWallet) && syncedAccountSnapshot) {
        const syncedWalletBalance = Number(
          syncedAccountSnapshot.totalWalletBalance
          ?? resolvedWallet.production.lastSyncedBalance
          ?? walletAccountSnapshot.walletBalance,
        )
        const syncedUnrealizedPnl = Number(
          syncedAccountSnapshot.totalUnrealizedProfit
          ?? resolvedWallet.production.lastSyncedUnrealizedPnl
          ?? walletAccountSnapshot.unrealizedPnl,
        )
        const syncedRunningBalance = Number((syncedWalletBalance + syncedUnrealizedPnl).toFixed(2))
        const syncedAvailableBalance = Number(
          syncedAccountSnapshot.availableBalance
          ?? resolvedWallet.production.lastSyncedAvailableBalance
          ?? walletAccountSnapshot.availableBalance,
        )
        const marginPerTrade = Number(walletAccountSnapshot.marginPerTrade || 0)
        const configuredMaxOpenPositions = Number(walletAccountSnapshot.configuredMaxOpenPositions || 0)
        const balanceBasedMaxOpenPositions = marginPerTrade > 0
          ? Math.max(Math.floor(Math.max(syncedRunningBalance, 0) / marginPerTrade), 0)
          : 0
        const effectiveMaxOpenPositions = configuredMaxOpenPositions > 0
          ? Math.min(configuredMaxOpenPositions, balanceBasedMaxOpenPositions)
          : balanceBasedMaxOpenPositions
        const availableMarginSlots = marginPerTrade > 0
          ? Math.max(Math.floor(Math.max(syncedAvailableBalance, 0) / marginPerTrade), 0)
          : 0
        const remainingOpenSlots = Math.max(
          Math.min(effectiveMaxOpenPositions - walletAccountSnapshot.openTradeCount, availableMarginSlots),
          0,
        )

        walletAccountSnapshot = {
          ...walletAccountSnapshot,
          startingBalance: syncedWalletBalance,
          walletBalance: syncedWalletBalance,
          unrealizedPnl: syncedUnrealizedPnl,
          runningBalance: syncedRunningBalance,
          availableBalance: syncedAvailableBalance,
          balanceBasedMaxOpenPositions,
          effectiveMaxOpenPositions,
          availableMarginSlots,
          remainingOpenSlots,
        }
      }
      const reservedOpenRisk = Number(walletOpenAutoTrades.reduce((sum, trade) => sum + getTradeRiskAmount(trade, walletStrategy), 0).toFixed(2))

      pushWalletStep(
        `Today's stats: trades=${walletToday.tradeCount}, losses=${walletToday.lossCount}, realizedLoss=${walletToday.realizedLoss}, reservedRisk=${reservedOpenRisk}, pnl=${walletToday.pnl}.`,
        'info',
      )
      if (walletStrategy.usesDedicatedRiskProfile && walletStrategy.riskProfile?.summary) {
        pushWalletStep(`Dedicated risk profile active: ${walletStrategy.riskProfile.summary}`, 'info')
      }
      pushWalletStep(
        `Account snapshot: runningBalance=${walletAccountSnapshot.runningBalance}, availableBalance=${walletAccountSnapshot.availableBalance}, reservedMargin=${walletAccountSnapshot.reservedMargin}, openPositions=${walletAccountSnapshot.openTradeCount}/${walletAccountSnapshot.effectiveMaxOpenPositions}, freeSlots=${walletAccountSnapshot.remainingOpenSlots}.`,
        'info',
      )

      const walletScanSymbols = getSignalModelTrackedSymbols(walletSignalModelId, universeSymbols)
      pushWalletStep(
        walletScanSymbols.length > 0
          ? `Scan universe for this wallet: ${walletScanSymbols.join(', ')}.`
          : 'No symbols are assigned to this wallet scan.',
        walletScanSymbols.length > 0 ? 'info' : 'blocked',
      )

      if (walletScanSymbols.length === 0) {
        await finishWallet({
          executed: false,
          reason: 'No symbols are assigned to this wallet scan.',
          order: null,
        })
        continue
      }

      if (walletSignalModelId === 'model-11') {
        // Bot Claude's per-symbol builder is synchronous and only reads a
        // cache; this is the one place that actually calls the live
        // Anthropic API, once per closed 5M candle per symbol.
        await refreshBotClaudeDecisions({ symbols: walletScanSymbols, getSymbolInputs }).catch((error) => {
          pushWalletStep(`Claude API refresh failed: ${error instanceof Error ? error.message : error}`, 'blocked')
        })
      }

      if (walletSignalModelId === 'model-4') {
        const consecutiveLossStreak = getConsecutiveAutoLossStreak(walletHistory)

        if (consecutiveLossStreak >= 3) {
          pushWalletStep('Bot 4 has a recent 3-loss streak, but the AI-gated EMA/RSI scalper stays active until its configured daily loss limit is reached.', 'info')
        }
      }

      if (walletToday.realizedLoss >= walletStrategy.maxLossPerDay) {
        pushWalletStep('Daily max loss reached for this wallet.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'Daily max loss reached.',
          order: null,
        })
        continue
      }

      if (walletToday.realizedLoss + reservedOpenRisk >= walletStrategy.maxLossPerDay) {
        pushWalletStep('Daily max loss budget is already reserved by open positions.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'Daily max loss budget is already reserved by open positions.',
          order: null,
        })
        continue
      }

      if (walletAccountSnapshot.marginPerTrade > 0 && walletAccountSnapshot.availableBalance < walletAccountSnapshot.marginPerTrade) {
        pushWalletStep(
          `Available balance ${walletAccountSnapshot.availableBalance.toFixed(2)} USDT is below margin per trade ${walletAccountSnapshot.marginPerTrade.toFixed(2)} USDT.`,
          'blocked',
        )
        await finishWallet({
          executed: false,
          reason: 'Insufficient available balance for the next trade.',
          order: null,
        })
        continue
      }

      if (walletAccountSnapshot.effectiveMaxOpenPositions > 0 && walletAccountSnapshot.openTradeCount >= walletAccountSnapshot.effectiveMaxOpenPositions) {
        pushWalletStep(
          `Open position cap reached (${walletAccountSnapshot.openTradeCount}/${walletAccountSnapshot.effectiveMaxOpenPositions}).`,
          'blocked',
        )
        await finishWallet({
          executed: false,
          reason: 'Maximum open positions reached.',
          order: null,
        })
        continue
      }

      if (walletAccountSnapshot.remainingOpenSlots <= 0) {
        pushWalletStep('No free position slots remain after balance and margin checks.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'No free position slots remain for a new trade.',
          order: null,
        })
        continue
      }

      if (walletToday.lossCount >= walletStrategy.maxLossesPerDay) {
        pushWalletStep('Daily loss count limit reached.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'Daily loss count limit reached.',
          order: null,
        })
        continue
      }

      if (walletToday.pnl >= walletStrategy.dailyProfitTarget) {
        pushWalletStep('Daily profit target already reached.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'Daily profit target already reached.',
          order: null,
        })
        continue
      }

      if (walletToday.tradeCount >= walletStrategy.maxTradesPerDay) {
        pushWalletStep('Daily trade limit reached.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'Daily trade limit reached.',
          order: null,
        })
        continue
      }

      if (autoTradeRuntime.cancelRequested) {
        const result = await walletCancelled()
        setAutoTradeOutcome(result)
        return result
      }

      const analyses = []
      let scanCancelled = false
      let scanSkipped = 0

      for (let start = 0; start < walletScanSymbols.length; start += SIGNAL_SCAN_CONCURRENCY) {
        if (autoTradeRuntime.cancelRequested) {
          scanCancelled = true
          break
        }

        const batch = walletScanSymbols.slice(start, start + SIGNAL_SCAN_CONCURRENCY)
        const batchResults = await mapWithConcurrency(batch, SIGNAL_SCAN_CONCURRENCY, async (symbol) => {
          try {
            const marketInputs = await getSymbolInputs(symbol)
            const analysis = analyzeSymbolStrategy(
              symbol,
              marketInputs.bias,
              marketInputs.higher,
              marketInputs.entry,
              walletStrategy,
              walletSignalModelId,
              marketInputs.marketContext,
              marketInputs.trigger,
            )
            return { symbol, analysis, error: null }
          } catch (error) {
            return { symbol, analysis: null, error: error instanceof Error ? error.message : String(error) }
          }
        })

        for (const { symbol, analysis, error } of batchResults) {
          if (error) {
            scanSkipped += 1
            pushWalletStep(`Skipped ${symbol}: market data unavailable (${error}).`, 'info', { symbol })
            continue
          }

          const patternNote = analysis && Array.isArray(analysis.patterns) && analysis.patterns.length > 0
            ? ` Patterns: ${analysis.patterns.map((pattern) => pattern.name).join(', ')} (${analysis.patternBias}).`
            : ''
          pushWalletStep(
            analysis
              ? `Found ${walletSignalModel.name} candidate on ${symbol}: ${analysis.direction} score ${analysis.score}/${analysis.maxScore} at ${analysis.entryPrice}.${patternNote}`
              : `No A-grade setup on ${symbol}.`,
            analysis ? 'pass' : 'info',
            analysis
              ? { symbol, direction: analysis.direction, score: analysis.score, patternBias: analysis.patternBias, patternScore: analysis.patternScore }
              : { symbol },
          )

          analyses.push(analysis)
        }
      }

      if (scanCancelled) {
        const result = await walletCancelled()
        setAutoTradeOutcome(result)
        return result
      }

      if (scanSkipped > 0) {
        pushWalletStep(`${scanSkipped} symbol${scanSkipped === 1 ? '' : 's'} skipped this wave due to upstream market-data errors.`, 'info')
      }

      const candidate = analyses
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || right.confidence - left.confidence)[0]

      if (!candidate) {
        pushWalletStep('No A-grade setup available after scanning preferred symbols.', 'blocked')
        await finishWallet({
          executed: false,
          reason: 'No A-grade setup available.',
          order: null,
        })
        continue
      }

      const candidateMarketInputs = await getSymbolInputs(candidate.symbol).catch(() => null)
      const candidateRangeCheck = evaluateCandidateRangeViability(candidate, candidateMarketInputs)
      if (!candidateRangeCheck.viable) {
        pushWalletStep(
          `Blocked ${candidate.symbol} because its ${candidateRangeCheck.rangeHours}h price range (${candidateRangeCheck.rangePercent.toFixed(3)}%) is smaller than its stop-loss distance (${candidateRangeCheck.slDistancePercent.toFixed(3)}%). This setup cannot realistically reach its brackets.`,
          'blocked',
          { symbol: candidate.symbol, rangePercent: candidateRangeCheck.rangePercent, slDistancePercent: candidateRangeCheck.slDistancePercent },
        )
        await finishWallet({
          executed: false,
          reason: `${candidate.symbol} recent price range is too small for its configured stop distance.`,
          order: null,
        })
        continue
      }

      const symbolInfo = findSymbolRules(exchangeInfo, candidate.symbol)
      if (!symbolInfo) {
        pushWalletStep(`Missing futures symbol rules for ${candidate.symbol}.`, 'blocked')
        await finishWallet({
          executed: false,
          reason: `No futures symbol rules found for ${candidate.symbol}.`,
          order: null,
        })
        continue
      }

      if (candidate.margin > 0 && candidate.margin > walletAccountSnapshot.availableBalance) {
        pushWalletStep(
          `Blocked ${candidate.symbol} because the required margin ${candidate.margin.toFixed(2)} USDT is above the available balance ${walletAccountSnapshot.availableBalance.toFixed(2)} USDT.`,
          'blocked',
          { symbol: candidate.symbol, requiredMargin: candidate.margin, availableBalance: walletAccountSnapshot.availableBalance },
        )
        await finishWallet({
          executed: false,
          reason: `The wallet cannot fund the ${walletSignalModel.name} position size.`,
          order: null,
        })
        continue
      }

      let quantity = 0
      try {
        quantity = buildFuturesQuantity(symbolInfo, candidate.positionNotional, candidate.entryPrice)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        pushWalletStep(
          `Blocked ${candidate.symbol} because the configured position size does not fit the exchange quantity rules: ${message}`,
          'blocked',
          {
            symbol: candidate.symbol,
            entryPrice: candidate.entryPrice,
            positionNotional: candidate.positionNotional,
          },
        )
        await finishWallet({
          executed: false,
          reason: `Configured position size is not tradable on ${candidate.symbol}. Reduce margin/leverage or remove the symbol from the preferred list.`,
          order: null,
        })
        continue
      }

      pushWalletStep(`Computed futures quantity ${quantity} for ${candidate.symbol}.`, 'pass', {
        symbol: candidate.symbol,
        direction: candidate.direction,
        score: candidate.score,
      })

      const candidateRiskAmount = getTradeRiskAmount({
        side: candidate.side,
        stopLoss: candidate.stopLoss,
        entryPrice: candidate.entryPrice,
        notional: candidate.positionNotional,
        maxLossPerTrade: candidate.maxLossPerTrade ?? walletStrategy.maxLossPerTrade,
        configuredStopLossPercent: candidate.configuredStopLossPercent ?? walletStrategy.stopLossPercent,
      }, walletStrategy)

      if (walletToday.realizedLoss + reservedOpenRisk + candidateRiskAmount > walletStrategy.maxLossPerDay) {
        pushWalletStep(
          `Blocked ${candidate.symbol} because reserved daily risk would rise to ${(walletToday.realizedLoss + reservedOpenRisk + candidateRiskAmount).toFixed(2)} USDT.`,
          'blocked',
          { symbol: candidate.symbol, reservedRisk: reservedOpenRisk, candidateRisk: candidateRiskAmount },
        )
        await finishWallet({
          executed: false,
          reason: 'Daily max loss budget would be exceeded by the next trade.',
          order: null,
        })
        continue
      }

      if (autoTradeRuntime.cancelRequested) {
        const result = await walletCancelled()
        setAutoTradeOutcome(result)
        return result
      }

      const learningBotConfig = normalizeLearningBotSettings(settings.learningBot)
      const candidateAiOverride = learningBotConfig.perBotOverrides?.[ensureSignalModelId(candidate.signalModelId)] || null
      const aiFilterEnabled = Boolean(candidateAiOverride?.enabled || learningBotConfig.aiEntryFilter.enabled)
      const aiFilterPaperOnly = candidateAiOverride?.paperOnly ?? learningBotConfig.aiEntryFilter.paperOnly
      const learningBotTrainStatus = aiFilterEnabled
        ? await getLearningBotTrainStatus().catch(() => null)
        : null
      const aiFilterDecision = aiFilterEnabled
        ? scoreCandidateWithAiFilter(candidate, learningBotTrainStatus, learningBotConfig)
        : null

      if (aiFilterDecision) {
        const patternScoreValue = Number(candidate.patternScore || 0)
        const patternNudge = applyPatternAiNudge(aiFilterDecision, patternScoreValue)
        if (patternNudge.delta !== 0) {
          pushWalletStep(
            `Chart patterns (${candidate.patternBias || 'neutral'}) ${patternNudge.delta > 0 ? 'added' : 'removed'} ${Math.abs(patternNudge.delta)} to the AI score: ${aiFilterDecision.finalScore} -> ${patternNudge.finalScore}/${aiFilterDecision.thresholdScore}${patternNudge.flipped ? ` (${patternNudge.accept ? 'now clears' : 'now below'} the threshold)` : ''}.`,
            'info',
            { symbol: candidate.symbol, patternScore: Number(patternScoreValue.toFixed(3)), patternDelta: patternNudge.delta },
          )
        }
        aiFilterDecision.baseFinalScore = aiFilterDecision.finalScore
        aiFilterDecision.finalScore = patternNudge.finalScore
        aiFilterDecision.accept = patternNudge.accept
        aiFilterDecision.patternScore = Number(patternScoreValue.toFixed(3))
        aiFilterDecision.patternScoreDelta = patternNudge.delta

        pushWalletStep(
          `AI filter scored ${candidate.symbol} ${aiFilterDecision.finalScore}/100 for ${aiFilterDecision.setupFamily} using ${aiFilterDecision.policySource} policy (threshold ${aiFilterDecision.thresholdScore}).`,
          aiFilterDecision.accept ? 'pass' : 'blocked',
          {
            symbol: candidate.symbol,
            direction: candidate.direction,
            score: aiFilterDecision.finalScore,
          },
        )
        pushWalletStep(
          `AI mode for ${getSignalModelName(aiFilterDecision.signalModelId)} is ${aiFilterPaperOnly ? 'paper-only' : 'hard-block'} with threshold ${aiFilterDecision.thresholdScore}.`,
          'info',
        )

        if (aiFilterDecision.bootstrapAccept) {
          pushWalletStep(
            `${getSignalModelName(aiFilterDecision.signalModelId)} has no self-trained AI policy yet, so this trade is allowed through to grow the learning dataset (bootstrap mode).`,
            'info',
          )
        }

        if (aiFilterPaperOnly) {
          // Advisory only: record the AI verdict but let the rule-based trade proceed on
          // every wallet (local-paper or exchange-sync). Only hard-block mode
          // (perBotOverride.paperOnly === false) can actually veto an entry.
          pushWalletStep(
            `Paper-only AI filter would ${aiFilterDecision.accept ? 'accept' : 'skip'} ${candidate.symbol} at ${aiFilterDecision.finalScore}/${aiFilterDecision.thresholdScore}; advisory only, the rule-based trade proceeds.`,
            'info',
          )
        } else if (!aiFilterDecision.accept) {
          await finishWallet({
            executed: false,
            reason: `AI filter skipped ${candidate.symbol} with score ${aiFilterDecision.finalScore}/${aiFilterDecision.thresholdScore}.`,
            order: null,
          })
          continue
        }
      }

      try {
        const tradeResult = await recordTrade({
          symbol: candidate.symbol,
          side: candidate.side,
          quantity,
          symbolInfo,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
          entryPrice: candidate.entryPrice,
          notional: candidate.positionNotional,
          margin: candidate.margin ?? walletStrategy.marginPerTrade,
          marginMode: walletStrategy.marginMode,
          leverage: candidate.leverage ?? walletStrategy.leverage,
          configuredStopLossPercent: candidate.configuredStopLossPercent ?? walletStrategy.stopLossPercent,
          source: 'AUTO',
          signalSummary: candidate.summary,
          signalModelId: candidate.signalModelId,
          signalModelName: candidate.signalModelName,
          aiDecision: aiFilterDecision ? {
            finalScore: aiFilterDecision.finalScore,
            baseFinalScore: aiFilterDecision.baseFinalScore ?? aiFilterDecision.finalScore,
            thresholdScore: aiFilterDecision.thresholdScore,
            setupFamily: aiFilterDecision.setupFamily,
            policySource: aiFilterDecision.policySource,
            entryQualityScore: aiFilterDecision.entryQualityScore,
            accept: aiFilterDecision.accept,
            patternScore: aiFilterDecision.patternScore ?? Number(candidate.patternScore || 0),
            patternScoreDelta: aiFilterDecision.patternScoreDelta ?? 0,
            patternBias: candidate.patternBias || 'neutral',
          } : null,
          walletId: resolvedWallet.id,
          walletName: resolvedWallet.name,
        })

        pushWalletStep(`Recorded ${candidate.direction} order for ${candidate.symbol} and sent it for execution.`, 'pass', {
          symbol: candidate.symbol,
          direction: candidate.direction,
          score: candidate.score,
        })

        await finishWallet({
          executed: true,
          reason: tradeResult.message,
          order: tradeResult.order,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        pushWalletStep(`Blocked ${candidate.symbol} because execution could not be confirmed on Binance Testnet: ${message}`, 'blocked', {
          symbol: candidate.symbol,
          direction: candidate.direction,
          score: candidate.score,
        })
        await finishWallet({
          executed: false,
          reason: message,
          order: null,
        })
      }
    }

    const executedOrders = walletResults
      .filter((walletResult) => walletResult.executed && walletResult.order)
      .map((walletResult) => walletResult.order)
    const idleWalletCount = walletResults.length - executedOrders.length
    const output = {
      executed: executedOrders.length > 0,
      reason: executedOrders.length > 0
        ? idleWalletCount > 0
          ? `Executed ${executedOrders.length} wallet trade${executedOrders.length === 1 ? '' : 's'}; ${idleWalletCount} wallet${idleWalletCount === 1 ? '' : 's'} did not place a trade.`
          : `Executed ${executedOrders.length} wallet trade${executedOrders.length === 1 ? '' : 's'}.`
        : 'No enabled wallet found a qualifying setup.',
      order: executedOrders[0] || null,
      orders: executedOrders,
      walletResults,
      steps: runSteps,
      runId,
    }

    setAutoTradeOutcome(output)
    return output
  } finally {
    setAutoTradeRunningState(false, null)
  }
}

app.get('/api/health', async (_request, response) => {
  const settings = await getSettings()
  const { apiKey, secretKey } = getEffectiveCredentials(settings)
  response.json({
    ok: true,
    mode: apiKey && secretKey ? 'binance-futures-testnet' : 'local-paper',
    runtimeProfile: getRuntimeProfile(),
    marketData: getMarketDataHealthSnapshot(),
  })
})

app.get('/api/market-data-health', async (_request, response) => {
  response.json({
    ok: true,
    marketData: getMarketDataHealthSnapshot(),
  })
})

app.get('/api/settings', async (_request, response) => {
  const settings = await syncPreferredSymbolsWithVolatility(await getSettings())
  response.json(sanitizeSettingsForClient(settings))
})

app.put('/api/settings', async (request, response) => {
  const currentSettings = await getSettings()
  const learningBotTrainStatus = await getLearningBotTrainStatus().catch(() => defaultLearningBotTrainStatus)
  const requestedSettingsRevision = Number(request.body?.settingsRevision || 0)
  const currentSettingsRevision = Number(currentSettings.settingsRevision || defaultSettings.settingsRevision)
  const requestMeta = {
    ...summarizeSettingsSaveRequestBody(request.body),
    requestedSettingsRevision,
    currentSettingsRevision,
    ip: request.ip || request.socket?.remoteAddress || null,
    userAgent: request.get('user-agent') || null,
  }

  if (!Number.isSafeInteger(requestedSettingsRevision) || requestedSettingsRevision !== currentSettingsRevision) {
    await appendSettingsAuditLog({
      trigger: 'SETTINGS_SAVE_REJECTED',
      source: 'api.settings.put',
      note: 'Rejected stale settings save due to revision mismatch.',
      beforeSettings: currentSettings,
      afterSettings: currentSettings,
      requestMeta,
      writeMeta: {
        reason: 'revision-mismatch',
      },
    })
    logTerminalLine(
      'BLOCK',
      `Rejected stale settings save. Client revision ${requestedSettingsRevision || 'missing'} does not match current revision ${currentSettingsRevision}.`,
      'warning',
    )
    response.status(409).json({
      error: 'Settings changed since this page loaded. Refresh the app, then try saving again.',
      currentSettingsRevision,
    })
    return
  }

  if (learningBotTrainStatus.running && request.body?.strategy) {
    response.status(409).json({
      error: 'Bot strategy settings are locked while AI training is running. Wait for training to finish before editing them.',
      currentSettingsRevision,
    })
    return
  }

  const nextSettings = mergeSettingsUpdate(currentSettings, request.body)
  const savedSettings = await saveSettings(nextSettings, {
    incrementRevision: true,
    currentSettings,
    audit: {
      trigger: 'SETTINGS_SAVE',
      source: 'api.settings.put',
      note: 'Accepted settings save request from the API.',
      requestMeta,
    },
  })
  let hydratedSettings = await syncPreferredSymbolsWithVolatility(savedSettings)
  const syncedWallet = getPrimaryExchangeSyncedWallet(hydratedSettings.wallets)

  if (syncedWallet) {
    const syncResult = await syncExchangeWalletBalance({
      settings: hydratedSettings,
      walletId: syncedWallet.id,
      suppressErrors: true,
    })
    hydratedSettings = await syncPreferredSymbolsWithVolatility(syncResult.settings)
  }

  await persistBotSettingsLog({
    trigger: 'SETTINGS_SAVE',
    note: 'Captured after saving settings.',
    settings: hydratedSettings,
  }).catch((error) => {
    console.error('Failed to persist bot settings log after saving settings:', error)
  })

  maybeRefreshLearningBotPolicy('SETTINGS_SAVE', hydratedSettings).catch((error) => {
    console.error('Failed to auto-refresh AI policy after settings save:', error)
  })

  response.json(sanitizeSettingsForClient(hydratedSettings))
})

app.post('/api/wallets/:walletId/sync', async (request, response) => {
  const walletId = String(request.params.walletId || '').trim()

  if (!walletId) {
    response.status(400).json({ error: 'walletId is required' })
    return
  }

  try {
    const settings = await getSettings()
    const wallet = getWalletById(walletId, settings.wallets)

    if (!wallet) {
      response.status(404).json({ error: 'Wallet not found' })
      return
    }

    if (!isExchangeSyncWallet(wallet)) {
      response.status(409).json({
        error: 'Only a Phase 2 exchange-sync wallet can be synced with Binance Futures Testnet.',
      })
      return
    }

    const syncResult = await syncExchangeWalletBalance({
      settings,
      walletId,
      suppressErrors: false,
    })
    const hydratedSettings = await syncPreferredSymbolsWithVolatility(syncResult.settings)

    response.json({
      ok: true,
      wallet: getWalletById(walletId, hydratedSettings.wallets),
      settings: sanitizeSettingsForClient(hydratedSettings),
      syncedAt: Date.now(),
    })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Wallet sync request failed',
    })
  }
})

app.get('/api/volatile-markets', async (_request, response) => {
  try {
    const exchangeInfo = await fetchFuturesExchangeInfo()
    const items = await getVolatileMarketsSnapshot({ limit: VOLATILE_SYMBOL_LIMIT, exchangeInfo })
    const settings = await syncPreferredSymbolsWithVolatility(await getSettings(), exchangeInfo)

    response.json({
      ok: true,
      items,
      preferredSymbols: settings.strategy.preferredSymbols,
    })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to load volatile markets',
    })
  }
})

app.get('/api/signal-model-analysis', async (request, response) => {
  try {
    const settings = await getSettings()
    const symbol = String(request.query.symbol || '').toUpperCase()
    const signalModelId = ensureSignalModelId(request.query.modelId || settings.strategy.activeSignalModelId)

    if (!symbol) {
      response.status(400).json({ error: 'symbol is required' })
      return
    }

    const wallets = normalizeWallets(settings.wallets)
    const analysisWallet = wallets.find((wallet) => wallet.assignedSignalModelId === signalModelId) || null
    const analysisHistory = analysisWallet ? await getTradeHistory() : []
    const analysisWalletTrades = analysisWallet
      ? analysisHistory.filter((trade) => trade.walletId === analysisWallet.id)
      : []
    const baseAnalysisSnapshot = analysisWallet
      ? summarizeAccount({
        trades: analysisWalletTrades,
        livePrices: {},
        strategy: settings.strategy,
        startingBalance: getWalletEffectiveStartingBalance(analysisWallet),
      })
      : null
    const analysisStrategy = getEffectiveSignalModelStrategy(settings.strategy, signalModelId, {
      runningBalance: baseAnalysisSnapshot?.runningBalance,
    })

    const [bias, setup, entry, trigger, marketContext] = await Promise.all([
      fetchKlines(symbol, '1h', 120),
      fetchKlines(symbol, '15m', 120),
      fetchKlines(symbol, '5m', 120),
      fetchKlines(symbol, '1m', 180),
      fetchSignalMarketContext(symbol),
    ])

    const analysis = buildSignalAnalysisSnapshot(
      symbol,
      toCandleData(bias),
      toCandleData(setup),
      toCandleData(entry),
      analysisStrategy,
      signalModelId,
      marketContext,
      toCandleData(trigger),
    )
    const learningBotTrainStatus = await getLearningBotTrainStatus().catch(() => null)
    const aiAdvisory = buildSignalAnalysisAiAdvisory(
      analysis,
      analysisStrategy,
      settings.learningBot,
      learningBotTrainStatus,
    )

    response.json({
      ok: true,
      analysis: {
        ...analysis,
        aiAdvisory,
      },
    })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to evaluate signal model analysis',
    })
  }
})

app.get('/api/trade-history', async (_request, response) => {
  const items = await getTradeHistory()
  response.json({
    ok: true,
    items,
  })
})

app.get('/api/learning-bot/summary', async (_request, response) => {
  try {
    const settings = await getSettings()
    const config = normalizeLearningBotSettings(settings.learningBot)
    const { dataset, source, eligibleClosedTradeCount, realMoneyTradeTarget, realMoneyTradeReady } = await refreshLearningBotDatasetArtifact(config)
    const summary = buildLearningBotSummary(dataset, config)

    response.json({
      ok: true,
      config,
      source,
      eligibleClosedTradeCount,
      realMoneyTradeTarget,
      realMoneyTradeReady,
      realMoneyTradesRemaining: Math.max(realMoneyTradeTarget - eligibleClosedTradeCount, 0),
      ...summary,
      overview: {
        ...summary.overview,
        eligibleClosedTradeCount,
        realMoneyTradeTarget,
        realMoneyTradeReady,
        realMoneyTradesRemaining: Math.max(realMoneyTradeTarget - eligibleClosedTradeCount, 0),
      },
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to build learning bot summary',
    })
  }
})

app.get('/api/learning-bot/dataset', async (_request, response) => {
  try {
    const settings = await getSettings()
    const config = normalizeLearningBotSettings(settings.learningBot)
    const { artifact, source, eligibleClosedTradeCount, realMoneyTradeTarget, realMoneyTradeReady } = await refreshLearningBotDatasetArtifact(config)

    // The full dataset can be ~117k rows / ~90 MB. The UI only needs the count
    // plus a small preview, and this endpoint is polled every 20 s, so cap it.
    const allRows = Array.isArray(artifact?.rows) ? artifact.rows : []
    response.json({
      ok: true,
      source,
      eligibleClosedTradeCount,
      realMoneyTradeTarget,
      realMoneyTradeReady,
      realMoneyTradesRemaining: Math.max(realMoneyTradeTarget - eligibleClosedTradeCount, 0),
      generatedAt: artifact?.generatedAt || null,
      config: artifact?.config || null,
      rowCount: allRows.length,
      rows: allRows.slice(0, 200),
      truncated: allRows.length > 200,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to export learning dataset',
    })
  }
})

app.get('/api/learning-bot/train-status', async (_request, response) => {
  try {
    const settings = await getSettings()
    const config = normalizeLearningBotSettings(settings.learningBot)
    const datasetSnapshot = await refreshLearningBotDatasetArtifact(config)
    const status = hydrateLearningBotTrainStatus(await getLearningBotTrainStatus(), datasetSnapshot)
    response.json({
      ok: true,
      status,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load training status',
    })
  }
})

app.post('/api/learning-bot/train', async (_request, response) => {
  try {
    const settings = await getSettings()
    const config = normalizeLearningBotSettings(settings.learningBot)

    if (!config.aiTrainer.enabled) {
      response.status(409).json({
        error: 'Enable AI Trainer in Learning Bot settings before starting a training run.',
      })
      return
    }

    const { dataset } = await refreshLearningBotDatasetArtifact(config)

    if (dataset.length < config.minClosedTradesForInsights) {
      response.status(409).json({
        error: `At least ${config.minClosedTradesForInsights} closed trades are required before AI training can start.`,
      })
      return
    }

    const result = await launchLearningBotTraining({ config, dataset })
    response.json(result)
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to start learning bot training',
    })
  }
})

function formatEtaText(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return null
  if (s < 90) return `~${Math.round(s)}s left`
  const mins = Math.round(s / 60)
  if (mins < 90) return `~${mins} min left`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `~${hrs}h ${rem}m left` : `~${hrs}h left`
}

app.get('/api/learning-bot/backtests', async (_request, response) => {
  try {
    const registry = await getBacktestRunRegistry()
    const runs = registry.map((run) => ({
      ...run,
      etaText: run?.status === 'running' ? formatEtaText(run?.progress?.etaSeconds) : null,
    }))
    response.json({ ok: true, runs })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load backtest runs',
    })
  }
})

app.patch('/api/learning-bot/backtests/:id', async (request, response) => {
  try {
    const id = String(request.params.id || '').trim()
    const registry = await getBacktestRunRegistry()
    const idx = registry.findIndex((run) => run && run.id === id)
    if (idx < 0) {
      response.status(404).json({ error: `No backtest run with id "${id}".` })
      return
    }
    const patch = request.body && typeof request.body === 'object' ? request.body : {}
    const next = { ...registry[idx] }
    if (typeof patch.includeInTraining === 'boolean') next.includeInTraining = patch.includeInTraining
    if (typeof patch.conclusion === 'string') next.conclusion = patch.conclusion
    if (typeof patch.label === 'string' && patch.label.trim()) next.label = patch.label.trim()
    next.updatedAt = Date.now()
    registry[idx] = next
    await writeBacktestRunRegistry(registry)
    response.json({ ok: true, run: next })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to update backtest run',
    })
  }
})

app.get('/api/learning-bot/backtests/:id/report', async (request, response) => {
  try {
    const id = String(request.params.id || '').trim().replace(/[^A-Za-z0-9._-]/g, '-')
    const file = path.join(backtestRunsMdDir, `${id}.md`)
    let markdown = ''
    try {
      markdown = await fs.readFile(file, 'utf8')
    } catch {
      markdown = ''
    }
    response.json({ ok: true, markdown })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load backtest report',
    })
  }
})

app.get('/api/learning-bot/signal-insights', async (_request, response) => {
  try {
    const artifact = await readJson(learningBotTrainArtifactFilePath, null)
    const metrics = artifact?.metrics || null
    const bySignalModel = metrics?.policy?.bySignalModel || {}
    const classify = (winRate, avgReward) => {
      if (avgReward > 0 && winRate >= 45) return 'works'
      if (avgReward >= -1) return 'marginal'
      return 'losing'
    }
    const bots = Object.entries(bySignalModel).map(([modelId, node]) => {
      const families = Object.entries(node?.setupFamilyScores || {})
        .map(([family, item]) => ({
          family,
          count: Number(item?.count || 0),
          winRate: Number(item?.winRate || 0),
          avgReward: Number(item?.avgReward || 0),
          avgEntryQuality: Number(item?.avgEntryQuality || 0),
          verdict: classify(Number(item?.winRate || 0), Number(item?.avgReward || 0)),
        }))
        .sort((a, b) => b.count - a.count)
      return { modelId, families }
    })
    response.json({
      ok: true,
      generatedAt: artifact?.generatedAt || metrics?.generatedAt || null,
      rows: Number(metrics?.rows || 0),
      framework: metrics?.framework || null,
      actionAlignment: Number(metrics?.actionAlignment || 0),
      bots,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to build signal insights',
    })
  }
})

app.post('/api/dashboard-trade-review', async (request, response) => {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()

  if (!apiKey) {
    response.status(409).json({
      error: 'OPENAI_API_KEY is required before ChatGPT can review dashboard trades.',
    })
    return
  }

  try {
    const prompt = buildDashboardTradeReviewPrompt(request.body || {})
    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: dashboardTradeReviewModel,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: 'You are reviewing a manual crypto futures trade on a dashboard. Stay skeptical. Only approve when the setup is strong enough for immediate manual execution. Return strict JSON only.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: prompt,
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'dashboard_trade_review',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                verdict: { type: 'string', enum: ['positive', 'negative'] },
                shouldManualTrade: { type: 'boolean' },
                direction: { type: 'string', enum: ['LONG', 'SHORT', 'WAIT'] },
                summary: { type: 'string' },
                confidence: { type: 'integer', minimum: 0, maximum: 100 },
                reasoning: {
                  type: 'array',
                  items: { type: 'string' },
                  maxItems: 5,
                },
                suggestedEntryPrice: { type: ['number', 'null'] },
                suggestedTakeProfitPrice: { type: ['number', 'null'] },
                suggestedStopLossPrice: { type: ['number', 'null'] },
                earlierExitPrice: { type: ['number', 'null'] },
              },
              required: [
                'verdict',
                'shouldManualTrade',
                'direction',
                'summary',
                'confidence',
                'reasoning',
                'suggestedEntryPrice',
                'suggestedTakeProfitPrice',
                'suggestedStopLossPrice',
                'earlierExitPrice',
              ],
            },
          },
        },
      }),
    })
    const responseText = await openAiResponse.text()
    let responsePayload = {}

    if (responseText) {
      try {
        responsePayload = JSON.parse(responseText)
      } catch {
        responsePayload = { raw: responseText }
      }
    }

    if (!openAiResponse.ok) {
      response.status(502).json({
        error: responsePayload?.error?.message || 'ChatGPT trade review request failed.',
      })
      return
    }

    const review = extractStructuredResponsePayload(responsePayload)
    const normalizeNumber = (value) => {
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }
    const normalizedReview = {
      verdict: review.verdict === 'positive' && review.shouldManualTrade ? 'positive' : 'negative',
      shouldManualTrade: Boolean(review.verdict === 'positive' && review.shouldManualTrade),
      direction: review.direction === 'LONG' || review.direction === 'SHORT' ? review.direction : 'WAIT',
      summary: String(review.summary || '').trim() || 'No summary returned.',
      confidence: Math.max(0, Math.min(100, Number(review.confidence || 0))),
      reasoning: Array.isArray(review.reasoning) ? review.reasoning.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5) : [],
      suggestedEntryPrice: normalizeNumber(review.suggestedEntryPrice),
      suggestedTakeProfitPrice: normalizeNumber(review.suggestedTakeProfitPrice),
      suggestedStopLossPrice: normalizeNumber(review.suggestedStopLossPrice),
      earlierExitPrice: normalizeNumber(review.earlierExitPrice),
      reviewedAt: Date.now(),
      model: dashboardTradeReviewModel,
    }

    response.json({
      ok: true,
      review: normalizedReview,
    })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to review the dashboard trade with ChatGPT.',
    })
  }
})

app.post('/api/trade-history/:tradeId/manual-close', async (request, response) => {
  const tradeId = String(request.params.tradeId || '').trim()

  if (!tradeId) {
    response.status(400).json({ error: 'tradeId is required' })
    return
  }

  try {
    let settings = await getSettings()
    const history = await getTradeHistory()
    const tradeIndex = history.findIndex((trade) => trade.id === tradeId)

    if (tradeIndex === -1) {
      response.status(404).json({ error: 'Trade not found' })
      return
    }

    const trade = history[tradeIndex]

    if (trade.status !== 'OPEN') {
      response.status(409).json({
        error: 'Trade is already closed.',
        trade,
        items: history,
      })
      return
    }

    let updatedTrade

    if (isBinanceTestnetTrade(trade)) {
      const { apiKey, secretKey } = getEffectiveCredentials(settings)

      if (!apiKey || !secretKey) {
        response.status(409).json({
          error: 'Binance Futures Testnet API key and secret are required to manually close a Phase 2 trade.',
        })
        return
      }

      const accountSnapshot = await fetchBinanceAccountSnapshot({ apiKey, secretKey })
      const openPositionAmount = Math.abs(getExchangePositionAmount(accountSnapshot, trade.symbol))

      await cancelProtectiveOrdersForTrade(trade, { apiKey, secretKey })

      let closeResult = null
      if (openPositionAmount > 1e-8) {
        closeResult = await closeExchangePositionImmediately({
          symbol: trade.symbol,
          side: trade.side,
          quantity: openPositionAmount,
          apiKey,
          secretKey,
        })
      }

      const reconciledFill = await resolveExchangeClosePriceFromUserTrades(trade, { apiKey, secretKey }).catch(() => null)
      let exitPrice = Number(closeResult?.exitPrice || reconciledFill?.exitPrice || 0)

      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        const ticker = await fetchTickerPrice(trade.symbol)
        exitPrice = Number(ticker?.price || 0)
      }

      updatedTrade = closeTradeRecord({
        trade,
        exitPrice,
        status: 'CLOSED_MANUAL',
        result: 'MANUAL',
        closedAt: Number(closeResult?.closedAt || reconciledFill?.closedAt || Date.now()),
      })
    } else {
      const ticker = await fetchTickerPrice(trade.symbol)
      updatedTrade = closeTradeRecord({
        trade,
        exitPrice: Number(ticker?.price || 0),
        status: 'CLOSED_MANUAL',
        result: 'MANUAL',
      })
    }

    const items = history.map((item, index) => (index === tradeIndex ? updatedTrade : item))

    await saveTradeHistory(items)
    await maybeRefreshLearningBotPolicy('MANUAL_CLOSE', settings)
    await persistBotSettingsLog({
      trigger: 'MANUAL_CLOSE',
      note: `Captured after manually closing ${trade.symbol} ${trade.side}.`,
      settings,
      history: items,
    }).catch((error) => {
      console.error('Failed to persist bot settings log after manual close:', error)
    })
    logTradeClosedToTerminal(trade, updatedTrade)
    if (trade.walletId) {
      const wallet = getWalletById(trade.walletId, settings.wallets)
      if (wallet && isExchangeSyncWallet(wallet)) {
        const syncResult = await syncExchangeWalletBalance({
          settings,
          walletId: wallet.id,
          suppressErrors: true,
        })
        settings = syncResult.settings
      }
    }

    response.json({
      ok: true,
      trade: updatedTrade,
      items,
      settings,
    })
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Manual close request failed',
    })
  }
})

app.post('/api/mock-order', async (request, response) => {
  const {
    symbol,
    side,
    quantity,
    stopLoss,
    takeProfit,
    entryPrice,
    notional,
    margin,
    leverage,
    source,
    signalSummary,
    signalModelId,
    signalModelName,
    aiReview,
    walletId,
    configuredStopLossPercent,
  } = request.body

  if (!symbol || !side || !quantity || !entryPrice || !notional) {
    response.status(400).json({ error: 'symbol, side, quantity, entryPrice, and notional are required' })
    return
  }

  try {
    const settings = await getSettings()
    const exchangeInfo = await fetchFuturesExchangeInfo()
    const symbolInfo = findSymbolRules(exchangeInfo, symbol)

    if (!symbolInfo) {
      response.status(400).json({ error: `No futures symbol rules found for ${symbol}` })
      return
    }

    const normalizedQuantity = buildFuturesQuantity(symbolInfo, Number(notional), Number(entryPrice))

    const result = await recordTrade({
      symbol,
      side,
      quantity: normalizedQuantity,
      symbolInfo,
      stopLoss: Number(stopLoss),
      takeProfit: Number(takeProfit),
      entryPrice: Number(entryPrice),
      notional: Number(notional),
      margin: Number(margin || defaultSettings.strategy.marginPerTrade),
      marginMode: normalizeMarginMode((request.body || {}).marginMode || settings.strategy.marginMode || defaultSettings.strategy.marginMode),
      leverage: Number(leverage || defaultSettings.strategy.leverage),
      configuredStopLossPercent: configuredStopLossPercent == null ? undefined : Number(configuredStopLossPercent),
      source: source || 'MANUAL',
      signalSummary: signalSummary || '',
      signalModelId: signalModelId || null,
      signalModelName: signalModelName || null,
      aiReview: aiReview || null,
      walletId: walletId || null,
    })

    response.json(result)
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : 'Mock order request failed',
    })
  }
})

app.get('/api/journal-summary', async (_request, response) => {
  const settings = await getSettings()
  const wallets = normalizeWallets(settings.wallets)
  const history = (await getTradeHistory()).filter((trade) => isAutoTradeSource(trade.source))
  const items = buildJournalItems(history)
  const walletItems = getTradingWallets(wallets).map((wallet) => {
    const walletTrades = history.filter((trade) => trade.walletId === wallet.id)
    const walletJournalItems = buildJournalItems(walletTrades)

    return {
      walletId: wallet.id,
      walletName: wallet.name,
      walletColorKey: wallet.colorKey,
      assignedSignalModelId: wallet.assignedSignalModelId,
      assignedSignalModelName: wallet.assignedSignalModelName || getSignalModelName(wallet.assignedSignalModelId),
      items: walletJournalItems,
      summary: buildJournalSummary(walletTrades, walletJournalItems),
    }
  })
  const availableMonths = Array.from(new Set(
    walletItems.flatMap((wallet) => wallet.items.map((item) => String(item.date).slice(0, 7))),
  )).sort((left, right) => right.localeCompare(left))

  response.json({
    ok: true,
    items,
    wallets: walletItems,
    availableMonths,
  })
})

app.get('/api/auto-trade-status', async (_request, response) => {
  const settings = await syncPreferredSymbolsWithVolatility(await getSettings())
  const history = await getTradeHistory()
  const wallets = normalizeWallets(settings.wallets)
  response.json({
    enabled: settings.strategy.autoTradingEnabled,
    today: summarizeToday(history, manilaDateKey()),
    wallets: getTradingWallets(wallets).map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      enabled: wallet.enabled,
      assignedSignalModelId: wallet.assignedSignalModelId,
      assignedSignalModelName: wallet.assignedSignalModelName,
    })),
    running: autoTradeRuntime.running,
    currentRunId: autoTradeRuntime.currentRunId,
    lastRunAt: autoTradeRuntime.lastRunAt,
    lastReason: autoTradeRuntime.lastReason,
    lastExecuted: autoTradeRuntime.lastExecuted,
  })
})

app.get('/api/auto-trade-log', async (_request, response) => {
  const items = await getAutoTradeLog()
  response.json({
    ok: true,
    items,
  })
})

app.get('/api/bot-settings-log', async (_request, response) => {
  const items = await getBotSettingsLog()
  response.json({
    ok: true,
    items,
  })
})

app.get('/api/settings-audit-log', async (_request, response) => {
  const items = await getSettingsAuditLog()
  response.json({
    ok: true,
    items,
  })
})

app.get('/api/workflow-readiness', async (_request, response) => {
  const [settings, history, autoTradeLog, learningBotTrainStatus, backtestRuns] = await Promise.all([
    syncPreferredSymbolsWithVolatility(await getSettings()),
    getTradeHistory(),
    getAutoTradeLog(),
    getLearningBotTrainStatus(),
    getBacktestRunRegistry().catch(() => []),
  ])
  const snapshot = evaluateWorkflowReadiness(settings, history, autoTradeLog, learningBotTrainStatus, backtestRuns)
  const reviewLog = await persistWorkflowReview(snapshot)

  response.json({
    ok: true,
    currentPhase: snapshot.currentPhase,
    summary: snapshot.summary,
    trackedSymbols: snapshot.trackedSymbols,
    validatedSymbols: snapshot.validatedSymbols,
    notifications: snapshot.notifications,
    operations: snapshot.operations,
    phases: snapshot.phases,
    reviewLog,
  })
})

app.get('/api/codex-console/status', async (_request, response) => {
  try {
    const status = await getCodexConsoleStatus()
    response.json({ ok: true, ...status })
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to read Codex console status.',
    })
  }
})

app.post('/api/codex-console/message', async (request, response) => {
  const { message, threadId } = request.body || {}

  try {
    const result = await runCodexConsoleTurn({ message, threadId })
    response.json({ ok: true, ...result })
  } catch (error) {
    const statusCode = error && error.statusCode ? error.statusCode : 500
    response.status(statusCode).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Codex console request failed.',
    })
  }
})

app.get('/api/auto-trade-events', (request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  response.write(`event: state\ndata: ${JSON.stringify({
    running: autoTradeRuntime.running,
    currentRunId: autoTradeRuntime.currentRunId,
    cancelRequested: autoTradeRuntime.cancelRequested,
    lastRunAt: autoTradeRuntime.lastRunAt,
    lastReason: autoTradeRuntime.lastReason,
    lastExecuted: autoTradeRuntime.lastExecuted,
  })}\n\n`)

  autoTradeClients.add(response)

  request.on('close', () => {
    autoTradeClients.delete(response)
  })
})

app.post('/api/auto-trade/run', async (_request, response) => {
  try {
    const result = await runAutoTrader('MANUAL')
    response.json(result)
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Auto trader failed',
    })
  }
})

app.post('/api/auto-trade/stop', async (_request, response) => {
  if (!autoTradeRuntime.running) {
    response.json({
      ok: true,
      running: false,
      message: 'No active auto-trade run.',
    })
    return
  }

  autoTradeRuntime.cancelRequested = true
  broadcastAutoTradeEvent('state', {
    running: true,
    currentRunId: autoTradeRuntime.currentRunId,
    cancelRequested: true,
  })
  response.json({
    ok: true,
    running: true,
    message: 'Stop requested. Current run will halt at the next safe checkpoint.',
  })
})

registerConsolidatedBot(app, {
  dataDir, fetchKlines, toCandleData, buildSignalAnalysisSnapshot, getSettings,
  autostart: IS_MAIN_MODULE,
})

if (shouldServeBuiltFrontend) {
  app.use(express.static(distDir))

  app.get(/^\/(?!api(?:\/|$)|healthz(?:\/|$)).*/, (_request, response) => {
    response.sendFile(distIndexFilePath, (error) => {
      if (!error || response.headersSent) {
        return
      }

      response.status(error.statusCode || 500).json({
        error: 'Built frontend not found. Run `npm run build` before starting the production server.',
      })
    })
  })
}

if (IS_MAIN_MODULE) {
setInterval(() => {
  updateOpenTrades().catch((error) => {
    console.error('Failed to update open trades:', error)
  })
}, 10_000)

setInterval(() => {
  runAutoTrader('SCHEDULED').catch((error) => {
    console.error('Failed to run auto trader:', error)
  })
}, 5 * 60_000)

setInterval(() => {
  auditObservedSettingsFileChange().catch((error) => {
    console.error('Failed to audit settings file changes:', error)
  })
}, SETTINGS_FILE_AUDIT_INTERVAL_MS)

setTimeout(() => {
  runAutoTrader('SCHEDULED').catch((error) => {
    console.error('Initial auto trader check failed:', error)
  })
}, 10_000)

app.listen(port, host, async () => {
  let startupSettings = await getSettings().catch(() => defaultSettings)
  const learningBotTrainStatus = await getLearningBotTrainStatus().catch(() => defaultLearningBotTrainStatus)
  const recoveryResult = await selfHealSettingsIfNeeded(startupSettings, {
    source: 'app.listen',
    note: 'Validated startup settings against the armed recovery snapshot.',
  }).catch((error) => {
    console.error('Failed to self-heal settings on startup:', error)
    return {
      settings: startupSettings,
      healed: false,
    }
  })
  startupSettings = recoveryResult.settings
  syncObservedSettingsAuditState(startupSettings)
  persistSettingsRecoverySnapshot(startupSettings, {
    source: 'app.listen',
    note: 'Captured armed settings recovery snapshot on server startup.',
  }).catch((error) => {
    console.error('Failed to persist settings recovery snapshot on startup:', error)
  })
  appendSettingsAuditLog({
    trigger: 'SETTINGS_AUDIT_STARTUP',
    source: 'app.listen',
    note: 'Initialized settings audit monitoring on server startup.',
    beforeSettings: startupSettings,
    afterSettings: startupSettings,
    writeMeta: {
      observedHash: lastObservedSettingsFileHash,
    },
  }).catch((error) => {
    console.error('Failed to append settings audit startup log:', error)
  })
  logTerminalBlock(
    'XeniosTrade Server Ready',
    [
      `API    : http://${host}:${port}`,
      `Health : http://${host}:${port}/api/health`,
      authDisabled
        ? 'Access : login gate DISABLED (XENIOS_DISABLE_AUTH=true) - local use only'
        : appLoginPasswordSource === 'environment'
          ? 'Access : private login password loaded from APP_LOGIN_PASSWORD'
          : `Access : using a generated login password for this run only -> ${appLoginPassword}`,
      `Auto   : ${formatTerminalEnabledState(Boolean(startupSettings?.strategy?.autoTradingEnabled))} | Runtime ${formatTerminalRuntimeState(autoTradeRuntime.running)}`,
      formatLearningBotStatusLine(learningBotTrainStatus),
      'Loops  : terminal monitor every 10s | open-trade update every 10s | auto-trader scan every 5m',
      'View   : terminal-first live monitoring enabled',
    ],
    'success',
  )
  persistBotSettingsLog({
    trigger: 'STARTUP',
    note: 'Captured on server startup.',
    settings: startupSettings,
  }).catch((error) => {
    console.error('Failed to persist bot settings log on startup:', error)
  })
  maybeRefreshLearningBotPolicy('SERVER_STARTUP', startupSettings).catch((error) => {
    console.error('Failed to auto-refresh AI policy on startup:', error)
  })
})
} // end IS_MAIN_MODULE
