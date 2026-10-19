import { useCallback, useEffect, useRef, useState } from 'react'
import { SIGNAL_MODELS } from '../lib/signalModels'
import { formatDateTime } from '../lib/formatters'
import { Panel } from './Panel'
import { Badge } from './ui/Badge'
import { PageHeader } from './ui/PageHeader'
import { StatCard, pnlTone } from './ui/StatCard'

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
const botName = (id) => SIGNAL_MODELS.find((model) => model.id === id)?.name || id

function StartBacktestPanel({ bots, setBots, days, setDays, busy, onStart, blockedBy }) {
  const toggle = (id) => setBots((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  const allSelected = bots.length === SIGNAL_MODELS.length
  return (
    <Panel title="Start a backtest">
      <div className="grid gap-4">
        <p className="text-xs leading-relaxed text-slate-400">
          Walks historical 5-minute candles through the real per-bot signal check and exit simulation — the same two functions the live
          scan loop and the 8-bot research harness both use. No model calls, so this runs in seconds to a few minutes, not hours. You pick
          which bot(s) to test, not symbols — each run uses your current preferred-symbols list, same as what those bots trade live.
        </p>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-[0.2em] text-slate-500">Bots</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => setBots(allSelected ? [] : SIGNAL_MODELS.map((model) => model.id))}
              className="text-xs font-medium text-sky-300 hover:underline disabled:opacity-50"
            >
              {allSelected ? 'Clear' : 'Select all'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {SIGNAL_MODELS.map((model) => {
              const active = bots.includes(model.id)
              return (
                <button
                  key={model.id}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(model.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-sky-300/50 bg-sky-400/15 text-sky-100' : 'border-white/10 bg-slate-950/50 text-slate-400 hover:border-white/25'}`}
                >
                  {model.name}
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
            disabled={busy || bots.length === 0 || Boolean(blockedBy)}
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
  const pct = progress.symbolsTotal ? Math.min(100, Math.round((progress.symbolsDone / progress.symbolsTotal) * 100)) : 0
  return (
    <Panel
      title="This run"
      action={<Badge tone={STATE_TONE[status.state] || 'neutral'}>{STATE_LABEL[status.state] || status.state}</Badge>}
    >
      <div className="grid gap-3 text-sm text-slate-300">
        <div>{status.bots.map(botName).join(', ')} · {status.symbols.length} symbols{status.startMs ? ` · ${formatDateTime(status.startMs)} → ${formatDateTime(status.endMs)}` : ''}</div>
        {ACTIVE_STATES.has(status.state) ? (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-slate-400">
              {progress.symbolsTotal ? `${progress.symbolsDone} / ${progress.symbolsTotal} symbols (${pct}%)` : 'Loading candles…'}
              {progress.currentSymbol ? ` · ${progress.currentSymbol}` : ''}
              {progress.tradesSoFar != null ? ` · ${progress.tradesSoFar} trades so far` : ''}
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
  if (!stats.totalTrades) {
    return (
      <Panel title="Results">
        <div className="py-8 text-center text-sm text-slate-400">No trades yet — either still early in the run, or no bot found a qualifying setup in this window.</div>
      </Panel>
    )
  }
  const byBot = Object.entries(stats.byBot || {}).sort((a, b) => a[1].pnl - b[1].pnl)
  return (
    <div className="grid gap-6">
      <Panel title="Results">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Closed trades" value={stats.totalTrades} />
          <StatCard label="Win rate" value={stats.winRate == null ? '—' : `${fmt2(stats.winRate)}%`} sublabel={`${stats.wins}W / ${stats.losses}L`} />
          <StatCard label="Total P&L" value={`${fmt2(stats.totalPnl)} USDT`} tone={pnlTone(stats.totalPnl)} />
          <StatCard label="Avg win / loss" value={`${fmt2(stats.avgWin)} / ${fmt2(stats.avgLoss)}`} sublabel="USDT" />
        </div>
      </Panel>
      {byBot.length ? (
        <Panel title="By bot">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                  <th className="pb-2 pr-4">Bot</th>
                  <th className="pb-2 pr-4">Trades</th>
                  <th className="pb-2 pr-4">Win rate</th>
                  <th className="pb-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {byBot.map(([botId, row]) => (
                  <tr key={botId} className="border-t border-white/5">
                    <td className="py-2 pr-4 font-medium text-white">{botName(botId)}</td>
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
                <th className="pb-2 pr-4">Bot</th>
                <th className="pb-2 pr-4">Symbol</th>
                <th className="pb-2 pr-4">Side</th>
                <th className="pb-2 pr-4">Opened</th>
                <th className="pb-2 pr-4">Result</th>
                <th className="pb-2">P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice().reverse().slice(0, 500).map((trade) => (
                <tr key={`${trade.symbol}-${trade.signalModelId}-${trade.openedAt}`} className="border-t border-white/5">
                  <td className="py-2 pr-4 font-medium text-white">{botName(trade.signalModelId)}</td>
                  <td className="py-2 pr-4 text-slate-300">{trade.symbol}</td>
                  <td className="py-2 pr-4 text-slate-300">{trade.side === 'BUY' ? 'LONG' : 'SHORT'}</td>
                  <td className="py-2 pr-4 text-slate-400">{formatDateTime(trade.openedAt)}</td>
                  <td className="py-2 pr-4"><Badge tone={trade.result === 'TP' ? 'up' : 'down'}>{trade.result}</Badge></td>
                  <td className={`py-2 font-medium ${trade.pnl > 0 ? 'text-emerald-300' : trade.pnl < 0 ? 'text-rose-300' : 'text-slate-300'}`}>{fmt2(trade.pnl)} USDT</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trades.length > 500 ? <div className="mt-3 text-center text-xs text-slate-500">Showing the most recent 500 of {trades.length} trades.</div> : null}
        </div>
      </Panel>
    </div>
  )
}

export function BotBacktestPage() {
  const [bots, setBots] = useState(SIGNAL_MODELS.map((model) => model.id))
  const [days, setDays] = useState('30')
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [runs, setRuns] = useState([])
  const [activeRunId, setActiveRunId] = useState(null)
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [detail, setDetail] = useState(null)
  const pollRef = useRef(null)

  const loadRuns = useCallback(async () => {
    const payload = await requestJson('/api/bot-trading/backtest')
    setRuns(payload.runs || [])
    setActiveRunId(payload.activeRunId || null)
    if (!selectedRunId && payload.runs?.length) setSelectedRunId(payload.runs[0].id)
    if (payload.activeRunId) setSelectedRunId(payload.activeRunId)
  }, [selectedRunId])

  const loadDetail = useCallback(async (runId) => {
    if (!runId) { setDetail(null); return }
    try {
      const payload = await requestJson(`/api/bot-trading/backtest/${runId}`)
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
      pollRef.current = setInterval(() => { loadDetail(selectedRunId); loadRuns().catch(() => {}) }, 3_000)
    }
    return () => clearInterval(pollRef.current)
  }, [detail?.status?.state, selectedRunId, loadDetail, loadRuns])

  async function start() {
    setStarting(true)
    setError('')
    try {
      const payload = await requestJson('/api/bot-trading/backtest/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bots, days: Number(days) || 30 }),
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
      await requestJson(`/api/bot-trading/backtest/${selectedRunId}/stop`, { method: 'POST' })
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
        description="Runs the actual Bot Trading signal logic against historical candles instead of the live clock — same per-bot rules, same exit simulation, real indicator math."
      />
      {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}

      <StartBacktestPanel bots={bots} setBots={setBots} days={days} setDays={setDays} busy={starting} onStart={start} blockedBy={activeRunId} />

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
                  {run.bots.length > 1 ? `${run.bots.length} bots` : botName(run.bots[0])}
                  <Badge tone={STATE_TONE[run.state] || 'neutral'}>{STATE_LABEL[run.state] || run.state}</Badge>
                </div>
                <div className="mt-1 text-slate-400">{formatDateTime(run.startedAt)}</div>
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
