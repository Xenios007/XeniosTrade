export function BrandMark({ className = 'h-14 w-14' }) {
  return (
    <svg viewBox="0 0 88 88" className={`shrink-0 ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id="xenios-ring" x1="10%" y1="10%" x2="90%" y2="90%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#14b8a6" />
        </linearGradient>
        <linearGradient id="xenios-candle" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="100%" stopColor="#cbd5e1" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="80" height="80" rx="24" fill="rgba(15,23,42,0.92)" stroke="url(#xenios-ring)" strokeWidth="3.5" />
      <path d="M21 58C28 49 35 46 43 48C52 50 57 35 68 28" fill="none" stroke="url(#xenios-ring)" strokeWidth="5" strokeLinecap="round" />
      <path d="M28 25V56" stroke="#22c55e" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="23.5" y="33" width="9" height="15" rx="4.5" fill="#22c55e" />
      <path d="M44 20V50" stroke="url(#xenios-candle)" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="39.5" y="26" width="9" height="18" rx="4.5" fill="url(#xenios-candle)" />
      <path d="M60 34V64" stroke="#f43f5e" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="55.5" y="40" width="9" height="16" rx="4.5" fill="#f43f5e" />
    </svg>
  )
}
