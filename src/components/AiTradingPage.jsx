import { Play } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { getAiProvider, isLocalLoginReady, isProviderConnected, providerDisplayName } from '../lib/aiProviders'
import {
  AI_TRADING_AGENTS, AI_TRADING_LLM_AGENT_IDS, AI_TRADING_SYMBOL_PATTERN, AI_TRADING_SYMBOLS,
} from '../lib/aiTrading'
import { HISTORY_FILTERS, buildHistoryFeed, filterHistoryFeed } from '../lib/aiTradingHistory'
import { useAiLedger } from '../lib/aiTradingApi'
import { formatDateTime } from '../lib/formatters'
import { AiTradingRunReport, PipelineFlow } from './AiTradingRunReport'
import { Panel } from './Panel'
import { Badge } from './ui/Badge'
import { PageHeader } from './ui/PageHeader'
import { SubNavTabs } from './ui/SubNavTabs'

const RUNS_REFRESH_MS = 15_000

const TABS = [
  { to: '/ai-trading', label: 'Pipeline', end: true },
  { to: '/ai-trading/history', label: 'Run History' },
]

async function requestJson(url, options) {
  const response = await fetch(url, options)
  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Expected JSON but received: ${text.slice(0, 120)}`)
  }
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
  return payload
}

export function AgentAssignmentStrip({ config, settings, localLogins }) {
  const status = settings?.aiProviderCredentialStatus || {}
  const credentials = settings?.aiProviderCredentials || {}

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {AI_TRADING_LLM_AGENT_IDS.map((agentId) => {
        const agent = AI_TRADING_AGENTS.find((item) => item.id === agentId)
        const assignment = config?.agents?.[agentId]
        const provider = getAiProvider(assignment?.providerId)
        const connected = provider
          ? (provider.localLogin ? isLocalLoginReady(localLogins, provider.id) : isProviderConnected(provider, credentials[provider.id], Boolean(status[provider.id]?.present)))
          : false
        const model = assignment?.model || (provider?.localLogin && !provider?.localServer ? 'default model' : credentials[provider?.id]?.model || provider?.suggested?.[0])

        return (
          <div key={agentId} className="rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-200">{agent.name}</span>
              <Badge tone={connected ? 'up' : 'warn'}>{connected ? (provider.localServer ? 'Running' : provider.localLogin ? 'Logged in' : 'Key saved') : provider ? (provider.localServer ? 'Server offline' : provider.localLogin ? 'Not logged in' : 'No key') : 'Unassigned'}</Badge>
            </div>
            <div className="mt-1 truncate text-[11px] text-slate-500">
              {provider ? `${providerDisplayName(provider, credentials)}${model ? ` · ${model}` : ''}` : 'Pick a provider on the AI Models page'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PipelineTab({ config, settings, localLogins, latestRun, running, error, onRun, onExecuted, trades }) {
  const [symbol, setSymbol] = useState(AI_TRADING_SYMBOLS[0])
  const [custom, setCustom] = useState('')
  const target = custom.trim() ? custom.trim().toUpperCase() : symbol
  const validTarget = AI_TRADING_SYMBOL_PATTERN.test(target)

  return (
    <div className="grid gap-6">
      <Panel
        title="Run the pipeline"
        action={(
          <button
            type="button"
            disabled={running || !validTarget}
            onClick={() => onRun(target)}
            className="inline-flex items-center gap-2 rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {running ? 'Running…' : `Analyse ${target || '…'}`}
          </button>
        )}
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {AI_TRADING_SYMBOLS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => { setSymbol(item); setCustom('') }}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                  !custom.trim() && symbol === item
                    ? 'bg-white/15 text-white'
                    : 'border border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200'
                }`}
              >
                {item.replace('USDT', '')}
              </button>
            ))}
            <input
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="Other, e.g. XRPUSDT"
              aria-label="Custom symbol"
              className="w-44 rounded-full border border-white/10 bg-slate-950/70 px-3.5 py-1.5 text-xs text-white outline-none placeholder:text-slate-600"
            />
          </div>
          <AgentAssignmentStrip config={config} settings={settings} localLogins={localLogins} />
          <p className="text-[11px] leading-relaxed text-slate-500">
            Up to four LLM calls per run (Analyst, Market Flow, Critic, Risk Manager) — fewer when an earlier stage already ends it. Once a trade is open, the Position Manager re-reviews it every 5 minutes (one call per open trade). Provider and model per agent are set on the{' '}
            <Link to="/ai-models/agents" className="text-sky-300 hover:underline">AI Models</Link> page. Nothing is ordered unless an approved run is opened on an AI wallet.
          </p>
          {error ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div>
          ) : null}
        </div>
      </Panel>

      {latestRun || running ? <AiTradingRunReport run={latestRun} running={running} execution={config?.execution} onExecuted={onExecuted} trades={trades} /> : (
        <Panel title="Pipeline">
          <PipelineFlow run={null} running={false} />
        </Panel>
      )}
    </div>
  )
}

