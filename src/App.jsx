import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { LoaderCircle, LockKeyhole } from 'lucide-react'
import { AppShell } from './components/shell/AppShell'
import { BrandMark } from './components/BrandMark'
import { CodexConsole } from './components/CodexConsole'
import { DashboardKpis } from './components/DashboardKpis'
import { PageHeader } from './components/ui/PageHeader'
import { SubNavTabs } from './components/ui/SubNavTabs'
import { useToast } from './components/ui/Toast'
import { DEFAULT_PATH, resolveInitialPath } from './components/shell/navItems'
import { AiModelsPage } from './components/AiModelsPage'
import { AIAssistantSidebar } from './components/AIAssistantSidebar'
import { AutoTradeStatusPanel } from './components/AutoTradeStatusPanel'
import { BotStatusGrid } from './components/BotStatusGrid'
import { ProExitStrategy } from './components/ProExitStrategy'
import { ForecastPanel } from './components/ForecastPanel'
import { RealMoneyTradingPage, getRealMoneyTrades } from './components/RealMoneyTradingPage'
import { JournalHeadToHeadPage, JournalOverviewPage, JournalWalletPage } from './components/JournalSummaryPage'
import { LearningBotPage } from './components/LearningBotPage'
import { ConsolidatedBotPage } from './components/ConsolidatedBotPage'
import { MockTradingPage } from './components/MockTradingPage'
import { SettingsPage } from './components/SettingsPage'
import { StatsBar } from './components/StatsBar'
import { TradeHistoryStatsPanel } from './components/TradeHistoryStatsPanel'
import { TradeHistoryTable } from './components/TradeHistoryTable'
import { WalletsPage } from './components/WalletsPage'
import { SelfReviewLogPanel, WorkflowNotificationsPanel } from './components/WorkflowReadinessPanel'
import { getKlines, getSignalModelAnalysis, getVolatileMarkets } from './lib/api'
import { getStrategyDerivedMaxLossPerTrade, isTradeClosed, summarizeAccount } from './lib/accountMetrics'
import { formatPrice } from './lib/formatters'
import { detectChartPatterns } from './lib/chartPatterns'
import { calculateBollingerBands, calculateEMA, calculateMACD, calculateRSI, calculateSMA } from './lib/indicators'
import { DEFAULT_MARGIN_MODE } from './lib/marginModes'
import {
  buildDefaultSignalModelStrategies,
  DEFAULT_BOT3_RISK_PRESET_ID,
  DEFAULT_SIGNAL_MODEL_ID,
  getEffectiveSignalModelStrategy,
  getSignalModel,
  SIGNAL_MODELS,
  ensureSignalModelId,
} from './lib/signalModels'
import { MANUAL_TRADE_STYLE_PRESET_ID } from './lib/strategyPresets'
import { DEFAULT_PREFERRED_SYMBOLS } from './lib/tradingConfig'
import { DEFAULT_AUTO_TRADE_SESSIONS } from './lib/tradingSessions'
import { isAutoTradeSource } from './lib/trades'
import {
  buildDefaultWallets,
  getRealMoneyWallet,
  getTotalWalletStartingBalance,
  getWalletEffectiveStartingBalance,
} from './lib/wallets'
import { analyzeTradeSignal } from './lib/tradeSignal'

const CandlestickChart = lazy(() => import('./components/CandlestickChart').then((module) => ({
  default: module.CandlestickChart,
})))

const DEFAULT_SYMBOL = 'BTCUSDT'
const MARKET_STREAM_BASE = 'wss://data-stream.binance.vision'
const COMBINED_STREAM_BASE = `${MARKET_STREAM_BASE}/stream`
const RAW_STREAM_BASE = `${MARKET_STREAM_BASE}/ws`
const DEFAULT_STRATEGY_SETTINGS_BASE = {
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
const DEFAULT_STRATEGY_SETTINGS = {
  ...DEFAULT_STRATEGY_SETTINGS_BASE,
  signalModelStrategies: buildDefaultSignalModelStrategies(DEFAULT_STRATEGY_SETTINGS_BASE),
}

const DEFAULT_SETTINGS = {
  settingsRevision: 0,
  apiKey: '',
  secretKey: '',
  credentials: {
    apiKey: {
      present: false,
      length: 0,
      fingerprint: null,
    },
    secretKey: {
      present: false,
      length: 0,
      fingerprint: null,
    },
  },
  strategy: {
    ...DEFAULT_STRATEGY_SETTINGS,
    maxLossPerTrade: getStrategyDerivedMaxLossPerTrade(DEFAULT_STRATEGY_SETTINGS),
  },
  learningBot: {
    enabled: false,
    mode: 'rule-adaptive',
    focusSource: 'auto',
    trainingScope: 'per-bot',
    focusSignalModelId: 'all',
    reviewWindowTrades: 600,
    minClosedTradesForInsights: 12,
    minPatternSampleSize: 2,
    requireCandleClose: true,
    blockCounterTrend: true,
    autoPromoteToPaper: false,
    notes: '',
    aiTrainer: {
      enabled: false,
      framework: 'pytorch',
      algorithm: 'dqn',
      runtimeCommand: 'python3',
      devicePreference: 'cpu',
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
      'model-4': { enabled: false, paperOnly: true, thresholdScore: 55 },
    },
  },
  wallets: buildDefaultWallets(),
}
const DEFAULT_JOURNAL_SUMMARY = {
  items: [],
  wallets: [],
  availableMonths: [],
}
const DEFAULT_WORKFLOW = {
  currentPhase: 'phase-1',
  summary: '',
  trackedSymbols: [],
  validatedSymbols: [],
  notifications: [],
  phases: [],
  reviewLog: [],
}
const CURRENT_PAGE_STORAGE_KEY = 'xeniostrade:current-page'
const JOURNAL_TABS = [
  { to: '/journal', label: 'Summary', end: true },
  { to: '/journal/head-to-head', label: 'Head to Head' },
  { to: '/journal/wallet', label: 'Wallet Journal' },
]
const TRADE_HISTORY_TABS = [
  { to: '/trade-history', label: 'Testnet Trades', end: true },
  { to: '/trade-history/real-money', label: 'Real Money Trades' },
]
const DASHBOARD_TABS = [
  { to: '/dashboard', label: 'Overview', end: true },
  { to: '/dashboard/market', label: 'Market' },
  { to: '/dashboard/auto-trade-status', label: 'Auto Trade Status' },
  { to: '/dashboard/real-money-trading', label: 'Real Money Trading' },
  { to: '/dashboard/workflow', label: 'Workflow Notifications' },
  { to: '/dashboard/self-review-log', label: 'Self-Review Log' },
  { to: '/dashboard/codex', label: 'Codex Console' },
]
const DEFAULT_AI_TRAINING_STATUS = {
  running: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastExitCode: null,
  lastError: '',
  metrics: null,
  currentDatasetRows: 0,
  eligibleClosedTradeCount: 0,
  realMoneyTradeTarget: 1000,
  realMoneyTradeReady: false,
  realMoneyTradesRemaining: 1000,
}
const DEFAULT_RUNTIME_PROFILE = 'workstation'
const SETTINGS_LOAD_ERROR_PREFIX = 'Unable to refresh saved settings'
const AUTH_STATE_CHECKING = 'checking'
const AUTH_STATE_AUTHENTICATED = 'authenticated'
const AUTH_STATE_UNAUTHENTICATED = 'unauthenticated'

async function readJsonResponse(response) {
  const text = await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    const compactBody = text.replace(/\s+/g, ' ').trim().slice(0, 180)
    const contentType = response.headers.get('content-type') || 'unknown content type'
    throw new Error(`Expected JSON but received ${contentType}: ${compactBody}`)
  }
}

function isConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Failed to fetch') || message.includes('NetworkError')
}

async function fetchJsonResource(url) {
  const response = await fetch(url)
  const payload = await readJsonResponse(response)

  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }

  return payload
}

async function postJsonResource(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await readJsonResponse(response)

  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }

  return payload
}

function ChartPanelFallback() {
  return (
    <section className="min-w-0 overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-glow backdrop-blur-xl">
      <header className="shrink-0 border-b border-white/10 px-5 py-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-300">Chart</h2>
      </header>
      <div className="flex min-h-[620px] flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <LoaderCircle className="h-8 w-8 animate-spin text-sky-300" />
        <div className="text-sm font-semibold text-white">Loading chart module...</div>
        <div className="max-w-md text-sm text-slate-400">
          The dashboard shell is ready. The chart engine is being loaded separately to keep the initial app bundle lighter.
        </div>
      </div>
    </section>
  )
}

function toChartData(klines) {
  return klines.map((entry) => ({
    time: entry[0] / 1000,
    open: Number(entry[1]),
    high: Number(entry[2]),
    low: Number(entry[3]),
    close: Number(entry[4]),
    volume: Number(entry[5] || 0),
  }))
}

function normalizeMarkets(markets, currentMarkets = []) {
  const previousMarkets = new Map(currentMarkets.map((market) => [market.symbol, market]))

  return (Array.isArray(markets) ? markets : []).map((market) => {
    const previous = previousMarkets.get(market.symbol)
    const currentPrice = Number(market.lastPrice || 0)
    const previousPrice = Number(previous?.lastPrice || 0)

    let tickDirection = previous?.tickDirection || 'flat'
    if (previousPrice > 0 && currentPrice > previousPrice) {
      tickDirection = 'up'
    } else if (previousPrice > 0 && currentPrice < previousPrice) {
      tickDirection = 'down'
    }

    return {
      ...market,
      tickDirection,
    }
  })
}

