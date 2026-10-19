import { useCallback, useEffect, useRef, useState } from 'react'
import { AI_TRADING_SYMBOLS } from '../../lib/aiTrading'
import { formatDateTime } from '../../lib/formatters'
import { Panel } from '../Panel'
import { Badge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { StatCard, pnlTone } from '../ui/StatCard'

async function requestJson(url, options) {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
  return payload
}

const STATE_TONE = { running: 'info', 'loading-data': 'info', completed: 'up', stopped: 'warn', error: 'down' }
const STATE_LABEL = { running: 'Running', 'loading-data': 'Loading candles', completed: 'Completed', stopped: 'Stopped', error: 'Error' }
const ACTIVE_STATES = new Set(['running', 'loading-data'])
const fmt2 = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—')

function StartBacktestPanel({ symbols, setSymbols, days, setDays, busy, onStart, blockedBy }) {
  const toggle = (symbol) => setSymbols((current) => (current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]))
  return (
    <Panel title="Start a backtest">
      <div className="grid gap-4">
        <p className="text-xs leading-relaxed text-slate-400">
          Walks historical candles through the real AI Trading pipeline — same strategy settings, confidence floor, direction circuit breaker and
          position caps as live — with every active agent routed to <span className="text-sky-300">this server's own FinGPT login</span> instead of
          whatever's configured on Agent Assignments. Trade management during the backtest is mechanical (stop/target only, no Position Manager
          calls) to keep runtime bounded. Each decision is a real local model call, so this is slow: roughly a minute per symbol per entry-timeframe
          candle that reaches the Analyst — a multi-symbol, multi-month run is realistically many hours to multiple days.
        </p>
        <div>
          <div className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-500">Symbols</div>
          <div className="flex flex-wrap gap-2">
            {AI_TRADING_SYMBOLS.map((symbol) => {
              const active = symbols.includes(symbol)
              return (
                <button
                  key={symbol}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(symbol)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-sky-300/50 bg-sky-400/15 text-sky-100' : 'border-white/10 bg-slate-950/50 text-slate-400 hover:border-white/25'}`}
                >
                  {symbol.replace('USDT', '')}
                </button>
              )
            })}
          </div>
        </div>
        <label className="grid max-w-xs gap-2">
          <span className="text-xs uppercase tracking-[0.2em] text-slate-500">Window (days back from now)</span>
          <input
            type="number"
            min={1}
            max={400}
            value={days}
            disabled={busy}
            onChange={(event) => setDays(event.target.value)}
            className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none disabled:opacity-40"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || symbols.length === 0 || Boolean(blockedBy)}
            onClick={onStart}
            className="rounded-full bg-sky-400 px-5 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-40"
          >
            {busy ? 'Starting…' : 'Start backtest'}
          </button>
          {blockedBy ? <span className="text-xs text-amber-300">A backtest ({blockedBy}) is already running — stop it first.</span> : null}
        </div>
      </div>
    </Panel>
  )
}

function ProgressPanel({ status, onStop, stopping }) {
  const progress = status.progress || {}
  const pct = progress.totalSteps ? Math.min(100, Math.round((progress.steps / progress.totalSteps) * 100)) : 0
  return (
    <Panel
      title="This run"
      action={<Badge tone={STATE_TONE[status.state] || 'neutral'}>{STATE_LABEL[status.state] || status.state}</Badge>}
    >
      <div className="grid gap-3 text-sm text-slate-300">
        <div>{status.symbols.join(', ')} · {formatDateTime(status.startMs)} → {formatDateTime(status.endMs)}</div>
        {ACTIVE_STATES.has(status.state) ? (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-slate-400">
              {progress.totalSteps ? `${progress.steps.toLocaleString()} / ${progress.totalSteps.toLocaleString()} steps (${pct}%)` : progress.phase || 'Preparing…'}
              {progress.symbol ? ` · ${progress.symbol}` : ''}
              {progress.nowMs ? ` · simulated ${formatDateTime(progress.nowMs)}` : ''}
              {progress.outcome ? ` · last decision: ${progress.outcome}` : ''}
            </div>
            <div>
              <button
                type="button"
                disabled={stopping}
                onClick={onStop}
                className="rounded-full border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-xs font-semibold text-rose-200 disabled:opacity-50"
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            </div>
          </>
        ) : status.state === 'error' ? (
          <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{status.error}</div>
        ) : (
          <div className="text-xs text-slate-400">Finished {formatDateTime(status.finishedAt)}.</div>
        )}
      </div>
    </Panel>
  )
}

