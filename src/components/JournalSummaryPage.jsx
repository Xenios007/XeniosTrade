import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ShieldAlert, Target, WalletCards } from 'lucide-react'
import { formatPercent } from '../lib/formatters'
import { summarizeAccount } from '../lib/accountMetrics'
import { getWalletById, getWalletEffectiveStartingBalance } from '../lib/wallets'
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

function WalletJournalCalendar({ walletView, activeMonth, onMonthChange, availableMonths, monthIndex }) {
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
                <div className="flex items-start justify-between gap-2">
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

export function JournalSummaryPage({ data, trades = [], livePrices = {}, wallets = [] }) {
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

  const comparisonViews = walletViews.slice(0, 2)
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

  const pnlLeader = [...comparisonViews].sort((left, right) => right.summary.pnl - left.summary.pnl)[0] || null
  const winRateLeader = [...comparisonViews]
    .filter((wallet) => wallet.summary.closedTrades > 0)
    .sort((left, right) => right.summary.winRate - left.summary.winRate || right.summary.closedTrades - left.summary.closedTrades)[0] || null

  return (
    <Panel title="Daily Auto-Trade Journal">
      {walletViews.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
          No wallet journal entries yet.
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <WalletSummarySection
              label="Profit Leader"
              value={pnlLeader ? pnlLeader.walletName : 'Waiting for trades'}
              tone="text-slate-100"
            />
            <WalletSummarySection
              label="Best Win Rate"
              value={winRateLeader ? winRateLeader.walletName : 'Waiting for closes'}
              tone="text-slate-100"
            />
            <WalletSummarySection
              label={comparisonViews[0]?.walletName || 'Wallet A PnL'}
              value={comparisonViews[0] ? formatPnl(comparisonViews[0].summary.pnl) : 'N/A'}
              tone={comparisonViews[0]?.summary.pnl > 0 ? 'text-emerald-300' : comparisonViews[0]?.summary.pnl < 0 ? 'text-rose-300' : 'text-slate-100'}
            />
            <WalletSummarySection
              label={comparisonViews[1]?.walletName || 'Wallet B PnL'}
              value={comparisonViews[1] ? formatPnl(comparisonViews[1].summary.pnl) : 'N/A'}
              tone={comparisonViews[1]?.summary.pnl > 0 ? 'text-emerald-300' : comparisonViews[1]?.summary.pnl < 0 ? 'text-rose-300' : 'text-slate-100'}
            />
          </div>

          <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-4 text-sm text-sky-100">
            The journal is split by wallet so each model can be judged on its own capital curve, trade distribution, and realized profit instead of mixing both experiments together.
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            {walletViews.map((walletView) => (
              <WalletJournalCalendar
                key={walletView.walletId}
                walletView={walletView}
                activeMonth={displayMonth}
                onMonthChange={setActiveMonth}
                availableMonths={availableMonths}
                monthIndex={monthIndex}
              />
            ))}
          </div>

          {headToHeadViews.length >= 2 ? (
            <div className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Head To Head</div>
                  <div className="mt-1 text-lg font-semibold text-white">{formatMonthLabel(displayMonth)}</div>
                </div>
                <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-300">
                  {headToHeadViews.length} wallets compared
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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

              <div className="mt-5 overflow-x-auto pb-1">
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
          ) : null}
        </div>
      )}
    </Panel>
  )
}
