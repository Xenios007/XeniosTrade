import { Activity, BarChart3, CandlestickChart, WalletCards } from 'lucide-react'
import { formatCompactNumber, formatPercent, formatPrice } from '../lib/formatters'
import { Panel } from './Panel'
import { PriceDirectionPill, getPriceDirectionMeta } from './PriceDirectionPill'

const statIcons = [CandlestickChart, Activity, WalletCards, BarChart3]

export function StatsBar({ market }) {
  const priceDirectionMeta = getPriceDirectionMeta(market?.tickDirection)
  const stats = [
    {
      label: 'Last Price',
      value: formatPrice(market?.lastPrice, 5),
      tone: priceDirectionMeta.valueTone,
      extra: <div className="mt-3"><PriceDirectionPill direction={market?.tickDirection} /></div>,
    },
    { label: '24h Change', value: formatPercent(market?.priceChangePercent), tone: Number(market?.priceChangePercent) >= 0 ? 'text-emerald-400' : 'text-rose-400' },
    { label: '24h Volume', value: formatCompactNumber(market?.volume, 2), tone: 'text-slate-100' },
    { label: 'Quote Volume', value: formatCompactNumber(market?.quoteVolume, 2), tone: 'text-slate-100' },
  ]

  return (
    <Panel title={market ? `${market.baseAsset}/${market.quoteAsset}` : 'Overview'}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat, index) => {
          const Icon = statIcons[index]

          return (
            <div key={stat.label} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs uppercase tracking-[0.24em] text-slate-500">{stat.label}</span>
                <Icon className="h-4 w-4 text-sky-300" />
              </div>
              <div className={`text-xl font-semibold ${stat.tone}`}>{stat.value}</div>
              {stat.extra || null}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
