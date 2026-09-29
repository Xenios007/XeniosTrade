import { getEffectiveSignalModelStrategy, getSignalModel } from '../lib/signalModels'
import { formatDateTimeWithSeconds, formatPrice } from '../lib/formatters'
import { AutoTradeActivityView } from './AutoTradeActivityView'
import { Panel } from './Panel'
import { PageHeader } from './ui/PageHeader'
import { TradeDirectionBadge } from './TradeDirectionBadge'
import { CoinAvatar } from './CoinAvatar'

// SaaS Phase 8E: collapsed from a 3-tab shell (Signal Models / Auto Trade Controller / Auto
// Trade Activity) to a flat page matching Real Money Trading's layout. Signal Models was
// dropped - the same bot picker already lives on Market's dropdown (StatsBar.jsx). Auto Trade
// Controller's symbol-universe display moved to Settings > Automation's new symbol picker
// (Phase 8C) - a regular user picks their own symbols there now, not here.

function formatWinRate(winRate, closedTrades) {
  if (!closedTrades) {
    return 'No closed trades yet'
  }

  return `${(winRate * 100).toFixed(2)}% win rate`
}

function getRuntimeLabel(autoTradePhase) {
  if (autoTradePhase === 'running') {
    return 'Scanning Live'
  }

  if (autoTradePhase === 'stopping') {
    return 'Stopping'
  }

  if (autoTradePhase === 'starting') {
    return 'Starting'
  }

  return 'Standing By'
}

function getWinRateTone(winRate, closedTrades) {
  if (!closedTrades) {
    return 'text-slate-200'
  }

  if (winRate >= 0.55) {
    return 'text-emerald-300'
  }

  if (winRate >= 0.45) {
    return 'text-amber-200'
  }

  return 'text-rose-300'
}

export function MockTradingPage({
  analysis,
  settings,
  autoTradeStatus,
  autoTradeLog,
  autoTradeFeedback,
  activeSignalModelId,
  signalModelPerformance,
  tradingMode,
  autoTradePhase,
}) {
  const latestAutoOrder = autoTradeLog.find((entry) => entry.result?.order)?.result.order || null
  const activeModel = getSignalModel(activeSignalModelId)
  const activeModelStrategy = getEffectiveSignalModelStrategy(settings.strategy, activeSignalModelId)
  const activeModelStats = signalModelPerformance[activeModel.id] || {
    tradeCount: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    pnl: 0,
  }

  const isRunning = autoTradePhase === 'running'
  const isStopping = autoTradePhase === 'stopping'
  const isStarting = autoTradePhase === 'starting'
  const statusTone = isRunning
    ? 'bg-emerald-400/12 text-emerald-300 border-emerald-400/20'
    : isStopping
      ? 'bg-rose-400/12 text-rose-300 border-rose-400/20'
      : isStarting
        ? 'bg-amber-400/12 text-amber-300 border-amber-400/20'
        : 'bg-slate-900 text-slate-300 border-white/10'

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Mock Trading"
        description="Your bots trading testnet paper - what's running, the latest decision, and the full activity log."
      />

      <Panel title="Mock Trading Summary">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">System</div>
            <div className="mt-2 text-lg font-semibold text-white">{autoTradeStatus.enabled ? 'Ready To Trade' : 'Paused'}</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Bot In Focus</div>
            <div className="mt-2 text-lg font-semibold text-white">{activeModel.name}</div>
            <div className="mt-1 text-xs text-slate-400">{activeModel.tag}</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Today</div>
            <div className="mt-2 text-lg font-semibold text-white">{autoTradeStatus.today?.tradeCount || 0}</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Model Win Rate</div>
            <div className={`mt-2 text-lg font-semibold ${getWinRateTone(activeModelStats.winRate, activeModelStats.closedTrades)}`}>{formatWinRate(activeModelStats.winRate, activeModelStats.closedTrades)}</div>
            <div className="mt-1 text-xs text-slate-400">{activeModelStats.tradeCount} tracked auto trades</div>
          </div>
          <div className={`rounded-2xl border p-4 ${statusTone}`}>
            <div className="text-xs uppercase tracking-[0.24em] opacity-70">Scanner</div>
            <div className="mt-2 text-lg font-semibold">{getRuntimeLabel(autoTradePhase)}</div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
            Analysis focus: {analysis.symbol} {analysis.direction} at {analysis.entryPrice ? formatPrice(analysis.entryPrice, 5) : 'N/A'}
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
            Futures sizing: {activeModelStrategy.marginPerTrade} margin x {activeModelStrategy.leverage} leverage
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
            Mode: {tradingMode}
          </div>
          {latestAutoOrder ? (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
              <span>Latest auto order:</span>
              <CoinAvatar symbol={latestAutoOrder.symbol} size="sm" />
              <span className="font-semibold text-white">{latestAutoOrder.symbol}</span>
              <TradeDirectionBadge side={latestAutoOrder.side} />
              {latestAutoOrder.walletName ? (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-100">
                  {latestAutoOrder.walletName}
                </span>
              ) : null}
              {latestAutoOrder.signalModelName ? (
                <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-sky-200">
                  {latestAutoOrder.signalModelName}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {autoTradeFeedback ? (
          <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
            autoTradeFeedback.type === 'success'
              ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
              : autoTradeFeedback.type === 'warning'
                ? 'border-amber-400/20 bg-amber-400/10 text-amber-100'
                : 'border-rose-400/20 bg-rose-400/10 text-rose-200'
          }`}>
            {autoTradeFeedback.message}
          </div>
        ) : null}
      </Panel>

      <Panel title="Mock Trading Status">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Last Scheduler Check</div>
            <div className="mt-2 text-slate-100">
              {autoTradeStatus.lastRunAt ? formatDateTimeWithSeconds(autoTradeStatus.lastRunAt) : 'No check recorded yet'}
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Last Decision</div>
            <div className="mt-2 text-slate-100">{autoTradeStatus.lastReason || 'No decision recorded yet'}</div>
          </div>
        </div>
      </Panel>

      <AutoTradeActivityView autoTradeLog={autoTradeLog} />
    </div>
  )
}
