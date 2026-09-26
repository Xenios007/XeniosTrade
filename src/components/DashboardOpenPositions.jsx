import { Link } from 'react-router-dom'
import { getTradeUnrealizedPnl } from '../lib/accountMetrics'
import { formatPrice } from '../lib/formatters'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { TradeDirectionBadge } from './TradeDirectionBadge'

const MAX_VISIBLE_POSITIONS = 6

function formatSignedUsdt(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function pnlTone(value) {
  const number = Number(value || 0)
  if (number > 0) return 'text-emerald-300'
  if (number < 0) return 'text-rose-300'
  return 'text-slate-300'
}

/** Dashboard-only compact open-positions list - full detail/filtering/sorting lives on Trade History. */
export function DashboardOpenPositions({ trades = [], livePrices = {} }) {
  const openTrades = trades.filter((trade) => trade.status === 'OPEN')

  return (
    <Panel
      title={`Open Positions (${openTrades.length})`}
      action={<Link to="/trade-history" className="text-xs font-semibold text-sky-300 hover:underline">View all</Link>}
    >
      {openTrades.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-400">No open positions right now.</div>
      ) : (
        <div className="grid gap-2">
          {openTrades.slice(0, MAX_VISIBLE_POSITIONS).map((trade) => {
            const currentPrice = Number(livePrices?.[trade.symbol] || 0)
            const unrealizedPnl = currentPrice ? getTradeUnrealizedPnl(trade, currentPrice) : null

            return (
              <div
                key={trade.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <CoinAvatar symbol={trade.symbol} size="sm" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{trade.symbol}</span>
                      <TradeDirectionBadge side={trade.side} />
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">
                      {trade.walletName || 'Unassigned wallet'} · Entry {formatPrice(trade.entryPrice, 5)}
                    </div>
                  </div>
                </div>
                <div className={`text-right text-sm font-semibold ${pnlTone(unrealizedPnl)}`}>
                  {unrealizedPnl == null ? 'Live price pending' : formatSignedUsdt(unrealizedPnl)}
                </div>
              </div>
            )
          })}
          {openTrades.length > MAX_VISIBLE_POSITIONS ? (
            <Link
              to="/trade-history"
              className="block rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-2 text-center text-xs font-semibold text-sky-300 hover:underline"
            >
              +{openTrades.length - MAX_VISIBLE_POSITIONS} more open positions
            </Link>
          ) : null}
        </div>
      )}
    </Panel>
  )
}
