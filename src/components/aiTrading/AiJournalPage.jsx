import { useEffect, useMemo, useState } from 'react'
import { summarizeAccount } from '../../lib/accountMetrics'
import { formatPercent } from '../../lib/formatters'
import { useAiLedger } from '../../lib/aiTradingApi'
import { WalletJournalCalendar } from '../JournalSummaryPage'
import { Panel } from '../Panel'
import { PageHeader } from '../ui/PageHeader'
import { StatCard, pnlTone } from '../ui/StatCard'

const money = (value) => `${Number(value) >= 0 ? '' : '-'}${Math.abs(Number(value) || 0).toFixed(2)} USDT`

export function AiJournalPage() {
  const { ledger, error, loading } = useAiLedger({ pollMs: 15_000 })
  const [walletId, setWalletId] = useState('')
  const [activeMonth, setActiveMonth] = useState('')

  const availableMonths = ledger?.journal.availableMonths || []
  useEffect(() => {
    if (availableMonths.length === 0) return
    if (!availableMonths.includes(activeMonth)) setActiveMonth(availableMonths[0])
  }, [activeMonth, availableMonths])

  const views = useMemo(() => (ledger?.journal.wallets || []).map((item) => ({
    ...item,
    accountSnapshot: summarizeAccount({
      trades: ledger.trades.filter((trade) => trade.walletId === item.walletId),
      livePrices: ledger.livePrices,
      startingBalance: item.startingBalance,
    }),
  })), [ledger])

  const activeView = views.find((view) => view.walletId === walletId) || views[0]
  const wallet = ledger?.wallets.find((item) => item.id === activeView?.walletId)
  const displayMonth = activeMonth || availableMonths[0] || ''
  const monthIndex = availableMonths.indexOf(displayMonth)

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Journal"
        description="A calendar of what the AI wallets made each day (Manila time). Pick the testnet or real money wallet."
      />
      {error && !ledger ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      {loading && !ledger ? <Panel title="Journal"><div className="py-8 text-center text-sm text-slate-400">Loading…</div></Panel> : null}

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

          {wallet ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Realized PnL" value={money(wallet.ledger.realizedPnl)} tone={pnlTone(wallet.ledger.realizedPnl)} />
              <StatCard
                label="Win rate"
                value={wallet.ledger.closedTrades ? formatPercent((wallet.ledger.wins / wallet.ledger.closedTrades) * 100) : '—'}
                sublabel={`${wallet.ledger.wins}W / ${wallet.ledger.losses}L`}
              />
              <StatCard label="Closed trades" value={wallet.ledger.closedTrades} />
              <StatCard label="Open now" value={wallet.ledger.openTrades} sublabel={`${money(wallet.ledger.unrealizedPnl)} unrealized`} tone={pnlTone(wallet.ledger.unrealizedPnl)} />
            </div>
          ) : null}

          {activeView.items.length === 0 ? (
            <Panel title="Wallet Journal">
              <div className="py-8 text-center text-sm text-slate-400">No {activeView.walletName} entries yet — the calendar fills in as the AI opens and closes trades.</div>
            </Panel>
          ) : (
            <WalletJournalCalendar
              key={activeView.walletId}
              walletView={activeView}
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
