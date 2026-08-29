import { Activity, Bot, Layers, Scale, TrendingUp, Wallet } from 'lucide-react'
import { StatCard, pnlTone } from './ui/StatCard'

function usdt(value) {
  return `${Number(value || 0).toFixed(2)} USDT`
}

function signedUsdt(value) {
  const number = Number(value || 0)
  return `${number > 0 ? '+' : ''}${number.toFixed(2)} USDT`
}

/**
 * Six-tile KPI row for the dashboard, from the same summarizeAccount() data
 * the trade-history page already uses, plus today's auto-trade counters.
 */
export function DashboardKpis({ account, autoTradeStatus }) {
  const winRate = account.closedTradeCount > 0
    ? (account.wins / account.closedTradeCount) * 100
    : 0
  const balanceTone = account.runningBalance > account.startingBalance
    ? 'up'
    : account.runningBalance < account.startingBalance
      ? 'down'
      : 'default'
  const todayTrades = autoTradeStatus?.today?.tradeCount || 0
  const todayLosses = autoTradeStatus?.today?.lossCount || 0

  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <StatCard
        label="Running Balance"
        value={usdt(account.runningBalance)}
        sublabel={`Start ${usdt(account.startingBalance)}`}
        tone={balanceTone}
        Icon={Wallet}
      />
      <StatCard
        label="Realized P/L"
        value={signedUsdt(account.realizedPnl)}
        sublabel={`${account.wins}W / ${account.losses}L`}
        tone={pnlTone(account.realizedPnl)}
        Icon={TrendingUp}
      />
      <StatCard
        label="Unrealized P/L"
        value={signedUsdt(account.unrealizedPnl)}
        sublabel={`${account.openTradeCount} open`}
        tone={pnlTone(account.unrealizedPnl)}
        Icon={Scale}
      />
      <StatCard
        label="Win Rate"
        value={`${winRate.toFixed(1)}%`}
        sublabel={`${account.closedTradeCount} closed trades`}
        tone={account.closedTradeCount === 0 ? 'muted' : winRate >= 50 ? 'up' : 'warn'}
        Icon={Activity}
      />
      <StatCard
        label="Open Positions"
        value={String(account.openTradeCount)}
        sublabel={account.openTradeCount > 0 ? 'Being monitored' : 'None active'}
        tone={account.openTradeCount > 0 ? 'warn' : 'default'}
        Icon={Layers}
      />
      <StatCard
        label="Auto Trades Today"
        value={String(todayTrades)}
        sublabel={`${todayLosses} losing`}
        tone={todayLosses > 0 ? 'down' : 'info'}
        Icon={Bot}
      />
    </div>
  )
}