const HISTORY_PAGE_SIZE = 100

function scanStatusLine(scanStatus, enabled) {
  if (scanStatus?.running) return 'Scanning now…'
  if (scanStatus?.lastFinishedAt) return `Last scan finished ${formatDateTime(scanStatus.lastFinishedAt)} · every 5 min`
  return enabled === false ? 'Auto-scan is off.' : 'No scan has run yet.'
}

function HistoryTab({ runs, scanLog, loading, error, scanStatus, scanEnabled, execution, onExecuted, onRetry, trades }) {
  const [openId, setOpenId] = useState(null)
  const [filter, setFilter] = useState('all')
  const [shown, setShown] = useState(HISTORY_PAGE_SIZE)

  const feed = useMemo(() => buildHistoryFeed(runs, scanLog), [runs, scanLog])
  const items = useMemo(() => filterHistoryFeed(feed, filter), [feed, filter])

  return (
    <Panel title="Run History">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-2">
          {HISTORY_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { setFilter(item.id); setShown(HISTORY_PAGE_SIZE) }}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${filter === item.id ? 'border-sky-300/50 bg-sky-400/15 text-sky-100' : 'border-white/10 bg-slate-950/50 text-slate-400 hover:border-white/25'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-slate-500">
          {scanStatusLine(scanStatus, scanEnabled)}
          {scanStatus?.lastError ? <span className="ml-2 text-rose-300">Last error: {scanStatus.lastError}</span> : null}
        </div>
      </div>
      <div className="mb-3 text-[11px] leading-relaxed text-slate-500">
        Every scan result is listed here. Only runs where the Analyst went LONG/SHORT, or that opened a trade, have a full report to open (last 50);
        the rest are one-line HOLDs and errors. Refreshes every 15 seconds.
      </div>

      {error ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
          <span>Could not load run history: {error}</span>
          <button type="button" onClick={onRetry} className="rounded-full border border-rose-300/40 px-3 py-1 font-medium hover:bg-rose-400/10">Retry</button>
        </div>
      ) : null}

      {loading ? (
        <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
      ) : !items.length ? (
        <div className="py-8 text-center text-sm text-slate-400">
          {error
            ? 'Nothing could be loaded.'
            : filter === 'all'
              ? 'Nothing yet — scan results appear here every 5 minutes once Auto-scan is on, and manual runs from the Pipeline tab show up too.'
              : 'Nothing matches this filter.'}
        </div>
      ) : (
        <div className="grid gap-2">
          {items.slice(0, shown).map((item) => {
            if (item.kind === 'scan') {
              const { entry } = item
              return (
                <div key={`${entry.symbol}-${entry.at}`} className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.015] px-4 py-2.5">
                  <span className="w-36 shrink-0 text-xs text-slate-500">{formatDateTime(entry.at)}</span>
                  <span className="w-24 shrink-0 text-sm font-semibold text-slate-200">{entry.symbol}</span>
                  <Badge tone={entry.outcome === 'error' ? 'down' : 'neutral'}>{entry.outcome === 'hold' ? 'No trade' : entry.outcome}</Badge>
                  <Badge tone="neutral">Scan</Badge>
                  {entry.testMode ? <Badge tone="warn">Test mode</Badge> : null}
                  <span className="min-w-0 flex-1 text-xs text-slate-500">{entry.detail}</span>
                </div>
              )
            }

            const { run } = item
            const open = openId === run.id
            const final = run.final || {}
            const approved = Boolean(final.approved)
            const opened = run.execution?.status === 'opened'
            return (
              <div key={run.id} className="rounded-2xl border border-white/10 bg-white/[0.03]">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : run.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left"
                >
                  <span className="w-36 shrink-0 text-xs text-slate-400">{formatDateTime(run.startedAt)}</span>
                  <span className="w-24 shrink-0 text-sm font-semibold text-white">{run.symbol}</span>
                  <Badge tone={approved ? (final.action === 'LONG' ? 'up' : 'down') : 'neutral'}>
                    {approved ? `Trade ${final.action}` : 'No trade'}
                  </Badge>
                  <Badge tone="neutral">{run.trigger === 'scan' ? 'Scan' : 'Manual'}</Badge>
                  {run.testMode ? <Badge tone="warn">Test mode</Badge> : null}
                  {opened ? <Badge tone="info">Opened on {run.execution.mode}</Badge> : null}
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{final.reason}</span>
                </button>
                {open ? <div className="border-t border-white/10 p-4"><AiTradingRunReport run={run} execution={execution} onExecuted={onExecuted} trades={trades} /></div> : null}
              </div>
            )
          })}
          {items.length > shown ? (
            <button
              type="button"
              onClick={() => setShown((count) => count + HISTORY_PAGE_SIZE)}
              className="mt-1 justify-self-center rounded-full border border-white/10 px-4 py-1.5 text-xs font-medium text-slate-300 hover:border-white/25"
            >
              Show more ({items.length - shown} older)
            </button>
          ) : null}
        </div>
      )}
    </Panel>
  )
}

