import { LogOut, Menu } from 'lucide-react'
import { CoinAvatar } from '../CoinAvatar'
import { BrandMark } from '../BrandMark'

function formatUsdt(value) {
  const number = Number(value || 0)
  return `${number.toFixed(2)} USDT`
}

function formatSignedUsdt(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function pnlTone(value) {
  const number = Number(value || 0)
  if (number > 0) return 'text-emerald-300'
  if (number < 0) return 'text-rose-300'
  return 'text-slate-200'
}

function MarketDataDot({ health }) {
  const degraded = Boolean(health?.degraded)
  const hasSignal = health && typeof health.successes === 'number'
  const tone = !hasSignal
    ? 'bg-slate-500'
    : degraded
      ? 'bg-amber-400'
      : 'bg-emerald-400'
  const label = !hasSignal
    ? 'Market data: status unknown'
    : degraded
      ? 'Market data: degraded (upstream rate-limited or failing)'
      : 'Market data: healthy'

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300"
      title={label}
    >
      <span className={`h-2 w-2 rounded-full ${tone} ${hasSignal && !degraded ? 'animate-pulse' : ''}`} />
      <span className="hidden sm:inline">Feed</span>
    </span>
  )
}

export function TopBar({
  symbol,
  symbols = [],
  onSelectSymbol,
  tradingMode,
  marketDataHealth,
  account,
  onLogout,
  loggingOut,
  onOpenNav,
}) {
  const symbolOptions = symbols.length > 0 ? symbols : symbol ? [symbol] : []

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          className="rounded-xl border border-white/10 p-2 text-slate-300 hover:text-white lg:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 lg:hidden">
          <BrandMark className="h-7 w-7" />
        </div>

        <label className="flex items-center gap-2">
          <span className="sr-only">Selected market</span>
          <span className="hidden sm:inline-flex">
            <CoinAvatar symbol={symbol} size="sm" />
          </span>
          <select
            value={symbol}
            onChange={(event) => onSelectSymbol?.(event.target.value)}
            className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-1.5 text-sm font-semibold text-white outline-none transition focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
          >
            {symbolOptions.map((option) => (
              <option key={option} value={option} className="bg-slate-900 text-white">
                {option}
              </option>
            ))}
          </select>
        </label>

        {tradingMode ? (
          <span className="hidden rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-300 md:inline-flex">
            {tradingMode}
          </span>
        ) : null}

        <MarketDataDot health={marketDataHealth} />

        <div className="ml-auto flex items-center gap-3">
          {account ? (
            <div className="hidden text-right sm:block">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Balance</div>
              <div className="text-sm font-semibold text-white">{formatUsdt(account.runningBalance)}</div>
            </div>
          ) : null}
          {account ? (
            <div className="hidden text-right md:block">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Realized P/L</div>
              <div className={`text-sm font-semibold ${pnlTone(account.realizedPnl)}`}>
                {formatSignedUsdt(account.realizedPnl)}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm font-semibold text-white transition hover:border-white/20 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">{loggingOut ? 'Signing out...' : 'Logout'}</span>
          </button>
        </div>
      </div>
    </header>
  )
}
