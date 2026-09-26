import { Link } from 'react-router-dom'
import { formatDateTimeWithSeconds } from '../lib/formatters'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { TradeDirectionBadge } from './TradeDirectionBadge'

const MAX_VISIBLE_ENTRIES = 5

/** Dashboard-only condensed feed - the full step-by-step log lives on Mock Trading > Auto Trade Activity. */
export function DashboardActivityFeed({ autoTradeLog = [] }) {
  const entries = autoTradeLog.slice(0, MAX_VISIBLE_ENTRIES)

  return (
    <Panel
      title="Recent Activity"
      action={<Link to="/mock-trading/auto-trade-activity" className="text-xs font-semibold text-sky-300 hover:underline">Full log</Link>}
    >
      {entries.length === 0 ? (
        <div className="py-6 text-center text-sm text-slate-400">No auto-trade runs recorded yet.</div>
      ) : (
        <div className="grid gap-2">
          {entries.map((entry) => {
            const order = entry.result?.order
            return (
              <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  {order ? <CoinAvatar symbol={order.symbol} size="sm" /> : null}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {order ? <span className="font-semibold text-white">{order.symbol}</span> : null}
                      {order ? <TradeDirectionBadge side={order.side} /> : null}
                      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.16em] ${
                        entry.result?.executed ? 'bg-emerald-400/12 text-emerald-300' : 'bg-amber-400/12 text-amber-300'
                      }`}>
                        {entry.result?.executed ? 'Order Sent' : 'No Trade'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">{entry.result?.reason}</div>
                  </div>
                </div>
                <div className="shrink-0 text-xs uppercase tracking-[0.16em] text-slate-500">
                  {formatDateTimeWithSeconds(entry.timestamp)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
