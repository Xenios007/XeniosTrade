import { Play } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { getAiProvider, isLocalLoginReady, isProviderConnected, providerDisplayName } from '../lib/aiProviders'
import {
  AI_TRADING_AGENTS, AI_TRADING_LLM_AGENT_IDS, AI_TRADING_SYMBOL_PATTERN, AI_TRADING_SYMBOLS,
} from '../lib/aiTrading'
import { formatDateTime } from '../lib/formatters'
import { AiTradingRunReport, PipelineFlow } from './AiTradingRunReport'
import { Panel } from './Panel'
import { Badge } from './ui/Badge'
import { PageHeader } from './ui/PageHeader'
import { ScanStatusList } from './aiTrading/ScanStatusList'
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

function PipelineTab({ config, settings, localLogins, latestRun, running, error, onRun, onExecuted }) {
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
            Up to five LLM calls per run (Analyst, Market Flow, Critic, Risk Manager, Decision) — fewer when an earlier stage already ends it. Provider and model per agent are set on the{' '}
            <Link to="/ai-models/agents" className="text-sky-300 hover:underline">AI Models</Link> page. Nothing is ordered unless an approved run is opened on an AI wallet.
          </p>
          {error ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div>
          ) : null}
        </div>
      </Panel>

      {latestRun || running ? <AiTradingRunReport run={latestRun} running={running} execution={config?.execution} onExecuted={onExecuted} /> : (
        <Panel title="Pipeline">
          <PipelineFlow run={null} running={false} />
        </Panel>
      )}
    </div>
  )
}

export function HistoryTab({ runs, loading, error, scanStatus, scanEnabled, execution, onExecuted, onRetry }) {
  const [openId, setOpenId] = useState(null)

  return (
    <div className="grid gap-6">
      <Panel title="Auto-scan activity">
        <div className="grid gap-3">
          <ScanStatusList scanStatus={scanStatus} enabled={scanEnabled} />
          <div className="text-[11px] leading-relaxed text-slate-500">
            The scan runs every 5 minutes. Analyst HOLDs and Analyst errors are shown above but not saved as runs below — only runs where the Analyst
            went LONG/SHORT, or that opened a trade, are kept (last 50), so real decisions aren't pushed out by HOLDs. This page refreshes every 15 seconds.
          </div>
        </div>
      </Panel>

      <Panel title="Run History">
        {error ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
            <span>Could not load run history: {error}</span>
            <button type="button" onClick={onRetry} className="rounded-full border border-rose-300/40 px-3 py-1 font-medium hover:bg-rose-400/10">Retry</button>
          </div>
        ) : null}
        {loading ? (
          <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
        ) : !runs.length ? (
          <div className="py-8 text-center text-sm text-slate-400">
            {error ? 'No runs could be loaded.' : 'No saved runs yet — a run appears here when the Analyst goes LONG/SHORT, or when you run the pipeline yourself on the Pipeline tab.'}
          </div>
        ) : (
          <div className="grid gap-3">
            {runs.map((run) => {
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
                    {opened ? <Badge tone="info">Opened on {run.execution.mode}</Badge> : null}
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{final.reason}</span>
                  </button>
                  {open ? <div className="border-t border-white/10 p-4"><AiTradingRunReport run={run} execution={execution} onExecuted={onExecuted} /></div> : null}
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </div>
  )
}

function BacktestContext({ backtestStats }) {
  return (
    <Panel title="Backtest context">
      <div className="text-xs leading-relaxed text-slate-400">
        {backtestStats?.available ? (
          <>
            {backtestStats.tradeCount.toLocaleString()} backtest trades from <span className="text-slate-200">{backtestStats.source}</span>, aggregated{' '}
            {formatDateTime(backtestStats.generatedAt)}. They are shown to the Risk Manager and Decision Agent as background only — they are trades from the
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
      .then((payload) => { if (!cancelled) { setRuns(payload.runs); setRunsError('') } })
      .catch((err) => { if (!cancelled) setRunsError(err instanceof Error ? err.message : 'Could not load run history.') })
      .finally(() => { if (!cancelled) setRunsLoading(false) })
    return () => { cancelled = true }
  }, [])

  const reloadRuns = useCallback(async () => {
    try {
      const payload = await requestJson('/api/ai-trading/runs')
      setRuns(payload.runs)
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
        description="Five AI agents vet one trade idea: the Analyst proposes, Market Flow checks positioning and order flow, the Critic attacks, the Risk Manager sizes, the Decision Agent approves or holds. Approved trades can be opened on the AI testnet or real-money wallet — the pipeline itself never orders."
      />
      <SubNavTabs tabs={TABS} />
      <Routes>
        <Route
          path="/"
          element={<PipelineTab config={config} settings={settings} localLogins={localLogins} latestRun={runs[0] || null} running={running} error={error} onRun={runPipeline} onExecuted={reloadRuns} />}
        />
        <Route
          path="history"
          element={(
            <div className="grid gap-6">
              <HistoryTab runs={runs} loading={runsLoading} error={runsError} scanStatus={scanStatus} scanEnabled={config?.scan?.enabled} execution={config?.execution} onExecuted={reloadRuns} onRetry={reloadRuns} />
              <BacktestContext backtestStats={backtestStats} />
            </div>
          )}
        />
        <Route path="risk" element={<Navigate to="/ai-trading" replace />} />
      </Routes>
    </div>
  )
}
