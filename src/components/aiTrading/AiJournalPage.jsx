import { useEffect, useMemo, useState } from 'react'
import { summarizeAccount } from '../../lib/accountMetrics'
import { ALL_EXPERIMENTS, filterByExperiment, listExperiments } from '../../lib/aiExperiments'
import { formatPercent } from '../../lib/formatters'
import { useAiLedger } from '../../lib/aiTradingApi'
import { WalletJournalCalendar } from '../JournalSummaryPage'
import { Panel } from '../Panel'
import { PageHeader } from '../ui/PageHeader'
import { StatCard, pnlTone } from '../ui/StatCard'
import { ExperimentComparison } from './ExperimentComparison'
import { ExperimentPicker, useAiExperiment } from './ExperimentPicker'

const money = (value) => `${Number(value) >= 0 ? '' : '-'}${Math.abs(Number(value) || 0).toFixed(2)} USDT`

export function AiJournalPage() {
  const { ledger, error, loading } = useAiLedger({ pollMs: 15_000 })
  const [walletId, setWalletId] = useState('')
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
        description="A calendar of what the AI wallets made each day (Manila time). Each pipeline setting is its own experiment with its own journal; pick one, or compare them below."
      />
      {error && !ledger ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      {loading && !ledger ? <Panel title="Journal"><div className="py-8 text-center text-sm text-slate-400">Loading…</div></Panel> : null}

      {ledger ? <ExperimentPicker experiments={experiments} value={experiment} onChange={setExperiment} /> : null}

      {activeView ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {views.map((view) => (
              <button
                key={view.walletId}
                type="button"
                onClick={() => setWalletId(view.walletId)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  view.walletId === activeView.walletId
                    ? 'bg-sky-400 text-slate-950'
                    : 'border border-white/10 bg-slate-950/60 text-slate-300 hover:border-white/20'
                }`}
              >
                {view.walletName}
              </button>
            ))}
          </div>

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
