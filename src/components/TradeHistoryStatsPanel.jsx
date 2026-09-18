import { BarChart3, Clock3, RefreshCcw, ShieldAlert, Target, WalletCards } from 'lucide-react'
import { formatPercent, formatPrice } from '../lib/formatters'
import { summarizeAccount } from '../lib/accountMetrics'
import { getMainWallet, getTotalWalletStartingBalance } from '../lib/wallets'
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

function formatSyncTime(timestamp) {
  if (!timestamp) {
    return 'never'
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(timestamp)
  } catch {
    return 'never'
  }
}

export function TradeHistoryStatsPanel({
  trades,
  livePrices,
  liveDirections = {},
  trackedSymbols = [],
  wallets = [],
  title = 'Trade Performance',
  onSyncMainWallet,
  syncingWalletId = null,
  startingBalance = null,
}) {
  const accountSnapshot = summarizeAccount({
    trades,
    livePrices,
    startingBalance: startingBalance != null ? startingBalance : getTotalWalletStartingBalance(wallets),
  })
  const mainWallet = getMainWallet(wallets)
  const realWalletBalance = mainWallet?.production?.lastSyncedBalance
  const hasRealWalletBalance = realWalletBalance != null
  const displayedRunningBalance = hasRealWalletBalance ? realWalletBalance : accountSnapshot.runningBalance
  const runningBalanceBaseline = hasRealWalletBalance
    ? (mainWallet?.manualBalance ?? accountSnapshot.startingBalance)
    : accountSnapshot.startingBalance
  const isSyncingMainWallet = Boolean(mainWallet?.id) && syncingWalletId === mainWallet.id
  const winRate = accountSnapshot.closedTradeCount > 0 ? (accountSnapshot.wins / accountSnapshot.closedTradeCount) * 100 : 0
  const symbolsToShow = trackedSymbols.length > 0
    ? trackedSymbols
    : Array.from(new Set(trades.map((trade) => trade.symbol).filter(Boolean)))
  const shouldAnimateTicker = symbolsToShow.length > 1
  const tickerCopies = shouldAnimateTicker ? [0, 1] : [0]

  const stats = [
    {
      label: hasRealWalletBalance ? 'Running Balance (Real Wallet)' : 'Running Balance',
      value: formatBalance(displayedRunningBalance),
      tone: displayedRunningBalance > runningBalanceBaseline ? 'text-emerald-300' : displayedRunningBalance < runningBalanceBaseline ? 'text-rose-300' : 'text-slate-100',
      Icon: WalletCards,
      detail: hasRealWalletBalance
        ? `Synced from ${mainWallet.name} • last synced ${formatSyncTime(mainWallet.production.lastSyncedAt)}`
        : 'Main wallet not synced yet — showing simulated bot-ledger balance.',
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
              {stat.detail ? (
                <div className="mt-2 break-words text-[11px] leading-relaxed text-slate-500">{stat.detail}</div>
              ) : null}
            </div>
          )
        })}
      </div>

      {mainWallet && onSyncMainWallet ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
          <div>
            {hasRealWalletBalance
              ? `Real wallet balance synced ${formatSyncTime(mainWallet.production.lastSyncedAt)} from ${mainWallet.name}.`
              : `${mainWallet.name} has not synced a real balance from Binance yet.`}
          </div>
          <button
            type="button"
            onClick={() => onSyncMainWallet(mainWallet.id)}
            disabled={isSyncingMainWallet}
            className="flex items-center gap-2 rounded-full border border-sky-300/25 bg-sky-400/10 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-sky-100 transition hover:border-sky-300/40 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-slate-400"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${isSyncingMainWallet ? 'animate-spin' : ''}`} />
            {isSyncingMainWallet ? 'Syncing...' : 'Sync Real Balance'}
          </button>
        </div>
      ) : null}

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
