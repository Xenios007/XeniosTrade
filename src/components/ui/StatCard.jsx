const VALUE_TONE = {
  default: 'text-white',
  up: 'text-emerald-300',
  down: 'text-rose-300',
  info: 'text-sky-300',
  warn: 'text-amber-300',
  muted: 'text-slate-300',
}

/**
 * Compact KPI tile. One border, one background — no nested cards.
 */
export function StatCard({ label, value, sublabel, tone = 'default', Icon }) {
  return (
    <div className="min-w-0 rounded-card border border-white/10 bg-slate-950/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
          {label}
        </span>
        {Icon ? <Icon className="h-4 w-4 shrink-0 text-slate-500" /> : null}
      </div>
      <div className={`mt-2 break-words text-xl font-semibold ${VALUE_TONE[tone] || VALUE_TONE.default}`}>
        {value}
      </div>
      {sublabel ? <div className="mt-1 truncate text-xs text-slate-400">{sublabel}</div> : null}
    </div>
  )
}

export function pnlTone(value) {
  const number = Number(value || 0)
  if (number > 0) return 'up'
  if (number < 0) return 'down'
  return 'default'
}
