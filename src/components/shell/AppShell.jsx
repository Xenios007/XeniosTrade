import { useState } from 'react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

export function AppShell({
  symbol,
  symbols,
  onSelectSymbol,
  tradingMode,
  marketDataHealth,
  account,
  onLogout,
  loggingOut,
  children,
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="relative min-h-screen bg-slate-950 text-white">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.14),_transparent_26%),radial-gradient(circle_at_bottom_right,_rgba(34,197,94,0.07),_transparent_18%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-grid bg-[size:32px_32px] opacity-25"
      />

      <div className="relative flex min-h-screen">
        <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            symbol={symbol}
            symbols={symbols}
            onSelectSymbol={onSelectSymbol}
            tradingMode={tradingMode}
            marketDataHealth={marketDataHealth}
            account={account}
            onLogout={onLogout}
            loggingOut={loggingOut}
            onOpenNav={() => setMobileNavOpen(true)}
          />

          <main className="min-w-0 flex-1 px-4 py-6 lg:px-6">
            <div className="mx-auto w-full max-w-[1600px]">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}
