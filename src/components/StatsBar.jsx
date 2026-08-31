import { Activity, BarChart3, CandlestickChart, ChevronDown, WalletCards } from 'lucide-react'
import { formatCompactNumber, formatPercent, formatPrice } from '../lib/formatters'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { PriceDirectionPill, getPriceDirectionMeta } from './PriceDirectionPill'

const statIcons = [CandlestickChart, Activity, WalletCards, BarChart3]

export function StatsBar({
  market,
  markets = [],
  selectedSymbol,
  onSelectSymbol,
  signalModels = [],
  activeSignalModelId,
  onSelectSignalModel,
  switchingSignalModel = false,
}) {
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

  const options = markets.length > 0
    ? markets
    : market
      ? [market]
      : []
  const showMarketSelector = Boolean(onSelectSymbol) && options.length > 0
  const showModelSelector = Boolean(onSelectSignalModel) && signalModels.length > 0

  return (
    <Panel
      title={market ? `${market.baseAsset}/${market.quoteAsset}` : 'Overview'}
      action={
        showMarketSelector || showModelSelector ? (
          <div className="flex flex-wrap items-center gap-2">
            {showMarketSelector ? (
              <label className="flex items-center gap-2">
                <span className="sr-only">Selected market</span>
                <span className="hidden sm:inline-flex">
                  <CoinAvatar symbol={selectedSymbol || market?.symbol} size="sm" />
                </span>
                <div className="relative">
                  <select
                    value={selectedSymbol || market?.symbol || ''}
                    onChange={(event) => onSelectSymbol(event.target.value)}
                    className="appearance-none rounded-xl border border-white/10 bg-slate-950/70 py-2 pl-3 pr-9 text-sm font-semibold text-white outline-none transition focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
                  >
                    {options.map((option) => (
                      <option key={option.symbol} value={option.symbol} className="bg-slate-900 text-white">
                        {option.baseAsset && option.quoteAsset
                          ? `${option.baseAsset}/${option.quoteAsset}`
                          : option.symbol}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                </div>
              </label>
            ) : null}

            {showModelSelector ? (
              <label className="flex items-center gap-2">
                <span className="sr-only">Chart signal model</span>
                <div className="relative">
                  <select
                    value={activeSignalModelId || ''}
                    onChange={(event) => onSelectSignalModel(event.target.value)}
                    disabled={switchingSignalModel}
                    className="appearance-none rounded-xl border border-sky-400/40 bg-sky-400/12 py-2 pl-3 pr-9 text-sm font-semibold text-sky-100 outline-none transition focus:border-sky-300/60 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {signalModels.map((model) => (
                      <option key={model.id} value={model.id} className="bg-slate-900 text-white">
                        {model.name}
                        {model.tag ? ` — ${model.tag}` : ''}
                        {model.status === 'blank' ? ' (no rules)' : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sky-200" />
                </div>
              </label>
            ) : null}
          </div>
        ) : null
      }
    >
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
