const TONES = {
  neutral: 'border-white/10 bg-white/[0.04] text-slate-200',
  info: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
  up: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  down: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
  warn: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
}

export function Badge({ tone = 'neutral', children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
        TONES[tone] || TONES.neutral
      } ${className}`}
    >
      {children}
    </span>
  )
}
