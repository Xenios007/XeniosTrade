import { useCallback, useEffect, useState } from 'react'
import { FlaskConical, RefreshCw } from 'lucide-react'
import {
  getLearningBotBacktests,
  getLearningBotBacktestReport,
  updateLearningBotBacktest,
} from '../lib/api'
import { Panel } from './Panel'

function fmtTs(value) {
  const ts = Number(value || 0)
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(ts)
}

function fmtUsd(value) {
  const n = Number(value || 0)
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

const STATUS_STYLES = {
  running: 'bg-sky-400/15 text-sky-200',
  complete: 'bg-emerald-400/12 text-emerald-200',
  failed: 'bg-rose-400/15 text-rose-200',
}

function StatusBadge({ status }) {
  return (
    <span className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${STATUS_STYLES[status] || 'bg-slate-800 text-slate-300'}`}>
      {status || 'unknown'}
    </span>
  )
}

function ProgressRow({ progress, etaText }) {
  const done = Number(progress?.symbolsDone || 0)
  const total = Number(progress?.symbolsTotal || 0)
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{done}/{total} symbols ({pct}%){progress?.currentSymbol ? ` · ${progress.currentSymbol}` : ''}</span>
        <span>{etaText || ''}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function PerBotTable({ perBot = [] }) {
  if (!perBot.length) return <div className="text-sm text-slate-500">No per-bot summary recorded.</div>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm text-slate-300">
        <thead className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
          <tr>
            <th className="py-2 pr-3">Bot</th>
            <th className="py-2 pr-3">Rows</th>
            <th className="py-2 pr-3">Win %</th>
            <th className="py-2 pr-3">Total USDT</th>
            <th className="py-2 pr-3">Avg/trade</th>
            <th className="py-2 pr-3">BUY win%</th>
            <th className="py-2 pr-3">SELL win%</th>
          </tr>
        </thead>
        <tbody>
          {perBot.map((b) => (
            <tr key={b.botId} className="border-t border-white/5">
              <td className="py-2 pr-3 font-semibold text-white">{b.botName || b.botId}</td>
              <td className="py-2 pr-3">{b.rows}</td>
              <td className="py-2 pr-3">{Number(b.winRate || 0).toFixed(1)}%</td>
              <td className={`py-2 pr-3 ${Number(b.totalUsd) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtUsd(b.totalUsd)}</td>
              <td className={`py-2 pr-3 ${Number(b.avgPerTrade) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{Number(b.avgPerTrade || 0).toFixed(3)}</td>
              <td className="py-2 pr-3">{Number(b.buy?.winRate || 0).toFixed(1)}% <span className="text-slate-500">({b.buy?.rows || 0})</span></td>
              <td className="py-2 pr-3">{Number(b.sell?.winRate || 0).toFixed(1)}% <span className="text-slate-500">({b.sell?.rows || 0})</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RunCard({ run, onPatch }) {
  const [expanded, setExpanded] = useState(false)
  const [conclusion, setConclusion] = useState(run.conclusion || '')
  const [report, setReport] = useState(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { setConclusion(run.conclusion || '') }, [run.conclusion])

  const cfg = run.config || {}
  const perBot = run.summary?.perBot || []

  async function toggleInclude() {
    setBusy(true)
    try {
      await onPatch(run.id, { includeInTraining: !run.includeInTraining })
    } finally {
      setBusy(false)
    }
  }

  async function saveConclusion() {
    if ((conclusion || '') === (run.conclusion || '')) return
    await onPatch(run.id, { conclusion })
  }

  async function loadReport() {
    if (report != null) { setReportOpen((v) => !v); return }
    try {
      const payload = await getLearningBotBacktestReport(run.id)
      setReport(payload.markdown || '(no report file found)')
      setReportOpen(true)
    } catch (error) {
      setReport(error instanceof Error ? error.message : 'Unable to load report')
      setReportOpen(true)
    }
  }

  return (
    <article className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <StatusBadge status={run.status} />
          <div>
            <div className="font-semibold text-white">{run.label || run.id}</div>
            <div className="text-xs text-slate-500">{fmtTs(run.startedAt)} · {(cfg.bots || []).join(', ')} · {cfg.months}mo × {cfg.symbolCount} sym{cfg.moneyStopUsd ? ` · -$${cfg.moneyStopUsd} stop` : ''}</div>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={Boolean(run.includeInTraining)}
            disabled={busy || run.status !== 'complete'}
            onChange={toggleInclude}
            className="h-4 w-4 accent-emerald-400 disabled:cursor-not-allowed"
          />
          <span>In AI training</span>
        </label>
      </div>

      {run.status === 'running' ? <ProgressRow progress={run.progress} etaText={run.etaText} /> : null}
      {run.status === 'failed' && run.error ? (
        <div className="mt-2 text-xs text-rose-300">{run.error}</div>
      ) : null}

      {run.status === 'complete' ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
          {perBot.map((b) => (
            <span key={b.botId} className="rounded-full border border-white/10 px-2.5 py-1">
              {(b.botName || b.botId)}: {Number(b.winRate || 0).toFixed(1)}% · {Number(b.avgPerTrade || 0).toFixed(2)}/t · {fmtUsd(b.totalUsd)}
            </span>
          ))}
          {run.summary?.totalRows != null ? (
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-500">{run.summary.totalRows} rows</span>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-sky-300 hover:text-sky-200"
      >
        {expanded ? 'Hide details' : 'Details'}
      </button>

      {expanded ? (
        <div className="mt-3 space-y-4 border-t border-white/5 pt-4">
          <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
            <div>step / stride: {cfg.step} / {cfg.stride}</div>
            <div>cap/(sym,bot): {cfg.capPerSymbolBot}</div>
            <div>friction: {cfg.feeBps} + {cfg.slippageBps} bps/side ×2</div>
            <div>max hold: {cfg.maxHoldHours}h</div>
            <div>context: {cfg.strictContext ? 'strict/zero' : 'proxied'}</div>
            <div>range: {cfg.rangeStart} → {cfg.rangeEnd}</div>
            <div>data file: <code className="text-slate-300">{run.dataFile}</code></div>
            <div>finished: {fmtTs(run.finishedAt)}</div>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Signals used</div>
            <ul className="mt-1 space-y-1 text-sm text-slate-300">
              {(run.signalsUsed || []).map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>

          <PerBotTable perBot={perBot} />

          <label className="block text-sm text-slate-300">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Conclusion</div>
            <textarea
              value={conclusion}
              onChange={(e) => setConclusion(e.target.value)}
              onBlur={saveConclusion}
              rows={3}
              placeholder="What did this run tell us?"
              className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none"
            />
          </label>

          <div>
            <button
              type="button"
              onClick={loadReport}
              className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-white/20"
            >
              {reportOpen ? 'Hide report (.md)' : 'View report (.md)'}
            </button>
            {reportOpen ? (
              <pre className="mt-2 max-h-96 overflow-auto rounded-xl border border-white/10 bg-slate-950 p-4 text-xs text-slate-300">{report}</pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  )
}

export function BacktestHistoryPanel() {
  const [runs, setRuns] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const payload = await getLearningBotBacktests()
      setRuns(Array.isArray(payload.runs) ? payload.runs : [])
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load backtest runs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    const run = async () => { if (!ignore) await load() }
    run()
    const timer = window.setInterval(run, 20_000)
    return () => { ignore = true; window.clearInterval(timer) }
  }, [load])

  const handlePatch = useCallback(async (id, patch) => {
    // optimistic
    setRuns((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    try {
      const payload = await updateLearningBotBacktest(id, patch)
      if (payload?.run) {
        setRuns((current) => current.map((r) => (r.id === id ? { ...r, ...payload.run } : r)))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update run')
      await load()
    }
  }, [load])

  const flaggedCount = runs.filter((r) => r.includeInTraining).length

  return (
    <div className="grid gap-6">
      <Panel
        title="Backtest Runs"
        action={(
          <button type="button" onClick={load} className="text-slate-400 hover:text-slate-200" aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
        )}
      >
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <FlaskConical className="h-4 w-4 text-sky-300" />
          <span>{runs.length} recorded run{runs.length === 1 ? '' : 's'} · {flaggedCount} feeding AI training</span>
        </div>
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs text-amber-100">
          Runs are launched from the command line (<code>npm run backtest:dataset</code>). Each one is recorded here with its own data file and <code>.md</code> report. Only runs with <strong>In AI training</strong> checked are merged into the learning dataset — the live loop keeps training on closed trades regardless.
        </div>
        {error ? <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
        <div className="mt-4 space-y-3">
          {loading && !runs.length ? <div className="text-sm text-slate-500">Loading…</div> : null}
          {!loading && !runs.length ? <div className="text-sm text-slate-500">No backtest runs recorded yet.</div> : null}
          {runs.map((run) => (
            <RunCard key={run.id} run={run} onPatch={handlePatch} />
          ))}
        </div>
      </Panel>
    </div>
  )
}