export default function App() {
  const chartReconnectTimeoutRef = useRef(null)
  const marketTradeReconnectTimeoutRef = useRef(null)
  const tradePriceReconnectTimeoutRef = useRef(null)
  const hasLoadedSettingsRef = useRef(false)
  const [authState, setAuthState] = useState(AUTH_STATE_CHECKING)
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [authStatusMessage, setAuthStatusMessage] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const location = useLocation()
  const { error: notifyError } = useToast()
  const [initialPath] = useState(() => {
    try {
      return resolveInitialPath(window.localStorage.getItem(CURRENT_PAGE_STORAGE_KEY))
    } catch {
      return DEFAULT_PATH
    }
  })
  const [markets, setMarkets] = useState([])
  const [liveTradePrices, setLiveTradePrices] = useState({})
  const [liveTradeDirections, setLiveTradeDirections] = useState({})
  const [marketDataHealth, setMarketDataHealth] = useState(null)
  const [selectedSymbol, setSelectedSymbol] = useState(DEFAULT_SYMBOL)
  const [interval, setInterval] = useState('15m')
  const [indicatorVisibility, setIndicatorVisibility] = useState({
    ema: true,
    ma: true,
    bb: true,
    rsi: true,
  })
  const [chartData, setChartData] = useState([])
  const [tradeHistory, setTradeHistory] = useState([])
  const [journalSummary, setJournalSummary] = useState(DEFAULT_JOURNAL_SUMMARY)
  const [autoTradeLog, setAutoTradeLog] = useState([])
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [workflow, setWorkflow] = useState(DEFAULT_WORKFLOW)
  const [aiTrainingStatus, setAiTrainingStatus] = useState(DEFAULT_AI_TRAINING_STATUS)
  const [signalModelAnalyses, setSignalModelAnalyses] = useState({})
  const [autoTradeStatus, setAutoTradeStatus] = useState({
    enabled: false,
    today: { tradeCount: 0, pnl: 0, lossCount: 0 },
    lastRunAt: null,
    lastReason: 'No auto-trade run recorded yet.',
    lastExecuted: false,
  })
  const [tradingMode, setTradingMode] = useState('local-paper')
  const [runtimeProfile, setRuntimeProfile] = useState(DEFAULT_RUNTIME_PROFILE)
  const [loading, setLoading] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [syncingWalletId, setSyncingWalletId] = useState('')
  const [switchingSignalModel, setSwitchingSignalModel] = useState(false)
  const [autoTradePhase, setAutoTradePhase] = useState('idle')
  const [autoTradeFeedback, setAutoTradeFeedback] = useState(null)
  const [closingTradeIds, setClosingTradeIds] = useState({})
  const [error, setError] = useState('')

  useEffect(() => {
    let ignore = false

    async function checkSession() {
      try {
        const response = await fetch('/api/auth/session')
        const payload = await readJsonResponse(response)

        if (ignore) {
          return
        }

        if (response.ok && payload.authenticated) {
          setAuthState(AUTH_STATE_AUTHENTICATED)
          setAuthStatusMessage('')
          setLoginError('')
          return
        }

        setAuthState(AUTH_STATE_UNAUTHENTICATED)
        setAuthStatusMessage('')
      } catch (sessionError) {
        if (ignore) {
          return
        }

        setAuthState(AUTH_STATE_UNAUTHENTICATED)
        setAuthStatusMessage(
          isConnectionError(sessionError)
            ? 'The login service is offline right now. Start the backend server, then try again.'
            : sessionError instanceof Error
              ? sessionError.message
              : 'Unable to verify the current login session.',
        )
      }
    }

    checkSession()

    return () => {
      ignore = true
    }
  }, [])

  async function refreshPlatformState() {
    const results = await Promise.allSettled([
      fetchJsonResource('/api/journal-summary'),
      fetchJsonResource('/api/health'),
      fetchJsonResource('/api/settings'),
      fetchJsonResource('/api/trade-history'),
      fetchJsonResource('/api/auto-trade-status'),
      fetchJsonResource('/api/auto-trade-log'),
      fetchJsonResource('/api/workflow-readiness'),
      fetchJsonResource('/api/learning-bot/train-status'),
    ])

    const [
      journalResult,
      healthResult,
      settingsResult,
      historyResult,
      autoResult,
      logResult,
      workflowResult,
      aiTrainingResult,
    ] = results

    if (journalResult.status === 'fulfilled') {
      setJournalSummary({
        items: journalResult.value.items || [],
        wallets: journalResult.value.wallets || [],
        availableMonths: journalResult.value.availableMonths || [],
      })
    } else {
      console.error('Failed to refresh journal summary:', journalResult.reason)
    }

    if (healthResult.status === 'fulfilled') {
      setTradingMode(healthResult.value.mode)
      setRuntimeProfile(healthResult.value.runtimeProfile || DEFAULT_RUNTIME_PROFILE)
      setMarketDataHealth(healthResult.value.marketData || null)
    } else {
      console.error('Failed to refresh health status:', healthResult.reason)
    }

    if (settingsResult.status === 'fulfilled') {
      hasLoadedSettingsRef.current = true
      setSettings(settingsResult.value)
      setError((current) => (
        current.startsWith(SETTINGS_LOAD_ERROR_PREFIX)
          ? ''
          : current
      ))
    } else {
      console.error('Failed to refresh settings:', settingsResult.reason)

      if (!hasLoadedSettingsRef.current) {
        const message = isConnectionError(settingsResult.reason)
          ? `${SETTINGS_LOAD_ERROR_PREFIX} because the backend server is not reachable on 127.0.0.1:3001. Start \`npm.cmd run dev:server\` or \`npm.cmd run dev:all\`.`
          : `${SETTINGS_LOAD_ERROR_PREFIX}: ${settingsResult.reason instanceof Error ? settingsResult.reason.message : String(settingsResult.reason)}`

        setError((current) => (
          current.startsWith(SETTINGS_LOAD_ERROR_PREFIX)
            ? message
            : current || message
        ))
      }
    }

    if (historyResult.status === 'fulfilled') {
      setTradeHistory(historyResult.value.items || [])
    } else {
      console.error('Failed to refresh trade history:', historyResult.reason)
    }

    if (autoResult.status === 'fulfilled') {
      const payload = autoResult.value
      setAutoTradeStatus(payload)
      if (payload.running) {
        setAutoTradePhase((current) => (current === 'stopping' ? 'stopping' : 'running'))
      } else {
        setAutoTradePhase('idle')
      }
    } else {
      console.error('Failed to refresh auto-trade status:', autoResult.reason)
    }

    if (logResult.status === 'fulfilled') {
      setAutoTradeLog(logResult.value.items || [])
    } else {
      console.error('Failed to refresh auto-trade log:', logResult.reason)
    }

    if (workflowResult.status === 'fulfilled') {
      setWorkflow(workflowResult.value)
    } else {
      console.error('Failed to refresh workflow readiness:', workflowResult.reason)
    }

    if (aiTrainingResult.status === 'fulfilled') {
      setAiTrainingStatus(aiTrainingResult.value.status || DEFAULT_AI_TRAINING_STATUS)
    } else {
      console.error('Failed to refresh AI training status:', aiTrainingResult.reason)
    }
  }

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      return undefined
    }

    let ignore = false

    async function loadMarkets() {
      try {
        const payload = await getVolatileMarkets()

        if (!ignore) {
          const nextMarketItems = Array.isArray(payload.items) ? payload.items : []
          setMarkets((currentMarkets) => normalizeMarkets(nextMarketItems, currentMarkets))

          if (!nextMarketItems.some((market) => market.symbol === selectedSymbol) && nextMarketItems[0]) {
            setSelectedSymbol(nextMarketItems[0].symbol)
          }
        }
      } catch (fetchError) {
        if (!ignore) {
          setError(fetchError.message)
        }
      }
    }

    refreshPlatformState()
    loadMarkets()
    const timer = window.setInterval(() => {
      refreshPlatformState()
      loadMarkets()
    }, 30000)

    return () => {
      ignore = true
      window.clearInterval(timer)
    }
  }, [selectedSymbol, authState])

  useEffect(() => {
    if (location.pathname === '/') {
      return
    }

    try {
      window.localStorage.setItem(CURRENT_PAGE_STORAGE_KEY, location.pathname)
    } catch {
      // Ignore storage issues; routing still works without the remembered page.
    }
  }, [location.pathname])

  useEffect(() => {
    if (error) {
      notifyError(error)
    }
  }, [error, notifyError])

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      return undefined
    }

    const eventSource = new EventSource('/api/auto-trade-events')

    eventSource.addEventListener('state', (event) => {
      const payload = JSON.parse(event.data)
      setAutoTradePhase(
        payload.running
          ? payload.cancelRequested
            ? 'stopping'
            : 'running'
          : 'idle',
      )
      setAutoTradeStatus((current) => ({
        ...current,
        running: payload.running,
        currentRunId: payload.currentRunId,
        lastRunAt: payload.lastRunAt,
        lastReason: payload.lastReason,
        lastExecuted: payload.lastExecuted,
      }))
    })

    eventSource.addEventListener('log', (event) => {
      const payload = JSON.parse(event.data)
      setAutoTradeLog((current) => [payload, ...current].slice(0, 100))
      refreshPlatformState()
    })

    eventSource.addEventListener('step', () => {
      refreshPlatformState()
    })

    eventSource.onerror = () => {
      eventSource.close()
    }

    return () => {
      eventSource.close()
    }
  }, [authState])

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      return undefined
    }

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch('/api/auto-trade-status')
        if (!response.ok) {
          return
        }

        const payload = await readJsonResponse(response)
        setAutoTradeStatus(payload)
        setAutoTradePhase((current) => {
          if (payload.running) {
            return current === 'stopping' ? 'stopping' : 'running'
          }
          return 'idle'
        })
      } catch {
        // Leave last known state in place if polling fails.
      }
    }, 5000)

    return () => {
      window.clearInterval(timer)
    }
  }, [authState])

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      return undefined
    }

    let closedByEffect = false
    const streamSymbol = selectedSymbol.toLowerCase()

    async function loadChartData() {
      setLoading(true)
      setError('')

      try {
        const klines = await getKlines(selectedSymbol, interval, 120)

        if (!closedByEffect) {
          setChartData(toChartData(klines))
        }
      } catch (fetchError) {
        if (!closedByEffect) {
          setError(fetchError.message)
        }
      } finally {
        if (!closedByEffect) {
          setLoading(false)
        }
      }
    }

    function connectChartStream() {
      const socket = new WebSocket(`${RAW_STREAM_BASE}/${streamSymbol}@kline_${interval}`)

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data)
        const kline = payload.k

        if (!kline) {
          return
        }

        const nextPoint = {
          time: Math.floor(kline.t / 1000),
          open: Number(kline.o),
          high: Number(kline.h),
          low: Number(kline.l),
          close: Number(kline.c),
        }

        setChartData((current) => {
          if (current.length === 0) {
            return [nextPoint]
          }

          const lastPoint = current[current.length - 1]
          if (lastPoint.time === nextPoint.time) {
            return [...current.slice(0, -1), nextPoint]
          }

          return [...current.slice(-119), nextPoint]
        })
      }

      socket.onclose = () => {
        if (!closedByEffect) {
          chartReconnectTimeoutRef.current = window.setTimeout(connectChartStream, 1500)
        }
      }

      socket.onerror = () => {
        if (!closedByEffect) {
          setError('Chart stream disconnected')
        }
      }

      return socket
    }

    loadChartData()
    const socket = connectChartStream()

    return () => {
      closedByEffect = true
      window.clearTimeout(chartReconnectTimeoutRef.current)
      socket.close()
    }
  }, [selectedSymbol, interval, authState])

  const selectedMarket = useMemo(
    () => markets.find((market) => market.symbol === selectedSymbol),
    [markets, selectedSymbol],
  )
  const activeSignalModel = useMemo(
    () => getSignalModel(settings.strategy.activeSignalModelId),
    [settings.strategy.activeSignalModelId],
  )
  const marketSymbols = useMemo(
    () => markets.map((market) => market.symbol).filter(Boolean),
    [markets],
  )
  const marketSymbolsKey = useMemo(
    () => marketSymbols.join(','),
    [marketSymbols],
  )

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      return undefined
    }

    if (!marketSymbolsKey) {
      return undefined
    }

    let closedByEffect = false
    const symbols = marketSymbolsKey.split(',').filter(Boolean)

    function connectMarketTradeStream() {
      const streams = symbols.map((symbol) => `${symbol.toLowerCase()}@trade`).join('/')
      const socket = new WebSocket(`${COMBINED_STREAM_BASE}?streams=${streams}`)

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data)
        const data = payload.data || payload
        const symbol = data.s
        const nextPrice = Number(data.p)

        if (!symbol || !Number.isFinite(nextPrice)) {
          return
        }

        setMarkets((currentMarkets) => currentMarkets.map((market) => {
          if (market.symbol !== symbol) {
            return market
          }

          const previousPrice = Number(market.lastPrice || 0)
          const tickDirection = nextPrice > previousPrice
            ? 'up'
            : nextPrice < previousPrice
              ? 'down'
              : market.tickDirection || 'flat'

          if (previousPrice === nextPrice && market.tickDirection === tickDirection) {
            return market
          }

          return {
            ...market,
            lastPrice: nextPrice,
            tickDirection,
          }
        }))
      }

      socket.onclose = () => {
        if (!closedByEffect) {
          marketTradeReconnectTimeoutRef.current = window.setTimeout(connectMarketTradeStream, 1500)
        }
      }

      socket.onerror = () => {
        socket.close()
      }

      return socket
    }

    const socket = connectMarketTradeStream()

    return () => {
      closedByEffect = true
      window.clearTimeout(marketTradeReconnectTimeoutRef.current)
      socket.close()
    }
  }, [marketSymbolsKey, authState])

  const indicators = useMemo(() => ({
    ema: calculateEMA(chartData, 12),
    ma: calculateSMA(chartData, 20),
    bollinger: calculateBollingerBands(chartData, 20, 2),
    macd: calculateMACD(chartData, 12, 26, 9),
    rsi: calculateRSI(chartData, 14),
  }), [chartData])

  const signalAnalysis = useMemo(() => (
    analyzeTradeSignal({
      chartData,
      indicators,
      symbol: selectedSymbol,
    })
  ), [chartData, indicators, selectedSymbol])
  const chartPatternResult = useMemo(() => detectChartPatterns(chartData), [chartData])

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      setSignalModelAnalyses({})
      return undefined
    }

    if (!selectedSymbol) {
      setSignalModelAnalyses({})
      return undefined
    }

    // Drop the previous symbol's analyses right away so panels fed by them
    // (AI Assistant, Pro Exit Strategy, bot status) fall back to the live
    // signalAnalysis for the new symbol instead of showing stale data until
    // the refetch resolves.
    setSignalModelAnalyses({})

    let closedByEffect = false

    async function loadSignalModelAnalyses() {
      const results = await Promise.allSettled(
        SIGNAL_MODELS
          .filter((model) => model.status !== 'blank')
          .map(async (model) => {
            const payload = await getSignalModelAnalysis(selectedSymbol, model.id)
            return [model.id, payload.analysis || null]
          }),
      )

      if (closedByEffect) {
        return
      }

      const nextAnalyses = Object.fromEntries(
        results
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value),
      )

      setSignalModelAnalyses(nextAnalyses)
    }

    async function refreshAnalyses() {
      try {
        await loadSignalModelAnalyses()
      } catch {
        if (!closedByEffect) {
          setSignalModelAnalyses({})
        }
      }
    }

    refreshAnalyses()
    const timer = window.setInterval(refreshAnalyses, 15000)

    return () => {
      closedByEffect = true
      window.clearInterval(timer)
    }
  }, [
    selectedSymbol,
    settings.strategy.bot3RiskPresetId,
    settings.strategy.marginPerTrade,
    settings.strategy.leverage,
    settings.strategy.stopLossPercent,
    settings.strategy.takeProfitPercent,
    settings.strategy.signalModelStrategies,
    authState,
  ])

  const sidebarModelAnalysis = useMemo(
    () => signalModelAnalyses[settings.strategy.activeSignalModelId] || null,
    [signalModelAnalyses, settings.strategy.activeSignalModelId],
  )
  const activeModelStrategy = useMemo(
    () => getEffectiveSignalModelStrategy(settings.strategy, settings.strategy.activeSignalModelId),
    [settings.strategy],
  )
  const latestAutoOrder = useMemo(() => {
    const latestFromLog = autoTradeLog.find((entry) => entry.result?.order)?.result.order
    if (latestFromLog) {
      return latestFromLog
    }

    return tradeHistory.find((trade) => isAutoTradeSource(trade.source)) || null
  }, [autoTradeLog, tradeHistory])

  const signalModelPerformance = useMemo(() => {
    const emptyStats = Object.fromEntries(SIGNAL_MODELS.map((model) => [model.id, {
      tradeCount: 0,
      closedTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      pnl: 0,
    }]))

    for (const trade of tradeHistory) {
      if (!isAutoTradeSource(trade.source)) {
        continue
      }

      const modelId = ensureSignalModelId(trade.signalModelId || DEFAULT_SIGNAL_MODEL_ID)
      const stats = emptyStats[modelId]

      if (!stats) {
        continue
      }

      stats.tradeCount += 1

      if (isTradeClosed(trade)) {
        stats.closedTrades += 1
        stats.pnl += Number(trade.pnl || 0)

        if (Number(trade.pnl || 0) > 0) {
          stats.wins += 1
        } else if (Number(trade.pnl || 0) < 0) {
          stats.losses += 1
        }
      }
    }

    for (const stats of Object.values(emptyStats)) {
      stats.winRate = stats.closedTrades > 0 ? stats.wins / stats.closedTrades : 0
      stats.pnl = Number(stats.pnl.toFixed(2))
    }

    return emptyStats
  }, [tradeHistory])

  const accountSummary = useMemo(
    () => summarizeAccount({
      trades: tradeHistory,
      livePrices: liveTradePrices,
      startingBalance: getTotalWalletStartingBalance(settings.wallets),
    }),
    [tradeHistory, liveTradePrices, settings.wallets],
  )

  const trackedTradeSymbols = useMemo(() => (
    Array.from(new Set([
      ...(settings.strategy.preferredSymbols || []),
      ...tradeHistory.map((trade) => trade.symbol),
    ].filter(Boolean)))
  ), [settings.strategy.preferredSymbols, tradeHistory])

  const trackedTradeSymbolsKey = useMemo(
    () => trackedTradeSymbols.join(','),
    [trackedTradeSymbols],
  )

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      return
    }

    if (trackedTradeSymbols.length === 0 || markets.length === 0) {
      return
    }

    setLiveTradePrices((current) => {
      let changed = false
      const next = { ...current }

      for (const market of markets) {
        if (!trackedTradeSymbols.includes(market.symbol)) {
          continue
        }

        const price = Number(market.lastPrice)
        if (Number.isFinite(price) && next[market.symbol] !== price) {
          next[market.symbol] = price
          changed = true
        }
      }

      return changed ? next : current
    })

    setLiveTradeDirections((current) => {
      let changed = false
      const next = { ...current }

      for (const market of markets) {
        if (!trackedTradeSymbols.includes(market.symbol)) {
          continue
        }

        const direction = market.tickDirection || 'flat'
        if (next[market.symbol] !== direction) {
          next[market.symbol] = direction
          changed = true
        }
      }

      return changed ? next : current
    })
  }, [markets, trackedTradeSymbols, authState])

  useEffect(() => {
    if (authState !== AUTH_STATE_AUTHENTICATED) {
      return undefined
    }

    if (trackedTradeSymbols.length === 0) {
      return undefined
    }

    let closedByEffect = false

    function connectTradePriceStream() {
      const streams = trackedTradeSymbols.map((symbol) => `${symbol.toLowerCase()}@trade`).join('/')
      const socket = new WebSocket(`${COMBINED_STREAM_BASE}?streams=${streams}`)

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data)
        const data = payload.data || payload
        const symbol = data.s
        const price = Number(data.p)

        if (!symbol || !Number.isFinite(price)) {
          return
        }

        setLiveTradePrices((current) => {
          const previousPrice = Number(current[symbol])
          setLiveTradeDirections((currentDirections) => {
            const direction = Number.isFinite(previousPrice) && previousPrice > 0
              ? price > previousPrice
                ? 'up'
                : price < previousPrice
                  ? 'down'
                  : currentDirections[symbol] || 'flat'
              : currentDirections[symbol] || 'flat'

            return currentDirections[symbol] === direction
              ? currentDirections
              : {
                  ...currentDirections,
                  [symbol]: direction,
                }
          })

          return current[symbol] === price
            ? current
            : {
                ...current,
                [symbol]: price,
              }
        })
      }

      socket.onclose = () => {
        if (!closedByEffect) {
          tradePriceReconnectTimeoutRef.current = window.setTimeout(connectTradePriceStream, 1500)
        }
      }

      socket.onerror = () => {
        socket.close()
      }

      return socket
    }

    const socket = connectTradePriceStream()

    return () => {
      closedByEffect = true
      window.clearTimeout(tradePriceReconnectTimeoutRef.current)
      socket.close()
    }
  }, [trackedTradeSymbolsKey, authState])

  async function handleLoginSubmit(event) {
    event.preventDefault()

    if (!loginPassword.trim()) {
      setLoginError('Enter your password to unlock the workspace.')
      return
    }

    setLoggingIn(true)
    setLoginError('')
    setAuthStatusMessage('')

    try {
      await postJsonResource('/api/auth/login', {
        password: loginPassword,
      })
      setLoginPassword('')
      setError('')
      setAuthState(AUTH_STATE_AUTHENTICATED)
    } catch (loginRequestError) {
      setLoginError(
        isConnectionError(loginRequestError)
          ? 'The login service is offline right now. Start the backend server, then try again.'
          : loginRequestError instanceof Error
            ? loginRequestError.message
            : 'Unable to unlock the workspace.',
      )
      setAuthState(AUTH_STATE_UNAUTHENTICATED)
    } finally {
      setLoggingIn(false)
    }
  }

  async function handleLogout() {
    if (loggingOut) {
      return
    }

    setLoggingOut(true)

    try {
      await postJsonResource('/api/auth/logout')
    } catch {
      // Even if logout fails, close the visible workspace on this client.
    } finally {
      window.location.reload()
    }
  }

  function toggleIndicator(key) {
    setIndicatorVisibility((current) => ({
      ...current,
      [key]: !current[key],
    }))
  }

  function handleTradeRecorded(order, mode) {
    setTradingMode(mode)
    setTradeHistory((current) => [order, ...current].slice(0, 200))
    refreshPlatformState()
  }

  async function handleManualCloseTrade(tradeId) {
    if (!tradeId) {
      return
    }

    setClosingTradeIds((current) => {
      if (current[tradeId]) {
        return current
      }

      return {
        ...current,
        [tradeId]: true,
      }
    })

    try {
      const response = await fetch(`/api/trade-history/${encodeURIComponent(tradeId)}/manual-close`, {
        method: 'POST',
      })
      const payload = await readJsonResponse(response)

      if (!response.ok) {
        if (Array.isArray(payload.items)) {
          setTradeHistory(payload.items)
        }

        throw new Error(payload.error || 'Unable to close the trade')
      }

      setError('')

      if (Array.isArray(payload.items)) {
        setTradeHistory(payload.items)
      } else if (payload.trade) {
        setTradeHistory((current) => current.map((trade) => (
          trade.id === tradeId ? payload.trade : trade
        )))
      }

      if (payload.settings) {
        setSettings(payload.settings)
      }

      await refreshPlatformState()
    } catch (closeError) {
      const message = (
        isConnectionError(closeError)
          ? 'Unable to close the trade because the backend server is not reachable on 127.0.0.1:3001. Start `npm.cmd run dev:server` or `npm.cmd run dev:all`.'
          : closeError instanceof Error
            ? closeError.message
            : 'Unable to close the trade'
      )
      setError(message)
    } finally {
      setClosingTradeIds((current) => {
        if (!current[tradeId]) {
          return current
        }

        const next = { ...current }
        delete next[tradeId]
        return next
      })
    }
  }

  async function handleSaveSettings(nextSettings) {
    if (!hasLoadedSettingsRef.current) {
      const message = 'Unable to save settings until the latest backend settings have loaded.'
      setError(message)
      return {
        ok: false,
        error: message,
      }
    }

    setSavingSettings(true)

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...nextSettings,
          settingsRevision: settings.settingsRevision,
        }),
      })

      const payload = await readJsonResponse(response)
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to save settings')
      }

      setError('')
      setSettings(payload)
      refreshPlatformState()
      return {
        ok: true,
        payload,
      }
    } catch (saveError) {
      const message = (
        isConnectionError(saveError)
          ? 'Unable to save settings because the backend server is not reachable on 127.0.0.1:3001. Start `npm.cmd run dev:server` or `npm.cmd run dev:all`.'
          : saveError instanceof Error
            ? saveError.message
            : 'Unable to save settings'
      )
      setError(message)
      return {
        ok: false,
        error: message,
      }
    } finally {
      setSavingSettings(false)
    }
  }

  async function handleSyncWallet(walletId) {
    if (!walletId || syncingWalletId) {
      return
    }

    setSyncingWalletId(walletId)

    try {
      const response = await fetch(`/api/wallets/${encodeURIComponent(walletId)}/sync`, {
        method: 'POST',
      })
      const payload = await readJsonResponse(response)

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to sync the wallet')
      }

      setError('')

      if (payload.settings) {
        setSettings(payload.settings)
      }

      await refreshPlatformState()
    } catch (syncError) {
      const message = (
        isConnectionError(syncError)
          ? 'Unable to sync the wallet because the backend server is not reachable on 127.0.0.1:3001. Start `npm.cmd run dev:server` or `npm.cmd run dev:all`.'
          : syncError instanceof Error
            ? syncError.message
            : 'Unable to sync the wallet'
      )
      setError(message)
    } finally {
      setSyncingWalletId('')
    }
  }

  async function fetchAutoTradeStatusSnapshot() {
    const response = await fetch('/api/auto-trade-status')
    const payload = await readJsonResponse(response)

    if (!response.ok) {
      throw new Error(payload.error || 'Unable to load auto-trade status')
    }

    setAutoTradeStatus(payload)
    setAutoTradePhase(payload.running ? 'running' : 'idle')
    return payload
  }

  async function requestAutoTradeStop() {
    const response = await fetch('/api/auto-trade/stop', {
      method: 'POST',
    })
    const payload = await readJsonResponse(response)

    if (!response.ok) {
      throw new Error(payload.error || 'Unable to stop the current auto-trade run')
    }

    return payload
  }

  async function requestAutoTradeRun() {
    const response = await fetch('/api/auto-trade/run', {
      method: 'POST',
    })
    const payload = await readJsonResponse(response)

    if (!response.ok) {
      throw new Error(payload.error || 'Unable to start the selected auto-trade model')
    }

    return payload
  }

  async function waitForAutoTradeIdle(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const payload = await fetchAutoTradeStatusSnapshot()
      if (!payload.running) {
        return payload
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 500)
      })
    }

    throw new Error('Timed out while waiting for the current auto-trade run to stop.')
  }

  async function handleSelectSignalModel(modelId) {
    if (modelId === settings.strategy.activeSignalModelId || switchingSignalModel) {
      return
    }

    const selectedModel = SIGNAL_MODELS.find((model) => model.id === modelId)
    setSwitchingSignalModel(true)
    setAutoTradeFeedback({
      type: 'warning',
      message: `Setting ${selectedModel?.name || 'the selected model'} as the analysis focus. Wallet automation still follows each wallet's assigned model.`,
    })

    try {
      const saveResult = await handleSaveSettings({
        strategy: {
          activeSignalModelId: modelId,
        },
      })

      if (!saveResult?.ok) {
        throw new Error(saveResult?.error || 'Unable to switch signal model.')
      }

      setAutoTradeFeedback({
        type: 'success',
        message: `${selectedModel?.name || 'Signal model'} is now the analysis focus. Wallet automation still follows the model assigned on each wallet.`,
      })
    } catch (switchError) {
      setAutoTradeFeedback({
        type: 'error',
        message: switchError instanceof Error ? switchError.message : 'Unable to switch signal model.',
      })
      await refreshPlatformState()
    } finally {
      setSwitchingSignalModel(false)
    }
  }

  function renderDashboardOverview() {
    return (
      <>
        <DashboardKpis account={accountSummary} autoTradeStatus={autoTradeStatus} />

        <BotStatusGrid
          modelAnalyses={signalModelAnalyses}
          signalModelPerformance={signalModelPerformance}
          activeSignalModelId={settings.strategy.activeSignalModelId}
          activeModelAnalysis={sidebarModelAnalysis}
        />
      </>
    )
  }

  function renderDashboardMarket() {
    return (
      <div className="grid gap-6">
        <StatsBar
          market={selectedMarket}
          markets={markets}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={setSelectedSymbol}
          signalModels={SIGNAL_MODELS}
          activeSignalModelId={settings.strategy.activeSignalModelId}
          onSelectSignalModel={handleSelectSignalModel}
          switchingSignalModel={switchingSignalModel}
        />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
          <section className="grid gap-6">
            <Suspense fallback={<ChartPanelFallback />}>
              <CandlestickChart
                data={chartData}
                indicators={indicators}
                indicatorVisibility={indicatorVisibility}
                symbol={selectedSymbol}
                interval={interval}
                activeSignalModelId={settings.strategy.activeSignalModelId}
                modelAnalyses={signalModelAnalyses}
                signalModelPerformance={signalModelPerformance}
                loading={loading}
                onChangeInterval={setInterval}
                onToggleIndicator={toggleIndicator}
                chartPatterns={chartPatternResult.patterns}
              />
            </Suspense>

            <ForecastPanel
              modelAnalyses={signalModelAnalyses}
              symbol={selectedSymbol}
              interval={interval}
            />

            <ProExitStrategy analysis={sidebarModelAnalysis || signalAnalysis} />
          </section>

          <AIAssistantSidebar
            analysis={sidebarModelAnalysis || signalAnalysis}
            activeSignalModelId={settings.strategy.activeSignalModelId}
            activeModelRiskSummary={activeModelStrategy.riskProfile?.summary || ''}
            modelChecklistAnalysis={sidebarModelAnalysis}
            chartPatternSummary={chartPatternResult.summary}
          />
        </div>
      </div>
    )
  }

  function renderDashboard() {
    return (
      <div className="grid gap-6">
        <PageHeader
          title="Dashboard"
          description="Live market and model signal for the selected pair, plus automation status, workflow, and the Codex console."
        />
        <SubNavTabs tabs={DASHBOARD_TABS} />
        <Routes>
          <Route index element={renderDashboardOverview()} />
          <Route path="market" element={renderDashboardMarket()} />
          <Route
            path="auto-trade-status"
            element={(
              <AutoTradeStatusPanel
                autoTradeStatus={autoTradeStatus}
                autoTradePhase={autoTradePhase}
                trackedSymbols={settings.strategy.preferredSymbols}
                latestAutoOrder={latestAutoOrder}
              />
            )}
          />
          <Route
            path="real-money-trading"
            element={(
              <RealMoneyTradingPage
                settings={settings}
                trades={tradeHistory}
                livePrices={liveTradePrices}
                aiTrainingStatus={aiTrainingStatus}
                onSave={handleSaveSettings}
                saving={savingSettings}
                ready={hasLoadedSettingsRef.current}
              />
            )}
          />
          <Route path="workflow" element={<WorkflowNotificationsPanel workflow={workflow} />} />
          <Route path="self-review-log" element={<SelfReviewLogPanel workflow={workflow} />} />
          <Route path="codex" element={<CodexConsole />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
    )
  }

  function renderMockTrading() {
    return (
      <MockTradingPage
        analysis={sidebarModelAnalysis || signalAnalysis}
        settings={settings}
        autoTradeStatus={autoTradeStatus}
        autoTradeLog={autoTradeLog}
        autoTradeFeedback={autoTradeFeedback}
        activeSignalModelId={settings.strategy.activeSignalModelId}
        signalModelPerformance={signalModelPerformance}
        onSelectSignalModel={handleSelectSignalModel}
        switchingSignalModel={switchingSignalModel}
        tradingMode={tradingMode}
        autoTradePhase={autoTradePhase}
      />
    )
  }

  function renderLearningBot() {
    return (
      <LearningBotPage
        settings={settings}
        onSave={handleSaveSettings}
        saving={savingSettings}
        ready={hasLoadedSettingsRef.current}
        runtimeProfile={runtimeProfile}
        analysis={sidebarModelAnalysis || signalAnalysis}
        activeSignalModelId={settings.strategy.activeSignalModelId}
        activeModelRiskSummary={activeModelStrategy.riskProfile?.summary || ''}
        modelChecklistAnalysis={sidebarModelAnalysis}
      />
    )
  }

  function renderTradeHistory() {
    const realMoneyTrades = getRealMoneyTrades(tradeHistory, settings.wallets)
    const realMoneyTradeIds = new Set(realMoneyTrades.map((trade) => trade.id))
    const testnetTrades = tradeHistory.filter((trade) => !realMoneyTradeIds.has(trade.id))

    return (
      <div className="grid gap-6">
        <PageHeader
          title="Trade History"
          description="Testnet/paper trades and real-money trades are tracked separately."
        />
        <SubNavTabs tabs={TRADE_HISTORY_TABS} />
        <Routes>
          <Route
            index
            element={(
              <div className="grid gap-6">
                <TradeHistoryStatsPanel
                  trades={testnetTrades}
                  livePrices={liveTradePrices}
                  liveDirections={liveTradeDirections}
                  trackedSymbols={settings.strategy.preferredSymbols}
                  wallets={settings.wallets}
                />
                <TradeHistoryTable
                  title="Testnet Trade History"
                  trades={testnetTrades}
                  livePrices={liveTradePrices}
                  liveDirections={liveTradeDirections}
                  closingTradeIds={closingTradeIds}
                  onManualClose={handleManualCloseTrade}
                />
              </div>
            )}
          />
          <Route
            path="real-money"
            element={(
              <div className="grid gap-6">
                <TradeHistoryStatsPanel
                  trades={realMoneyTrades}
                  livePrices={liveTradePrices}
                  liveDirections={liveTradeDirections}
                  trackedSymbols={settings.strategy.preferredSymbols}
                  wallets={settings.wallets}
                  startingBalance={getWalletEffectiveStartingBalance(getRealMoneyWallet(settings.wallets) || {})}
                />
                <TradeHistoryTable
                  title="Real Money Trade History"
                  trades={realMoneyTrades}
                  livePrices={liveTradePrices}
                  liveDirections={liveTradeDirections}
                  closingTradeIds={closingTradeIds}
                  onManualClose={handleManualCloseTrade}
                />
              </div>
            )}
          />
          <Route path="*" element={<Navigate to="/trade-history" replace />} />
        </Routes>
      </div>
    )
  }

  function renderJournal() {
    const journalProps = {
      data: journalSummary,
      trades: tradeHistory,
      livePrices: liveTradePrices,
      wallets: settings.wallets,
    }

    return (
      <div className="grid gap-6">
        <PageHeader
          title="Journal"
          description="Combined performance across wallets 1-4, the head-to-head comparison, and the per-wallet trade calendar."
        />
        <SubNavTabs tabs={JOURNAL_TABS} />
        <Routes>
          <Route index element={<JournalOverviewPage {...journalProps} />} />
          <Route path="head-to-head" element={<JournalHeadToHeadPage {...journalProps} />} />
          <Route path="wallet" element={<JournalWalletPage {...journalProps} />} />
          <Route path="*" element={<Navigate to="/journal" replace />} />
        </Routes>
      </div>
    )
  }

  function renderWallets() {
    return (
      <WalletsPage
        settings={settings}
        trades={tradeHistory}
        livePrices={liveTradePrices}
        onSave={handleSaveSettings}
        onSyncWallet={handleSyncWallet}
        syncingWalletId={syncingWalletId}
        saving={savingSettings}
        ready={hasLoadedSettingsRef.current}
      />
    )
  }

  function renderAiModels() {
    return (
      <AiModelsPage
        settings={settings}
        onSave={handleSaveSettings}
        saving={savingSettings}
        ready={hasLoadedSettingsRef.current}
      />
    )
  }

  function renderSettings() {
    return (
      <SettingsPage
        settings={settings}
        tradeHistory={tradeHistory}
        livePrices={liveTradePrices}
        autoTradeStatus={autoTradeStatus}
        aiTrainingStatus={aiTrainingStatus}
        onSave={handleSaveSettings}
        saving={savingSettings}
        ready={hasLoadedSettingsRef.current}
      />
    )
  }

  if (authState === AUTH_STATE_CHECKING) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.2),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(20,184,166,0.16),_transparent_24%)]" />
        <div className="absolute inset-0 bg-grid bg-[size:32px_32px] opacity-30" />
        <div className="relative flex w-full max-w-md flex-col items-center gap-5 rounded-[32px] border border-white/10 bg-slate-950/85 px-8 py-12 text-center shadow-glow backdrop-blur-xl">
          <BrandMark />
          <LoaderCircle className="h-10 w-10 animate-spin text-sky-300" />
          <div>
            <div className="text-xl font-semibold text-white">Checking private access</div>
            <div className="mt-2 text-sm text-slate-400">Verifying whether this browser already has an active session.</div>
          </div>
        </div>
      </div>
    )
  }

  if (authState !== AUTH_STATE_AUTHENTICATED) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-slate-950 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.18),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(20,184,166,0.18),_transparent_24%)]" />
        <div className="absolute inset-0 bg-grid bg-[size:32px_32px] opacity-30" />

        <main className="relative mx-auto flex min-h-screen max-w-6xl flex-col justify-center gap-10 px-4 py-10 lg:px-6">
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_420px] lg:items-stretch">
            <div className="rounded-[32px] border border-white/10 bg-white/[0.04] p-8 shadow-glow backdrop-blur-xl sm:p-10">
              <div className="flex items-center gap-4">
                <BrandMark />
                <div>
                  <p className="text-2xl font-semibold tracking-[0.08em] text-white">XeniosTrade</p>
                  <p className="mt-1 text-[11px] uppercase tracking-[0.26em] text-slate-400">Private trading workspace</p>
                </div>
              </div>

              <div className="mt-10 max-w-2xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-400/10 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-100">
                  <LockKeyhole className="h-4 w-4" />
                  Welcome
                </div>
                <h1 className="mt-5 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  Hello there. This workspace is private.
                </h1>
                <p className="mt-4 max-w-xl text-base leading-7 text-slate-300">
                  You can browse this page, but only the owner can unlock the full dashboard, data, and trading controls inside.
                </p>

                <div className="mt-8 grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
                  <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
                    Front door at `/`
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
                    Backend data locked
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
                    Session cookie required
                  </div>
                </div>
              </div>
            </div>

            <section className="rounded-[32px] border border-white/10 bg-slate-950/85 p-8 shadow-glow backdrop-blur-xl sm:p-10">
              <div className="text-sm font-medium uppercase tracking-[0.24em] text-sky-200/70">Owner Login</div>
              <h2 className="mt-3 text-2xl font-semibold text-white">Unlock the workspace</h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                Enter the private password configured on the server to continue.
              </p>

              <form className="mt-8 grid gap-4" onSubmit={handleLoginSubmit}>
                <label className="grid gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Password</span>
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(event) => setLoginPassword(event.target.value)}
                    autoComplete="current-password"
                    placeholder="Enter private password"
                    className="w-full rounded-2xl border border-white/10 bg-slate-900/90 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-sky-300/40 focus:ring-2 focus:ring-sky-300/20"
                  />
                </label>

                {loginError ? (
                  <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                    {loginError}
                  </div>
                ) : null}

                {authStatusMessage ? (
                  <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                    {authStatusMessage}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={loggingIn}
                  className="inline-flex items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-400/15 px-4 py-3 text-sm font-semibold uppercase tracking-[0.18em] text-sky-100 transition hover:border-sky-300/40 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {loggingIn ? 'Unlocking...' : 'Login'}
                </button>
              </form>
            </section>
          </section>
        </main>
      </div>
    )
  }

  return (
    <AppShell
      symbol={selectedSymbol}
      symbols={marketSymbols}
      onSelectSymbol={setSelectedSymbol}
      tradingMode={tradingMode}
      marketDataHealth={marketDataHealth}
      account={accountSummary}
      onLogout={handleLogout}
      loggingOut={loggingOut}
    >
      <Routes>
        <Route path="/" element={<Navigate to={initialPath} replace />} />
        <Route path="/dashboard/*" element={renderDashboard()} />
        <Route path="/mock-trading/*" element={renderMockTrading()} />
        <Route path="/ai-training/*" element={renderLearningBot()} />
        <Route path="/bot-10" element={<ConsolidatedBotPage />} />
        <Route path="/consolidated-bot" element={<Navigate to="/bot-10" replace />} />
        <Route path="/wallets" element={renderWallets()} />
        <Route path="/ai-models/*" element={renderAiModels()} />
        <Route path="/journal/*" element={renderJournal()} />
        <Route path="/trade-history/*" element={renderTradeHistory()} />
        <Route path="/settings/*" element={renderSettings()} />
        <Route path="*" element={<Navigate to={initialPath} replace />} />
      </Routes>
    </AppShell>
  )
}