function BacktestContext({ backtestStats }) {
  return (
    <Panel title="Backtest context">
      <div className="text-xs leading-relaxed text-slate-400">
        {backtestStats?.available ? (
          <>
            {backtestStats.tradeCount.toLocaleString()} backtest trades from <span className="text-slate-200">{backtestStats.source}</span>, aggregated{' '}
            {formatDateTime(backtestStats.generatedAt)}. They are shown to the Risk Manager as background only — they are trades from the
            rule-based Bots 1–4, so "similar" means same symbol, direction and stop distance, not the same setup, and they never block a trade on their own.
            Rebuild after a new backtest with <code className="text-sky-300">npm run ai-trading:quant-stats</code>.
          </>
        ) : (
          <>No backtest statistics built yet. Run <code className="text-sky-300">npm run ai-trading:quant-stats</code> on the server to give the Risk Manager that background; nothing is blocked without it.</>
        )}
      </div>
    </Panel>
  )
}

export function AiTradingPage({ settings }) {
  const [config, setConfig] = useState(null)
  const [backtestStats, setBacktestStats] = useState(null)
  const [localLogins, setLocalLogins] = useState(null)
  const [runs, setRuns] = useState([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [scanLog, setScanLog] = useState([])
  const { ledger } = useAiLedger({ pollMs: 15_000 })
  const trades = ledger?.trades || []
  const [runsError, setRunsError] = useState('')
  const [scanStatus, setScanStatus] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    requestJson('/api/ai-trading/config')
      .then((payload) => { if (!cancelled) { setConfig(payload.config); setScanStatus(payload.scanStatus || null); setBacktestStats(payload.backtestStats); setLocalLogins({ codex: payload.codex || null, claude: payload.claude || null, fingpt: payload.fingpt || null }) } })
      .catch((err) => { if (!cancelled) setError(err.message) })
    requestJson('/api/ai-trading/runs')
      .then((payload) => { if (!cancelled) { setRuns(payload.runs); setScanLog(payload.scanLog || []); setRunsError('') } })
      .catch((err) => { if (!cancelled) setRunsError(err instanceof Error ? err.message : 'Could not load run history.') })
      .finally(() => { if (!cancelled) setRunsLoading(false) })
    return () => { cancelled = true }
  }, [])

  const reloadRuns = useCallback(async () => {
    try {
      const payload = await requestJson('/api/ai-trading/runs')
      setRuns(payload.runs)
      setScanLog(payload.scanLog || [])
      setRunsError('')
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : 'Could not load run history.')
    }
  }, [])

  // The auto-scan adds runs and status in the background, so keep both fresh while the page is open (paused in a hidden tab).
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return
      reloadRuns()
      requestJson('/api/ai-trading/config').then((payload) => setScanStatus(payload.scanStatus || null)).catch(() => {})
    }
    const timer = setInterval(refresh, RUNS_REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reloadRuns])

  const runPipeline = useCallback(async (symbol) => {
    setRunning(true)
    setError('')
    try {
      const payload = await requestJson('/api/ai-trading/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      setRuns((current) => [payload.run, ...current.filter((run) => run.id !== payload.run.id)])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The pipeline run failed.')
    } finally {
      setRunning(false)
    }
  }, [])

  return (
    <div className="grid gap-6">
      <PageHeader
        title="AI Trading"
        description="Four AI agents decide whether a trade should exist: the Analyst proposes, Market Flow checks positioning and order flow, the Critic attacks, and the Risk Manager gives the final approval with its confidence, size, stop and target. A fifth, the Position Manager, then watches the open trade. Approved trades can be opened on the AI testnet or real-money wallet — the pipeline itself never orders."
      />
      <SubNavTabs tabs={TABS} />
      <Routes>
        <Route
          path="/"
          element={<PipelineTab config={config} settings={settings} localLogins={localLogins} latestRun={runs[0] || null} running={running} error={error} onRun={runPipeline} onExecuted={reloadRuns} trades={trades} />}
        />
        <Route
          path="history"
          element={(
            <div className="grid gap-6">
              <HistoryTab runs={runs} scanLog={scanLog} loading={runsLoading} error={runsError} scanStatus={scanStatus} scanEnabled={config?.scan?.enabled} execution={config?.execution} onExecuted={reloadRuns} onRetry={reloadRuns} trades={trades} />
              <BacktestContext backtestStats={backtestStats} />
            </div>
          )}
        />
        <Route path="risk" element={<Navigate to="/ai-trading" replace />} />
      </Routes>
    </div>
  )
}
