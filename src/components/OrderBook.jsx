import { formatPrice } from '../lib/formatters'
import { Panel } from './Panel'

function DepthList({ title, entries, colorClass }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
      <div className="mb-3 text-xs uppercase tracking-[0.22em] text-slate-500">{title}</div>
      <div className="space-y-2">
        {entries.map(([price, quantity]) => (
          <div key={`${title}-${price}`} className="grid grid-cols-2 text-sm">
            <span className={colorClass}>{formatPrice(price, 5)}</span>
            <span className="text-right text-slate-300">{Number(quantity).toFixed(4)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function OrderBook({ asks, bids }) {
  return (
    <Panel title="Order Book">
      <div className="grid gap-4 xl:grid-cols-2">
        <DepthList title="Asks" entries={asks} colorClass="text-rose-400" />
        <DepthList title="Bids" entries={bids} colorClass="text-emerald-400" />
      </div>
    </Panel>
  )
}
