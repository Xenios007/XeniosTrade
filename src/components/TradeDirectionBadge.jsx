import { Radar, TrendingDown, TrendingUp } from 'lucide-react'
import { getTradeDirection } from '../lib/trades'

function getDirectionTone(direction) {
  if (direction === 'LONG') {
    return {
      className: 'border-emerald-400/20 bg-emerald-400/12 text-emerald-300',
      Icon: TrendingUp,
    }
  }

  if (direction === 'SHORT') {
    return {
      className: 'border-rose-400/20 bg-rose-400/12 text-rose-300',
      Icon: TrendingDown,
    }
  }

  return {
    className: 'border-amber-400/20 bg-amber-400/12 text-amber-300',
    Icon: Radar,
  }
}

export function TradeDirectionBadge({ side, direction: providedDirection }) {
  const direction = providedDirection || getTradeDirection(side)
  const tone = getDirectionTone(direction)
  const Icon = tone.Icon

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${tone.className}`}>
      <Icon className="h-3.5 w-3.5" />
      {direction}
    </span>
  )
}
