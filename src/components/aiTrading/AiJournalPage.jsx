import { useCallback, useEffect, useMemo, useState } from 'react'
import { summarizeAccount } from '../../lib/accountMetrics'
import { ALL_EXPERIMENTS, filterByExperiment, listExperiments } from '../../lib/aiExperiments'
import { formatDateTime, formatPercent } from '../../lib/formatters'
import { useAiLedger } from '../../lib/aiTradingApi'
import { WalletJournalCalendar } from '../JournalSummaryPage'
import { Panel } from '../Panel'
import { Badge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { StatCard, pnlTone } from '../ui/StatCard'
import { ExperimentComparison } from './ExperimentComparison'
import { ExperimentPicker, useAiExperiment } from './ExperimentPicker'

const money = (value) => `${Number(value) >= 0 ? '' : '-'}${Math.abs(Number(value) || 0).toFixed(2)} USDT`

async function fetchJson(url) {
  const response = await fetch(url)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
  return payload
}

/** Same layout as the live wallet view, fed by a backtest run's journal instead of live trades (see
 * GET /api/ai-trading/backtest/:runId/journal). Self-contained: its own run picker, its own month state. */
function BacktestJournalView() {
  const [runs, setRuns] = useState([])
  const [runId, setRunId] = useState('')
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [activeMonth, setActiveMonth] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchJson('/api/ai-trading/backtest')
      .then((payload) => {
        if (cancelled) return
        const list = payload.runs || []
        setRuns(list)
        if (list.length) setRunId((current) => (list.some((run) => run.id === current) ? current : list[0].id))
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load backtests.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const load = useCallback((id) => {
    if (!id) { setDetail(null); return }
    Promise.all([fetchJson(`/api/ai-trading/backtest/${id}/journal`), fetchJson(`/api/ai-trading/backtest/${id}`)])
      .then(([journalPayload, runPayload]) => {
        const accountSnapshot = summarizeAccount({
          trades: journalPayload.trades,
          livePrices: {},
          startingBalance: journalPayload.wallet.startingBalance,
        })
        setDetail({
          view: { ...journalPayload.wallet, accountSnapshot },
          availableMonths: journalPayload.availableMonths,
          status: runPayload.status,
          stats: runPayload.stats,
        })
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load that backtest.'))
  }, [])

  useEffect(() => { load(runId) }, [runId, load])

  const availableMonths = detail?.availableMonths || []
  useEffect(() => {
    if (availableMonths.length === 0) return
    if (!availableMonths.includes(activeMonth)) setActiveMonth(availableMonths[0])
  }, [activeMonth, availableMonths])
  const displayMonth = activeMonth || availableMonths[0] || ''
  const monthIndex = availableMonths.indexOf(displayMonth)

  if (loading) return <Panel title="Backtest"><div className="py-8 text-center text-sm text-slate-400">Loading…</div></Panel>
  if (!runs.length) return <Panel title="Backtest"><div className="py-8 text-center text-sm text-slate-400">No backtest runs yet — start one from AI Trading → Backtest.</div></Panel>

  return (
    <div className="grid gap-6">
      {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      <div className="flex flex-wrap gap-2">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => setRunId(run.id)}
            className={`rounded-2xl border px-3 py-2 text-left text-xs transition ${run.id === runId ? 'border-sky-300/50 bg-sky-400/10' : 'border-white/10 bg-slate-950/50 hover:border-white/25'}`}
          >
            <div className="flex items-center gap-2 font-medium text-white">
              {run.symbols.length > 1 ? `${run.symbols.length} symbols` : run.symbols[0]}
              <Badge tone={run.state === 'completed' ? 'up' : run.state === 'error' ? 'down' : run.state === 'stopped' ? 'warn' : 'info'}>{run.state}</Badge>
            </div>
            <div className="mt-1 text-slate-400">{formatDateTime(run.startMs)} → {formatDateTime(run.endMs)}</div>
          </button>
        ))}
      </div>

      {detail?.view ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Realized PnL" value={money(detail.view.accountSnapshot.realizedPnl)} tone={pnlTone(detail.view.accountSnapshot.realizedPnl)} />
            <StatCard
              label="Win rate"
              value={detail.stats.winRate == null ? '—' : `${detail.stats.winRate.toFixed(1)}%`}
              sublabel={`${detail.stats.wins}W / ${detail.stats.losses}L`}
            />
            <StatCard label="Closed trades" value={detail.stats.totalTrades} />
            <StatCard label="Agents" value="FinGPT" sublabel={detail.status.strategy ? Object.entries(detail.status.strategy).filter(([, value]) => value === true).map(([key]) => key).join(', ') || 'base strategy' : ''} />
          </div>

          {detail.view.items.length === 0 ? (
            <Panel title="Backtest Journal">
              <div className="py-8 text-center text-sm text-slate-400">No trades in this run yet.</div>
            </Panel>
          ) : (
            <WalletJournalCalendar
              key={runId}
              walletView={detail.view}
              activeMonth={displayMonth}
              onMonthChange={setActiveMonth}
              availableMonths={availableMonths}
              monthIndex={monthIndex}
            />
          )}
        </>
      ) : null}
    </div>
  )
}

export function AiJournalPage() {
  const { ledger, error, loading } = useAiLedger({ pollMs: 15_000 })
  const [walletId, setWalletId] = useState('')
  const [showBacktest, setShowBacktest] = useState(false)
  const [activeMonth, setActiveMonth] = useState('')
  const [experiment, setExperiment] = useAiExperiment(ledger?.currentExperiment)

  const experiments = useMemo(() => listExperiments({ items: ledger?.trades || [], current: ledger?.currentExperiment }), [ledger])
  // Each experiment has its own journal (built by the server); 'All experiments' is the combined one.
  const journal = (experiment && experiment !== ALL_EXPERIMENTS && ledger?.journal.experiments?.[experiment]) || ledger?.journal
  const experimentTrades = useMemo(() => filterByExperiment(ledger?.trades || [], experiment), [ledger, experiment])

  const availableMonths = useMemo(() => journal?.availableMonths || [], [journal])
  useEffect(() => {
    if (availableMonths.length === 0) return
    if (!availableMonths.includes(activeMonth)) setActiveMonth(availableMonths[0])
  }, [activeMonth, availableMonths])

  const views = useMemo(() => (journal?.wallets || []).map((item) => ({
    ...item,
    accountSnapshot: summarizeAccount({
      trades: experimentTrades.filter((trade) => trade.walletId === item.walletId),
      livePrices: ledger?.livePrices || {},
      startingBalance: item.startingBalance,
    }),
  })), [journal, experimentTrades, ledger])

  const activeView = views.find((view) => view.walletId === walletId) || views[0]
  const wallet = ledger?.wallets.find((item) => item.id === activeView?.walletId)
  const walletTrades = experimentTrades.filter((trade) => trade.walletId === activeView?.walletId)
  const account = activeView?.accountSnapshot
  const displayMonth = activeMonth || availableMonths[0] || ''
  const monthIndex = availableMonths.indexOf(displayMonth)

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Journal"
        description="A calendar of what the AI wallets made each day (Manila time), plus any backtest you've run. Each pipeline setting is its own experiment with its own journal; pick one, or compare them below."
      />
      {error && !ledger ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      {loading && !ledger ? <Panel title="Journal"><div className="py-8 text-center text-sm text-slate-400">Loading…</div></Panel> : null}

      {ledger && !showBacktest ? <ExperimentPicker experiments={experiments} value={experiment} onChange={setExperiment} /> : null}

      {activeView || ledger ? (
        <div className="flex flex-wrap items-center gap-2">
          {views.map((view) => (
            <button
              key={view.walletId}
              type="button"
              onClick={() => { setShowBacktest(false); setWalletId(view.walletId) }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                !showBacktest && view.walletId === activeView?.walletId
                  ? 'bg-sky-400 text-slate-950'
                  : 'border border-white/10 bg-slate-950/60 text-slate-300 hover:border-white/20'
              }`}
            >
              {view.walletName}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowBacktest(true)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              showBacktest ? 'bg-sky-400 text-slate-950' : 'border border-white/10 bg-slate-950/60 text-slate-300 hover:border-white/20'
            }`}
          >
            Backtest
          </button>
        </div>
      ) : null}

      {showBacktest ? (
        <BacktestJournalView />
      ) : activeView ? (
        <>
          {wallet && account ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Realized PnL" value={money(account.realizedPnl)} tone={pnlTone(account.realizedPnl)} />
              <StatCard
                label="Win rate"
                value={account.closedTradeCount ? formatPercent((account.wins / account.closedTradeCount) * 100) : '—'}
                sublabel={`${account.wins}W / ${account.losses}L`}
              />
              <StatCard label="Closed trades" value={account.closedTradeCount} />
              <StatCard
                label="Open now"
                value={walletTrades.filter((trade) => trade.status === 'OPEN').length}
                sublabel={`${money(account.unrealizedPnl)} unrealized`}
                tone={pnlTone(account.unrealizedPnl)}
              />
            </div>
          ) : null}

          {activeView.items.length === 0 ? (
            <Panel title="Wallet Journal">
              <div className="py-8 text-center text-sm text-slate-400">No {activeView.walletName} entries for this experiment yet. The calendar fills in as the AI opens and closes trades.</div>
            </Panel>
          ) : (
            <WalletJournalCalendar
              key={`${activeView.walletId}:${experiment}`}
              walletView={activeView}
              activeMonth={displayMonth}
              onMonthChange={setActiveMonth}
              availableMonths={availableMonths}
              monthIndex={monthIndex}
            />
          )}

          {wallet ? (
            <ExperimentComparison
              trades={(ledger.trades || []).filter((trade) => trade.walletId === activeView.walletId)}
              experiments={experiments}
              selected={experiment}
              onSelect={setExperiment}
              title={`Compare experiments · ${activeView.walletName}`}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
