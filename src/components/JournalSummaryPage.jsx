import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { formatPercent } from '../lib/formatters'
import { summarizeAccount } from '../lib/accountMetrics'
import { getRealMoneyWallet, getWalletById, getWalletEffectiveStartingBalance, isRealMoneyWallet } from '../lib/wallets'
import { Panel } from './Panel'

const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatMonthLabel(monthKey) {
  if (!monthKey) {
    return 'Journal Calendar'
  }

  const [year, month] = String(monthKey).split('-').map(Number)
  if (!year || !month) {
    return 'Journal Calendar'
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, 1))
}

function buildCalendarCells(monthKey) {
  if (!monthKey) {
    return []
  }

  const [year, month] = String(monthKey).split('-').map(Number)
  const firstDay = new Date(year, month - 1, 1)
  const leadingEmptyDays = firstDay.getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells = []

  for (let index = 0; index < leadingEmptyDays; index += 1) {
    cells.push(null)
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${monthKey}-${String(day).padStart(2, '0')}`)
  }

  while (cells.length % 7 !== 0) {
    cells.push(null)
  }

  return cells
}

function formatPnl(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function formatBalance(value) {
  return `${Number(value || 0).toFixed(2)} USDT`
}

function getCalendarTone(item) {
  if (!item) {
    return 'border-white/5 bg-white/[0.02]'
  }

  if (item.pnl > 0) {
    return 'border-emerald-400/20 bg-emerald-400/10'
  }

  if (item.pnl < 0) {
    return 'border-rose-400/20 bg-rose-400/10'
  }

  if (item.open > 0) {
    return 'border-amber-400/20 bg-amber-400/10'
  }

  return 'border-white/10 bg-slate-950/60'
}

function getWalletTone(walletColorKey) {
  if (walletColorKey === 'emerald') {
    return {
      badge: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
      accent: 'text-emerald-300',
    }
  }

  if (walletColorKey === 'amber') {
    return {
      badge: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      accent: 'text-amber-300',
    }
  }

  if (walletColorKey === 'slate') {
    return {
      badge: 'border-white/10 bg-white/[0.04] text-slate-100',
      accent: 'text-slate-100',
    }
  }

  if (walletColorKey === 'crimson') {
    return {
      badge: 'border-red-400/20 bg-red-400/10 text-red-100',
      accent: 'text-red-300',
    }
  }

  return {
    badge: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    accent: 'text-sky-200',
  }
}

function WalletSummarySection({ label, value, tone = 'text-white' }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  )
}

function getHeadToHeadGridStyle(walletCount) {
  return {
    gridTemplateColumns: `minmax(120px, 0.55fr) repeat(${walletCount}, minmax(180px, 1fr))`,
  }
}

export function WalletJournalCalendar({ walletView, activeMonth, onMonthChange, availableMonths, monthIndex }) {
  const tone = getWalletTone(walletView.walletColorKey)
  const itemsByDate = new Map(walletView.items.map((item) => [String(item.date), item]))
  const currentMonthItems = walletView.items
    .filter((item) => String(item.date).startsWith(activeMonth))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
  const calendarCells = buildCalendarCells(activeMonth)
  const monthPnl = currentMonthItems.reduce((sum, item) => sum + Number(item.pnl || 0), 0)

  return (
    <div className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Wallet Journal</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="text-xl font-semibold text-white">{walletView.walletName}</div>
            <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${tone.badge}`}>
              {walletView.assignedSignalModelName}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onMonthChange(availableMonths[Math.min(monthIndex + 1, availableMonths.length - 1)])}
            disabled={monthIndex === -1 || monthIndex >= availableMonths.length - 1}
            className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-2 text-slate-300 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onMonthChange(availableMonths[Math.max(monthIndex - 1, 0)])}
            disabled={monthIndex <= 0}
            className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-2 text-slate-300 disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <WalletSummarySection
          label="Running Balance"
          value={formatBalance(walletView.accountSnapshot.runningBalance)}
          tone={walletView.accountSnapshot.runningBalance > walletView.accountSnapshot.startingBalance ? 'text-emerald-300' : walletView.accountSnapshot.runningBalance < walletView.accountSnapshot.startingBalance ? 'text-rose-300' : 'text-slate-100'}
        />
        <WalletSummarySection
          label="Month PnL"
          value={formatPnl(monthPnl)}
          tone={monthPnl > 0 ? 'text-emerald-300' : monthPnl < 0 ? 'text-rose-300' : 'text-slate-100'}
        />
        <WalletSummarySection
          label="Month Win Rate"
          value={formatPercent((currentMonthItems.reduce((sum, item) => sum + Number(item.wins || 0), 0) / Math.max(currentMonthItems.reduce((sum, item) => sum + Number(item.closed || 0), 0), 1)) * 100)}
          tone="text-slate-100"
        />
        <WalletSummarySection
          label="Closed Trades"
          value={`${walletView.summary.closedTrades}`}
          tone="text-slate-100"
        />
      </div>

      <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Calendar</div>
            <div className="mt-1 text-lg font-semibold text-white">{formatMonthLabel(activeMonth)}</div>
          </div>
          <div className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${tone.badge}`}>
            {walletView.summary.totalTrades} total trades
          </div>
        </div>

        <div className="mt-4 grid grid-cols-7 gap-2">
          {weekdayLabels.map((label) => (
            <div key={label} className="px-2 text-center text-[11px] uppercase tracking-[0.2em] text-slate-500">
              {label}
            </div>
          ))}

          {calendarCells.map((dateKey, index) => {
            if (!dateKey) {
              return <div key={`empty-${walletView.walletId}-${index}`} className="min-h-[110px] rounded-2xl border border-white/5 bg-white/[0.02]" />
            }

            const item = itemsByDate.get(dateKey)
            const day = Number(String(dateKey).slice(-2))

            return (
              <div key={`${walletView.walletId}-${dateKey}`} className={`min-h-[110px] rounded-2xl border p-3 ${getCalendarTone(item)}`}>
                <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                  <div className="text-sm font-semibold text-white">{day}</div>
                  {item ? (
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
                      {item.closed}/{item.open}
                    </div>
                  ) : null}
                </div>

                {item ? (
                  <div className="mt-3 space-y-2 text-xs">
                    <div className={item.pnl > 0 ? 'text-emerald-200' : item.pnl < 0 ? 'text-rose-200' : 'text-slate-200'}>
                      {formatPnl(item.pnl)}
                    </div>
                    <div className="text-slate-300">{item.entries ?? item.trades} entries</div>
                    <div className="text-slate-400">{item.wins}W / {item.losses}L</div>
                  </div>
                ) : (
                  <div className="mt-6 text-xs text-slate-500">No trades</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function useJournalViews({ data, trades, livePrices, wallets }) {
  const walletItems = data?.wallets || []
  const availableMonths = useMemo(
    () => data?.availableMonths?.length > 0
      ? data.availableMonths
      : Array.from(new Set(walletItems.flatMap((wallet) => wallet.items.map((item) => String(item.date).slice(0, 7))))).sort((left, right) => right.localeCompare(left)),
    [data?.availableMonths, walletItems],
  )
  const [activeMonth, setActiveMonth] = useState('')

  useEffect(() => {
    if (availableMonths.length === 0) {
      setActiveMonth('')
      return
    }

    if (!availableMonths.includes(activeMonth)) {
      setActiveMonth(availableMonths[0])
    }
  }, [activeMonth, availableMonths])

  const displayMonth = activeMonth || availableMonths[0] || ''
  const monthIndex = availableMonths.indexOf(displayMonth)
  const walletViews = useMemo(() => (
    walletItems.map((walletItem) => {
      const walletConfig = getWalletById(walletItem.walletId, wallets) || {
        manualBalance: 0,
      }
      const walletTrades = trades.filter((trade) => trade.walletId === walletItem.walletId)
      const accountSnapshot = summarizeAccount({
        trades: walletTrades,
        livePrices,
        startingBalance: getWalletEffectiveStartingBalance(walletConfig),
      })

      return {
        ...walletItem,
        accountSnapshot,
      }
    })
  ), [livePrices, trades, walletItems, wallets])

  return { walletViews, availableMonths, displayMonth, setActiveMonth, monthIndex }
}

function JournalEmptyState({ title }) {
  return (
    <Panel title={title}>
      <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
        No wallet journal entries yet.
      </div>
    </Panel>
  )
}

/**
 * Combined view across every wallet (1-4): one capital / P&L / win-rate
 * readout for the whole book, plus a per-wallet strip.
 */
export function JournalOverviewPage(props) {
  const { walletViews } = useJournalViews(props)

  if (walletViews.length === 0) {
    return <JournalEmptyState title="All Wallets Summary" />
  }

  const combined = walletViews.reduce((acc, wallet) => {
    acc.runningBalance += Number(wallet.accountSnapshot.runningBalance || 0)
    acc.startingBalance += Number(wallet.accountSnapshot.startingBalance || 0)
    acc.realizedPnl += Number(wallet.accountSnapshot.realizedPnl || 0)
    acc.unrealizedPnl += Number(wallet.accountSnapshot.unrealizedPnl || 0)
    acc.wins += Number(wallet.summary.wins || 0)
    acc.losses += Number(wallet.summary.losses || 0)
    acc.closedTrades += Number(wallet.summary.closedTrades || 0)
    acc.openTrades += Number(wallet.accountSnapshot.openTradeCount || 0)
    acc.totalTrades += Number(wallet.summary.totalTrades || 0)
    return acc
  }, {
    runningBalance: 0,
    startingBalance: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    wins: 0,
    losses: 0,
    closedTrades: 0,
    openTrades: 0,
    totalTrades: 0,
  })
  const combinedWinRate = combined.closedTrades > 0 ? (combined.wins / combined.closedTrades) * 100 : 0
  const netPnl = combined.realizedPnl + combined.unrealizedPnl
  const leader = [...walletViews].sort((left, right) => right.summary.pnl - left.summary.pnl)[0] || null
  const laggard = [...walletViews].sort((left, right) => left.summary.pnl - right.summary.pnl)[0] || null

  return (
    <div className="space-y-6">
      <Panel title="All Wallets Summary">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <WalletSummarySection
            label="Combined Balance"
            value={formatBalance(combined.runningBalance)}
            tone={combined.runningBalance > combined.startingBalance ? 'text-emerald-300' : combined.runningBalance < combined.startingBalance ? 'text-rose-300' : 'text-slate-100'}
          />
          <WalletSummarySection
            label="Realized P/L"
            value={formatPnl(combined.realizedPnl)}
            tone={combined.realizedPnl > 0 ? 'text-emerald-300' : combined.realizedPnl < 0 ? 'text-rose-300' : 'text-slate-100'}
          />
          <WalletSummarySection
            label="Unrealized P/L"
            value={formatPnl(combined.unrealizedPnl)}
            tone={combined.unrealizedPnl > 0 ? 'text-emerald-300' : combined.unrealizedPnl < 0 ? 'text-rose-300' : 'text-slate-100'}
          />
          <WalletSummarySection
            label="Win Rate"
            value={combined.closedTrades > 0 ? formatPercent(combinedWinRate) : 'No closes yet'}
            tone={combined.closedTrades === 0 ? 'text-slate-100' : combinedWinRate >= 50 ? 'text-emerald-300' : 'text-amber-300'}
          />
          <WalletSummarySection
            label="Closed Trades"
            value={`${combined.closedTrades} (${combined.wins}W / ${combined.losses}L)`}
            tone="text-slate-100"
          />
          <WalletSummarySection
            label="Open Positions"
            value={`${combined.openTrades}`}
            tone={combined.openTrades > 0 ? 'text-amber-300' : 'text-slate-100'}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <WalletSummarySection
            label="Net P/L (Realized + Unrealized)"
            value={formatPnl(netPnl)}
            tone={netPnl > 0 ? 'text-emerald-300' : netPnl < 0 ? 'text-rose-300' : 'text-slate-100'}
          />
          <WalletSummarySection
            label="Profit Leader"
            value={leader ? `${leader.walletName} (${formatPnl(leader.summary.pnl)})` : 'Waiting for trades'}
            tone="text-slate-100"
          />
          <WalletSummarySection
            label="Needs Attention"
            value={laggard ? `${laggard.walletName} (${formatPnl(laggard.summary.pnl)})` : 'Waiting for trades'}
            tone="text-slate-100"
          />
        </div>
      </Panel>

      <Panel title="Wallets 1-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {walletViews.map((wallet) => {
            const tone = getWalletTone(wallet.walletColorKey)
            const balance = wallet.accountSnapshot.runningBalance
            const start = wallet.accountSnapshot.startingBalance

            return (
              <div key={wallet.walletId} className="rounded-[24px] border border-white/10 bg-slate-950/60 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-white">{wallet.walletName}</span>
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${tone.badge}`}>
                    {wallet.assignedSignalModelName}
                  </span>
                </div>

                <div className={`mt-4 text-2xl font-semibold ${wallet.summary.pnl > 0 ? 'text-emerald-300' : wallet.summary.pnl < 0 ? 'text-rose-300' : 'text-slate-100'}`}>
                  {formatPnl(wallet.summary.pnl)}
                </div>
                <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">Realized P/L</div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <WalletSummarySection
                    label="Balance"
                    value={formatBalance(balance)}
                    tone={balance > start ? 'text-emerald-300' : balance < start ? 'text-rose-300' : 'text-slate-100'}
                  />
                  <WalletSummarySection
                    label="Win Rate"
                    value={wallet.summary.closedTrades > 0 ? formatPercent(wallet.summary.winRate * 100) : 'N/A'}
                    tone="text-slate-100"
                  />
                  <WalletSummarySection
                    label="Closed"
                    value={`${wallet.summary.closedTrades}`}
                    tone="text-slate-100"
                  />
                  <WalletSummarySection
                    label="W / L"
                    value={`${wallet.summary.wins} / ${wallet.summary.losses}`}
                    tone="text-slate-100"
                  />
                </div>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}