function ResultsPanel({ stats, trades }) {
  if (!stats.totalTrades && !stats.openPositions) {
    return (
      <Panel title="Results">
        <div className="py-8 text-center text-sm text-slate-400">No trades yet — either still early in the run, or the strategy found nothing worth taking in this window.</div>
      </Panel>
    )
  }
  const bySymbol = Object.entries(stats.bySymbol || {}).sort((a, b) => a[1].pnl - b[1].pnl)
  return (
    <div className="grid gap-6">
      <Panel title="Results">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Closed trades" value={stats.totalTrades} sublabel={stats.openPositions ? `${stats.openPositions} still open` : undefined} />
          <StatCard label="Win rate" value={stats.winRate == null ? '—' : `${fmt2(stats.winRate)}%`} sublabel={`${stats.wins}W / ${stats.losses}L`} />
          <StatCard label="Total P&L" value={`${fmt2(stats.totalPnl)} USDT`} tone={pnlTone(stats.totalPnl)} />
          <StatCard label="Avg win / loss" value={`${fmt2(stats.avgWin)} / ${fmt2(stats.avgLoss)}`} sublabel="USDT" />
        </div>
      </Panel>
      {bySymbol.length ? (
        <Panel title="By symbol">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                  <th className="pb-2 pr-4">Symbol</th>
                  <th className="pb-2 pr-4">Trades</th>
                  <th className="pb-2 pr-4">Win rate</th>
                  <th className="pb-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {bySymbol.map(([symbol, row]) => (
                  <tr key={symbol} className="border-t border-white/5">
                    <td className="py-2 pr-4 font-medium text-white">{symbol}</td>
                    <td className="py-2 pr-4 text-slate-300">{row.n}</td>
                    <td className="py-2 pr-4 text-slate-300">{row.n ? `${fmt2((row.wins / row.n) * 100)}%` : '—'}</td>
                    <td className={`py-2 font-medium ${row.pnl > 0 ? 'text-emerald-300' : row.pnl < 0 ? 'text-rose-300' : 'text-slate-300'}`}>{fmt2(row.pnl)} USDT</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      <Panel title={`Trades (${trades.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                <th className="pb-2 pr-4">Symbol</th>
                <th className="pb-2 pr-4">Side</th>
                <th className="pb-2 pr-4">Opened</th>
                <th className="pb-2 pr-4">Closed</th>
                <th className="pb-2 pr-4">Result</th>
                <th className="pb-2 pr-4">Confidence</th>
                <th className="pb-2">P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice().reverse().map((trade) => (
                <tr key={`${trade.symbol}-${trade.openedAt}`} className="border-t border-white/5">
                  <td className="py-2 pr-4 font-medium text-white">{trade.symbol}</td>
                  <td className="py-2 pr-4 text-slate-300">{trade.side === 'BUY' ? 'LONG' : 'SHORT'}</td>
                  <td className="py-2 pr-4 text-slate-400">{formatDateTime(trade.openedAt)}</td>
                  <td className="py-2 pr-4 text-slate-400">{trade.closedAt ? formatDateTime(trade.closedAt) : '—'}</td>
                  <td className="py-2 pr-4"><Badge tone={trade.result === 'TP' ? 'up' : trade.result === 'SL' ? 'down' : 'neutral'}>{trade.result || 'OPEN'}</Badge></td>
                  <td className="py-2 pr-4 text-slate-300">{trade.confidence == null ? '—' : `${trade.confidence}%`}</td>
                  <td className={`py-2 font-medium ${trade.pnl > 0 ? 'text-emerald-300' : trade.pnl < 0 ? 'text-rose-300' : 'text-slate-300'}`}>{typeof trade.pnl === 'number' ? `${fmt2(trade.pnl)} USDT` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

export function AiBacktestPage() {
  const [symbols, setSymbols] = useState([...AI_TRADING_SYMBOLS])
  const [days, setDays] = useState('60')
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [runs, setRuns] = useState([])
  const [activeRunId, setActiveRunId] = useState(null)
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [detail, setDetail] = useState(null)
  const pollRef = useRef(null)

  const loadRuns = useCallback(async () => {
    const payload = await requestJson('/api/ai-trading/backtest')
    setRuns(payload.runs || [])
    setActiveRunId(payload.activeRunId || null)
    if (!selectedRunId && payload.runs?.length) setSelectedRunId(payload.runs[0].id)
    if (payload.activeRunId) setSelectedRunId(payload.activeRunId)
  }, [selectedRunId])

  const loadDetail = useCallback(async (runId) => {
    if (!runId) { setDetail(null); return }
    try {
      const payload = await requestJson(`/api/ai-trading/backtest/${runId}`)
      setDetail(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that run.')
    }
  }, [])

  useEffect(() => { loadRuns().catch((err) => setError(err instanceof Error ? err.message : 'Could not load backtests.')) }, [loadRuns])
  useEffect(() => { loadDetail(selectedRunId) }, [selectedRunId, loadDetail])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (detail?.status && ACTIVE_STATES.has(detail.status.state)) {
      pollRef.current = setInterval(() => { loadDetail(selectedRunId); loadRuns().catch(() => {}) }, 4_000)
    }
    return () => clearInterval(pollRef.current)
  }, [detail?.status?.state, selectedRunId, loadDetail, loadRuns])

  async function start() {
    setStarting(true)
    setError('')
    try {
      const payload = await requestJson('/api/ai-trading/backtest/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols, days: Number(days) || 60 }),
      })
      setSelectedRunId(payload.runId)
      await loadRuns()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the backtest.')
    } finally {
      setStarting(false)
    }
  }

  async function stop() {
    if (!selectedRunId) return
    setStopping(true)
    try {
      await requestJson(`/api/ai-trading/backtest/${selectedRunId}/stop`, { method: 'POST' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the backtest.')
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Backtest"
        description="Runs the actual AI Trading pipeline against historical candles instead of the live clock — same gates, same confidence floor, same strategy, real model calls."
      />
      {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}

      <StartBacktestPanel
        symbols={symbols} setSymbols={setSymbols} days={days} setDays={setDays}
        busy={starting} onStart={start} blockedBy={activeRunId}
      />

      {runs.length ? (
        <Panel title="Runs">
          <div className="flex flex-wrap gap-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={`rounded-2xl border px-3 py-2 text-left text-xs transition ${selectedRunId === run.id ? 'border-sky-300/50 bg-sky-400/10' : 'border-white/10 bg-slate-950/50 hover:border-white/25'}`}
              >
                <div className="flex items-center gap-2 font-medium text-white">
                  {run.symbols.length > 1 ? `${run.symbols.length} symbols` : run.symbols[0]}
                  <Badge tone={STATE_TONE[run.state] || 'neutral'}>{STATE_LABEL[run.state] || run.state}</Badge>
                </div>
                <div className="mt-1 text-slate-400">{formatDateTime(run.startMs)} → {formatDateTime(run.endMs)}</div>
              </button>
            ))}
          </div>
        </Panel>
      ) : null}

      {detail?.status ? <ProgressPanel status={detail.status} onStop={stop} stopping={stopping} /> : null}
      {detail?.stats ? <ResultsPanel stats={detail.stats} trades={detail.trades || []} /> : null}
    </div>
  )
}
