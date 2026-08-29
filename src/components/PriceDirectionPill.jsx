import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

const DIRECTION_META = {
  up: {
    Icon: ArrowUpRight,
    label: 'Price is moving up',
    tone: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
    valueTone: 'text-emerald-300',
  },
  down: {
    Icon: ArrowDownRight,
    label: 'Price is moving down',
    tone: 'border-rose-400/20 bg-rose-400/10 text-rose-300',
    valueTone: 'text-rose-300',
  },
  flat: {
    Icon: Minus,
    label: 'Price is unchanged',
    tone: 'border-white/10 bg-white/[0.04] text-slate-300',
    valueTone: 'text-slate-100',
  },
}

export function getPriceDirectionMeta(direction = 'flat') {
  return DIRECTION_META[direction] || DIRECTION_META.flat
}

export function PriceDirectionPill({ direction = 'flat', compact = false }) {
  const meta = getPriceDirectionMeta(direction)
  const { Icon, label, tone } = meta

  return (
    <span
      aria-label={label}
      title={label}
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${tone} ${
        compact ? 'h-6 w-6 justify-center text-[10px]' : 'h-7 w-7 justify-center text-xs'
      }`}
    >
      <Icon className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </span>
  )
}
