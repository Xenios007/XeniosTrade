import { BarChart3, Clock3, ShieldAlert, Target, WalletCards } from 'lucide-react'
import { formatPercent, formatPrice } from '../lib/formatters'
import { summarizeAccount } from '../lib/accountMetrics'
import { getTotalWalletStartingBalance } from '../lib/wallets'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { PriceDirectionPill, getPriceDirectionMeta } from './PriceDirectionPill'

function formatPnl(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function formatBalance(value) {
  return `${Number(value || 0).toFixed(2)} USDT`
}

export function TradeHistoryStatsPanel({
  trades,
  livePrices,
  liveDirections = {},
  trackedSymbols = [],
  wallets = [],
  title = 'Trade Performance',
}) {
  const accountSnapshot = summarizeAccount({
    trades,
    livePrices,
    startingBalance: getTotalWalletStartingBalance(wallets),
  })
  const winRate = accountSnapshot.closedTradeCount > 0 ? (accountSnapshot.wins / accountSnapshot.closedTradeCount) * 100 : 0
  const symbolsToShow = trackedSymbols.length > 0
    ? trackedSymbols
    : Array.from(new Set(trades.map((trade) => trade.symbol).filter(Boolean)))
  const shouldAnimateTicker = symbolsToShow.length > 1
  const tickerCopies = shouldAnimateTicker ? [0, 1] : [0]

  const stats = [
    {
      label: 'Running Balance',
      value: formatBalance(accountSnapshot.runningBalance),
      tone: accountSnapshot.runningBalance > accountSnapshot.startingBalance ? 'text-emerald-300' : accountSnapshot.runningBalance < accountSnapshot.startingBalance ? 'text-rose-300' : 'text-slate-100',
      Icon: WalletCards,
    },
    {
      label: 'Realized PnL',
      value: formatPnl(accountSnapshot.realizedPnl),
      tone: accountSnapshot.realizedPnl > 0 ? 'text-emerald-300' : accountSnapshot.realizedPnl < 0 ? 'text-rose-300' : 'text-slate-100',
      Icon: WalletCards,
    },
    {
      label: 'Unrealized PnL',
      value: formatPnl(accountSnapshot.unrealizedPnl),
      tone: accountSnapshot.unrealizedPnl > 0 ? 'text-emerald-300' : accountSnapshot.unrealizedPnl < 0 ? 'text-rose-300' : 'text-slate-100',
      Icon: WalletCards,
    },
    {
      label: 'Wins',
      value: String(accountSnapshot.wins),
      tone: 'text-emerald-300',
      Icon: Target,
    },
    {
      label: 'Losses',
      value: String(accountSnapshot.losses),
      tone: 'text-rose-300',
      Icon: ShieldAlert,
    },
    {
      label: 'Open Positions',
      value: String(accountSnapshot.openTradeCount),
      tone: accountSnapshot.openTradeCount > 0 ? 'text-amber-300' : 'text-slate-100',
      Icon: Clock3,
    },
    {
      label: 'Win Rate',
      value: formatPercent(winRate),
      tone: 'text-slate-100',
      Icon: BarChart3,
    },
  ]

  return (
      <Panel title={title}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        {stats.map((stat) => {
          const Icon = stat.Icon

          return (
            <div key={stat.label} className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs uppercase tracking-[0.24em] text-slate-500">{stat.label}</span>
                <Icon className="h-4 w-4 text-sky-300" />
              </div>
              <div className={`break-words text-xl font-semibold ${stat.tone}`}>{stat.value}</div>
            </div>
          )
        })}
      </div>

      {symbolsToShow.length > 0 ? (
        <div className="trade-performance-ticker mt-4">
          <div className={`trade-performance-ticker-track ${shouldAnimateTicker ? 'is-animated' : ''}`}>
            {tickerCopies.map((copyIndex) => (
              <div
                key={copyIndex}
                className="trade-performance-ticker-group"
                aria-hidden={shouldAnimateTicker && copyIndex > 0 ? 'true' : undefined}
              >
                {symbolsToShow.map((symbol) => (
                  <div
                    key={`${symbol}-${copyIndex}`}
                    className="flex min-w-[10.5rem] shrink-0 items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/60 px-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <CoinAvatar symbol={symbol} size="xs" />
                      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        {symbol}
                      </span>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      <div className={`text-sm font-semibold ${getPriceDirectionMeta(liveDirections?.[symbol] || 'flat').valueTone}`}>
                        {livePrices?.[symbol] != null ? formatPrice(livePrices[symbol], 5) : 'Live feed pending'}
                      </div>
                      {livePrices?.[symbol] != null ? <PriceDirectionPill direction={liveDirections?.[symbol]} compact /> : null}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Panel>
  )
}
