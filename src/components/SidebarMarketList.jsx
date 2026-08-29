import { Search } from 'lucide-react'
import { formatCompactNumber, formatPercent, formatPrice } from '../lib/formatters'
import { VOLATILE_MARKET_SYMBOL_LIMIT } from '../lib/tradingConfig'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { PriceDirectionPill, getPriceDirectionMeta } from './PriceDirectionPill'

export function SidebarMarketList({ markets, selectedSymbol, onSelectSymbol }) {
  return (
    <Panel
      title="Markets"
      className="h-full"
      action={
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
          <Search className="h-3.5 w-3.5" />
          <span>Top {VOLATILE_MARKET_SYMBOL_LIMIT} score = volume x volatility</span>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-[1.05fr_1fr_0.8fr_0.75fr] px-3 text-[11px] uppercase tracking-[0.2em] text-slate-500">
          <span>Pair</span>
          <span className="text-right">Price</span>
          <span className="text-right">Score</span>
          <span className="text-right">24h</span>
        </div>
        <div className="space-y-2">
          {markets.map((market) => {
            const isActive = market.symbol === selectedSymbol
            const change = Number(market.priceChangePercent)
            const score = Number(market.tradeabilityScore)
            const positive = change >= 0
            const direction = market.tickDirection || 'flat'
            const directionMeta = getPriceDirectionMeta(direction)

            return (
              <button
                key={market.symbol}
                type="button"
                onClick={() => onSelectSymbol(market.symbol)}
                className={`grid w-full grid-cols-[1.05fr_1fr_0.8fr_0.75fr] items-center rounded-2xl border px-3 py-3 text-left transition ${
                  isActive
                    ? 'border-sky-400/50 bg-sky-400/10'
                    : 'border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.05]'
                }`}
              >
                <div className="flex items-center gap-3">
                  <CoinAvatar symbol={market.symbol} size="md" />
                  <div>
                    <div className="font-semibold text-white">{market.baseAsset}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-sm font-medium ${directionMeta.valueTone}`}>{formatPrice(market.lastPrice, 5)}</div>
                  <div className="mt-1 flex justify-end">
                    <PriceDirectionPill direction={direction} compact />
                  </div>
                </div>
                <div className="text-right text-sm font-medium text-sky-300">{formatCompactNumber(score, 1)}</div>
                <div className={`text-right text-sm font-medium ${positive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {formatPercent(change)}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </Panel>
  )
}
