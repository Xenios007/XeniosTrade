import { Activity, Bot, Clock3, ScanSearch } from 'lucide-react'
import { formatDateTimeWithSeconds } from '../lib/formatters'
import { formatTradeSource } from '../lib/trades'
import { usePersistentBoolean } from '../lib/usePersistentBoolean'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { TradeDirectionBadge } from './TradeDirectionBadge'

function getRuntimeLabel(autoTradePhase, running) {
  if (autoTradePhase === 'running') {
    return 'Running'
  }

  if (autoTradePhase === 'stopping') {
    return 'Stopping'
  }

  if (autoTradePhase === 'starting') {
    return 'Starting'
  }

  return running ? 'Running' : 'Idle'
}

export function AutoTradeStatusPanel({
  autoTradeStatus,
  autoTradePhase,
  trackedSymbols,
  latestAutoOrder,
}) {
  const [showTrackedSymbols, setShowTrackedSymbols] = usePersistentBoolean(
    'dashboard:auto-trade-status:tracked-symbols:expanded',
    false,
  )
  const runtimeLabel = getRuntimeLabel(autoTradePhase, autoTradeStatus.running)
  const runtimeTone = runtimeLabel === 'Running'
    ? 'border-emerald-400/20 bg-emerald-400/12 text-emerald-300'
    : runtimeLabel === 'Stopping'
      ? 'border-rose-400/20 bg-rose-400/12 text-rose-300'
      : runtimeLabel === 'Starting'
        ? 'border-amber-400/20 bg-amber-400/12 text-amber-300'
        : 'border-white/10 bg-slate-950/60 text-slate-200'

  return (
    <Panel title="Auto Trade Status" action={<Bot className="h-4 w-4 text-sky-300" />}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs uppercase tracking-[0.24em] text-slate-500">System</span>
            <Activity className="h-4 w-4 text-sky-300" />
          </div>
          <div className="text-xl font-semibold text-white">{autoTradeStatus.enabled ? 'Enabled' : 'Disabled'}</div>
        </div>

        <div className={`rounded-2xl border p-4 ${runtimeTone}`}>
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs uppercase tracking-[0.24em] opacity-70">Runtime</span>
            <Clock3 className="h-4 w-4" />
          </div>
          <div className="text-xl font-semibold">{runtimeLabel}</div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs uppercase tracking-[0.24em] text-slate-500">Today Auto Trades</span>
            <Activity className="h-4 w-4 text-sky-300" />
          </div>
          <div className="text-xl font-semibold text-white">{autoTradeStatus.today?.tradeCount || 0}</div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs uppercase tracking-[0.24em] text-slate-500">Tracked Symbols</span>
            <ScanSearch className="h-4 w-4 text-sky-300" />
          </div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-white">{trackedSymbols.length} active pairs</div>
            {trackedSymbols.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowTrackedSymbols((current) => !current)}
                className="rounded-full border border-sky-300/20 bg-slate-950/35 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-sky-100 transition hover:border-sky-300/40 hover:bg-slate-950/50"
              >
                {showTrackedSymbols ? 'Hide Coins' : `View ${trackedSymbols.length} Coins`}
              </button>
            ) : null}
          </div>
          {showTrackedSymbols ? (
            <div className="flex flex-wrap gap-2">
              {trackedSymbols.map((symbol) => (
                <span
                  key={symbol}
                  className="inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-200"
                >
                  <CoinAvatar symbol={symbol} size="xs" />
                  {symbol}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
          <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Latest Auto Order</div>
          {latestAutoOrder ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <CoinAvatar symbol={latestAutoOrder.symbol} size="md" />
              <div className="text-lg font-semibold text-white">{latestAutoOrder.symbol}</div>
              <TradeDirectionBadge side={latestAutoOrder.side} />
              <div className="text-sm text-slate-400">{formatTradeSource(latestAutoOrder.source)}</div>
              {latestAutoOrder.walletName ? (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-100">
                  {latestAutoOrder.walletName}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 text-sm text-slate-400">No automated order has been recorded yet.</div>
          )}
          {latestAutoOrder?.signalSummary ? (
            <div className="mt-3 text-sm text-slate-300">{latestAutoOrder.signalSummary}</div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
          <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Last Scheduler Check</div>
          <div className="mt-3 text-sm font-medium text-slate-100">
            {autoTradeStatus.lastRunAt ? formatDateTimeWithSeconds(autoTradeStatus.lastRunAt) : 'No check recorded yet'}
          </div>
          <div className="mt-3 text-sm text-slate-300">{autoTradeStatus.lastReason || 'No decision recorded yet'}</div>
        </div>
      </div>
    </Panel>
  )
}