/**
 * Wallet-vs-wallet comparison for the selected month: summary cards plus a
 * date-by-date P&L grid across every wallet.
 */
export function JournalHeadToHeadPage(props) {
  const { walletViews, displayMonth } = useJournalViews(props)
  const headToHeadViews = walletViews
  const headToHeadGridStyle = getHeadToHeadGridStyle(headToHeadViews.length)
  const headToHeadMinWidth = Math.max(760, 140 + headToHeadViews.length * 220)
  const comparisonRows = useMemo(() => {
    const allDates = Array.from(new Set(
      headToHeadViews.flatMap((wallet) => wallet.items.filter((item) => String(item.date).startsWith(displayMonth)).map((item) => item.date)),
    )).sort((left, right) => right.localeCompare(left))

    return allDates.map((date) => ({
      date,
      items: headToHeadViews.map((wallet) => wallet.items.find((item) => item.date === date) || null),
    }))
  }, [displayMonth, headToHeadViews])

  if (headToHeadViews.length < 2) {
    return <JournalEmptyState title="Head to Head" />
  }

  return (
    <Panel title="Head to Head">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Comparison Month</div>
            <div className="mt-1 text-lg font-semibold text-white">{formatMonthLabel(displayMonth)}</div>
          </div>
          <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-300">
            {headToHeadViews.length} wallets compared
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {headToHeadViews.map((wallet) => (
            <div key={`${wallet.walletId}-summary`} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{wallet.walletName}</div>
              <div className="mt-2 text-sm text-slate-300">{wallet.assignedSignalModelName}</div>
              <div className={`mt-3 text-xl font-semibold ${wallet.summary.pnl > 0 ? 'text-emerald-300' : wallet.summary.pnl < 0 ? 'text-rose-300' : 'text-slate-100'}`}>
                {formatPnl(wallet.summary.pnl)}
              </div>
              <div className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                {wallet.summary.wins} wins / {wallet.summary.losses} losses / {formatPercent(wallet.summary.winRate * 100)}
              </div>
            </div>
          ))}
        </div>

        <div className="overflow-x-auto pb-1">
          <div className="space-y-3" style={{ minWidth: headToHeadMinWidth }}>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="grid gap-3 xl:items-center" style={headToHeadGridStyle}>
                <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Date</div>
                {headToHeadViews.map((wallet) => {
                  const tone = getWalletTone(wallet.walletColorKey)
                  return (
                    <div key={`${wallet.walletId}-header`} className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${tone.badge}`}>
                          {wallet.walletName}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{wallet.assignedSignalModelName}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {comparisonRows.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-slate-400">
                No current-month entries yet.
              </div>
            ) : (
              comparisonRows.map((row) => (
                <div key={row.date} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                  <div className="grid gap-3 xl:items-center" style={headToHeadGridStyle}>
                    <div className="text-sm font-semibold text-white">{row.date}</div>
                    {row.items.map((item, index) => (
                      <div key={`${row.date}-${headToHeadViews[index]?.walletId || index}`} className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
                        {item ? (
                          <>
                            <div className={`text-sm font-semibold ${item.pnl > 0 ? 'text-emerald-300' : item.pnl < 0 ? 'text-rose-300' : 'text-slate-100'}`}>
                              {formatPnl(item.pnl)}
                            </div>
                            <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">
                              {item.entries} entries / {item.wins}W {item.losses}L
                            </div>
                          </>
                        ) : (
                          <div className="text-sm text-slate-400">No trades</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}

/**
 * Full-width trade calendar for one wallet at a time. The wallet dropdown
 * selects which of wallets 1-4 is shown.
 */
export function JournalWalletPage(props) {
  const { walletViews, availableMonths, displayMonth, setActiveMonth, monthIndex } = useJournalViews(props)
  const [selectedWalletId, setSelectedWalletId] = useState('')

  useEffect(() => {
    if (walletViews.length === 0) {
      return
    }

    if (!walletViews.some((wallet) => wallet.walletId === selectedWalletId)) {
      setSelectedWalletId(walletViews[0].walletId)
    }
  }, [walletViews, selectedWalletId])

  if (walletViews.length === 0) {
    return <JournalEmptyState title="Wallet Journal" />
  }

  const activeView = walletViews.find((wallet) => wallet.walletId === selectedWalletId) || walletViews[0]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Viewing wallet</span>
        <label className="relative">
          <span className="sr-only">Select wallet</span>
          <select
            value={activeView.walletId}
            onChange={(event) => setSelectedWalletId(event.target.value)}
            className="appearance-none rounded-full border border-sky-400/40 bg-sky-400/12 py-2 pl-4 pr-10 text-sm font-semibold text-sky-100 outline-none transition focus:border-sky-300/60 focus:ring-2 focus:ring-sky-400/20"
          >
            {walletViews.map((wallet) => (
              <option key={wallet.walletId} value={wallet.walletId} className="bg-slate-900 text-white">
                {wallet.walletName} — {wallet.assignedSignalModelName}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sky-200" />
        </label>
      </div>

      <WalletJournalCalendar
        key={activeView.walletId}
        walletView={activeView}
        activeMonth={displayMonth}
        onMonthChange={setActiveMonth}
        availableMonths={availableMonths}
        monthIndex={monthIndex}
      />
    </div>
  )
}

function RealMoneyFundingCard({ wallet }) {
  if (!wallet) {
    return (
      <Panel title="Real Money Funding Wallet">
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
          The real money wallet has not been created yet. Reopen this page after the backend has synced settings once.
        </div>
      </Panel>
    )
  }

  const status = String(wallet.production?.syncStatus || 'NOT_CONNECTED')
  const statusTone = status === 'CONNECTED'
    ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
    : status === 'ERROR' || status === 'MISSING_CREDENTIALS'
      ? 'border-rose-400/20 bg-rose-400/10 text-rose-100'
      : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
  const fundingBalance = wallet.production?.lastSyncedBalance ?? wallet.manualBalance
  const availableBalance = wallet.production?.lastSyncedAvailableBalance ?? wallet.manualBalance

  return (
    <Panel title="Real Money Funding Wallet">
      <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-100">
        This is the live Binance Futures account — real funds, not a simulation. No bot places live orders yet; this card only reflects the funding balance once live API keys are connected.
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <WalletSummarySection label="Funding Balance" value={formatBalance(fundingBalance)} />
        <WalletSummarySection label="Available Balance" value={formatBalance(availableBalance)} />
        <WalletSummarySection label="Sync Status" value={status.replace(/_/g, ' ')} />
      </div>
      <div className={`mt-4 rounded-2xl border px-4 py-4 text-sm ${statusTone}`}>
        {status === 'CONNECTED'
          ? 'Live Binance Futures account connected. No bot is trading real money yet.'
          : 'Add the live Binance Futures API key and secret in Settings → API Credentials, then sync from Wallets → Real Money.'}
      </div>
    </Panel>
  )
}

/**
 * Real-money counterpart to the Wallet Journal. Shows the live funding
 * wallet's status plus a calendar for any real-money trading wallet — empty
 * today since real money trading has not started, but wired the same way as
 * the testnet wallet journal so it activates automatically once one exists.
 */
export function JournalRealMoneyPage(props) {
  const { walletViews, availableMonths, displayMonth, setActiveMonth, monthIndex } = useJournalViews(props)
  const realMoneyViews = walletViews.filter((view) => {
    const walletConfig = getWalletById(view.walletId, props.wallets)
    return walletConfig && isRealMoneyWallet(walletConfig)
  })
  const fundingWallet = props.data?.realMoneyMainWallet || getRealMoneyWallet(props.wallets) || null
  const [selectedWalletId, setSelectedWalletId] = useState('')

  useEffect(() => {
    if (realMoneyViews.length === 0) {
      return
    }

    if (!realMoneyViews.some((wallet) => wallet.walletId === selectedWalletId)) {
      setSelectedWalletId(realMoneyViews[0].walletId)
    }
  }, [realMoneyViews, selectedWalletId])

  const activeView = realMoneyViews.find((wallet) => wallet.walletId === selectedWalletId) || realMoneyViews[0]

  return (
    <div className="space-y-4">
      <RealMoneyFundingCard wallet={fundingWallet} />

      {realMoneyViews.length === 0 ? (
        <Panel title="Real Money Journal">
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
            No live trades yet — real money trading has not started. See Wallets → Real Money and Settings → API Credentials
            to prepare, and GO_LIVE_READINESS.md for the go-live checklist. Once a live trading wallet is funded and enabled,
            its trade calendar will appear here automatically.
          </div>
        </Panel>
      ) : (
        <>
          {realMoneyViews.length > 1 ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Viewing wallet</span>
              <label className="relative">
                <span className="sr-only">Select wallet</span>
                <select
                  value={activeView.walletId}
                  onChange={(event) => setSelectedWalletId(event.target.value)}
                  className="appearance-none rounded-full border border-red-400/40 bg-red-400/12 py-2 pl-4 pr-10 text-sm font-semibold text-red-100 outline-none transition focus:border-red-300/60 focus:ring-2 focus:ring-red-400/20"
                >
                  {realMoneyViews.map((wallet) => (
                    <option key={wallet.walletId} value={wallet.walletId} className="bg-slate-900 text-white">
                      {wallet.walletName} — {wallet.assignedSignalModelName}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-red-200" />
              </label>
            </div>
          ) : null}

          <WalletJournalCalendar
            key={activeView.walletId}
            walletView={activeView}
            activeMonth={displayMonth}
            onMonthChange={setActiveMonth}
            availableMonths={availableMonths}
            monthIndex={monthIndex}
          />
        </>
      )}
    </div>
  )
}
