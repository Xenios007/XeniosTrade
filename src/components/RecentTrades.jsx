import { formatPrice, formatTradeTime } from '../lib/formatters'
import { Panel } from './Panel'

export function RecentTrades({ trades }) {
  return (
    <Panel title="Recent Trades">
      <div className="space-y-3">
        <div className="grid grid-cols-[0.9fr_0.8fr_0.8fr] px-1 text-[11px] uppercase tracking-[0.2em] text-slate-500">
          <span>Time</span>
          <span className="text-right">Price</span>
          <span className="text-right">Qty</span>
        </div>
        <div className="space-y-2">
          {trades.map((trade) => (
            <div key={trade.id} className="grid grid-cols-[0.9fr_0.8fr_0.8fr] rounded-2xl border border-white/5 bg-white/[0.03] px-3 py-3 text-sm">
              <span className="text-slate-400">{formatTradeTime(trade.time)}</span>
              <span className={`text-right ${trade.isBuyerMaker ? 'text-rose-400' : 'text-emerald-400'}`}>
                {formatPrice(trade.price, 5)}
              </span>
              <span className="text-right text-slate-300">{Number(trade.qty).toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}
