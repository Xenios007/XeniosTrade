import { Lock, Plus, Radar, TrendingDown, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatPrice } from '../lib/formatters'
import { getSignalModel, visibleSignalModels } from '../lib/signalModels'
import { Panel } from './Panel'

const EMPTY_MODEL_STATS = {
  tradeCount: 0,
  closedTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  pnl: 0,
}

function formatWinRate(winRate, closedTrades) {
  if (!closedTrades) {
    return 'No closed trades'
  }

  return `${(Number(winRate || 0) * 100).toFixed(0)}% win`
}

function formatSignedUsdt(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function isFinitePrice(value) {
  return Number.isFinite(Number(value))
}

function getAiStatusMeta(aiAdvisory = null) {
  if (!aiAdvisory) {
    return {
      label: 'AI Offline',
      tone: 'border-white/10 bg-white/[0.03] text-slate-300',
      score: 'N/A',
      detail: 'AI advisory is still loading for this bot.',
    }
  }

  if (aiAdvisory.status === 'accept') {
    return {
      label: 'AI Accept',
      tone: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
      score: `${aiAdvisory.finalScore}/${aiAdvisory.thresholdScore}`,
      detail: aiAdvisory.detail,
    }
  }

  if (aiAdvisory.status === 'caution') {
    return {
      label: 'AI Skip',
      tone: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      score: `${aiAdvisory.finalScore}/${aiAdvisory.thresholdScore}`,
      detail: aiAdvisory.detail,
    }
  }

  if (aiAdvisory.status === 'waiting') {
    return {
      label: 'AI Waiting',
      tone: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      score: 'Standby',
      detail: aiAdvisory.detail,
    }
  }

  return {
    label: 'AI Training',
    tone: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    score: 'Needs data',
    detail: aiAdvisory.detail || 'AI is still preparing its advisory policy.',
  }
}

function getModelDirectionMeta(model, analysis) {
  if (model.status === 'blank') {
    return {
      label: 'Blank Slot',
      Icon: Lock,
    }
  }

  if (analysis?.ready) {
    return analysis.checklistSide === 'SHORT'
      ? { label: 'Short Ready', Icon: TrendingDown }
      : { label: 'Long Ready', Icon: TrendingUp }
  }

  if (analysis?.checklistSide === 'SHORT') {
    return {
      label: 'Short Bias',
      Icon: TrendingDown,
    }
  }

  if (analysis?.checklistSide === 'LONG') {
    return {
      label: 'Long Bias',
      Icon: TrendingUp,
    }
  }

  return {
    label: 'Watching',
    Icon: Radar,
  }
}

function getModelTone(model, analysis, isActive) {
  if (model.status === 'blank') {
    return {
      card: `border-white/10 bg-slate-950/88 ${isActive ? 'shadow-[0_0_0_1px_rgba(148,163,184,0.18)]' : ''}`,
      badge: 'border-white/10 bg-white/[0.04] text-slate-400',
      fill: 'bg-slate-500/70',
      signalOn: 'bg-slate-400/80',
      signalOff: 'bg-white/10',
    }
  }

  if (analysis?.checklistSide === 'SHORT') {
    return {
      card: `${isActive ? 'border-rose-300/40 bg-rose-400/12 shadow-[0_0_0_1px_rgba(251,113,133,0.18)]' : 'border-rose-400/20 bg-slate-950/86'}`,
      badge: analysis?.ready
        ? 'border-rose-300/30 bg-rose-400/15 text-rose-200'
        : 'border-rose-400/20 bg-rose-400/10 text-rose-200',
      fill: analysis?.ready ? 'bg-rose-300' : 'bg-rose-400/85',
      signalOn: analysis?.ready ? 'bg-rose-300' : 'bg-rose-400/80',
      signalOff: 'bg-white/10',
    }
  }

  if (analysis?.checklistSide === 'LONG') {
    return {
      card: `${isActive ? 'border-emerald-300/40 bg-emerald-400/12 shadow-[0_0_0_1px_rgba(110,231,183,0.18)]' : 'border-emerald-400/20 bg-slate-950/86'}`,
      badge: analysis?.ready
        ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-200'
        : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
      fill: analysis?.ready ? 'bg-emerald-300' : 'bg-emerald-400/85',
      signalOn: analysis?.ready ? 'bg-emerald-300' : 'bg-emerald-400/80',
      signalOff: 'bg-white/10',
    }
  }

  return {
    card: `${isActive ? 'border-sky-300/40 bg-sky-400/12 shadow-[0_0_0_1px_rgba(125,211,252,0.18)]' : 'border-sky-400/20 bg-slate-950/86'}`,
    badge: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
    fill: 'bg-sky-400/85',
    signalOn: 'bg-sky-400/80',
    signalOff: 'bg-white/10',
  }
}

function getSignalSlots(model, analysis) {
  if (Array.isArray(analysis?.checklist) && analysis.checklist.length > 0) {
    return analysis.checklist.map((signal) => ({
      key: signal.key,
      passed: Boolean(signal.passed),
    }))
  }

  const fallbackCount = Math.max(model.totalSignals || 0, model.status === 'blank' ? 3 : 4)
  return Array.from({ length: fallbackCount }, (_, index) => ({
    key: `${model.id}-placeholder-${index}`,
    passed: false,
  }))
}

function getModelStatusLine(model, analysis) {
  if (model.status === 'blank') {
    return 'No live rules yet.'
  }

  if (!analysis) {
    return 'Loading live scan...'
  }

  if (analysis.ready) {
    return `${analysis.checklistSide} entry conditions aligned.`
  }

  const firstMissingSignal = analysis.checklist?.find((signal) => !signal.passed)
  if (firstMissingSignal) {
    return `Next: ${firstMissingSignal.label}`
  }

  return `${analysis.score}/${analysis.maxScore} signals active.`
}

// Custom bots share the native cards' layout but use a violet palette (long/short bias tints the
// score bar the same way native cards do) so they read as "yours" at a glance. Their live state
// comes from the same analysis the preview endpoint runs; auto-trading for them isn't wired yet.
function CustomBotStatusCard({ bot, symbol, onOpen }) {
  const [preview, setPreview] = useState(null)
  const definitionKey = JSON.stringify([bot.componentSignalItems, bot.combinationMode, bot.minimumAligned, bot.riskSourceModelId])

  useEffect(() => {
    let ignore = false
    async function load() {
      try {
        const response = await fetch(`/api/custom-bots/${encodeURIComponent(bot.id)}/preview?symbol=${encodeURIComponent(symbol)}`)
        if (!response.ok) return
        const payload = await response.json()
        if (!ignore) setPreview(payload.preview || null)
      } catch {
        // keep the last good preview
      }
    }
    load()
    const timer = setInterval(load, 30000)
    return () => { ignore = true; clearInterval(timer) }
  }, [bot.id, definitionKey, symbol])

  const side = preview?.side === 'SHORT' ? 'SHORT' : preview?.side === 'LONG' ? 'LONG' : null
  const ready = Boolean(preview?.ready)
  const DirectionIcon = side === 'SHORT' ? TrendingDown : side === 'LONG' ? TrendingUp : Radar
  const directionLabel = ready
    ? (side === 'SHORT' ? 'Short Ready' : 'Long Ready')
    : side ? (side === 'SHORT' ? 'Short Bias' : 'Long Bias') : 'Watching'
  const score = Number(preview?.score || 0)
  const maxScore = Number(preview?.maxScore || bot.componentSignalItems.length || 0)
  const progressPercent = maxScore > 0 ? Math.max(0, Math.min(100, (score / maxScore) * 100)) : 0
  const slots = Array.isArray(preview?.checklist) && preview.checklist.length > 0
    ? preview.checklist.map((item) => ({ key: `${item.modelId}:${item.key}`, passed: Boolean(item.passed) }))
    : bot.componentSignalItems.map((item) => ({ key: `${item.modelId}:${item.key}`, passed: false }))
  const missing = preview?.checklist?.find((item) => !item.passed)
  const statusLine = !preview
    ? 'Loading live scan...'
    : ready
      ? `${side || 'Entry'} conditions aligned.`
      : missing ? `Next: ${missing.label}` : preview.summary
  const modelCount = new Set(bot.componentSignalItems.map((item) => item.modelId)).size

  return (
    <div
      role="link"
      tabIndex={0}
      title="Open in Bot Creation"
      onClick={() => onOpen(bot.id)}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen(bot.id) }}
      className="cursor-pointer rounded-2xl border border-violet-400/25 bg-violet-400/[0.07] px-4 py-3 backdrop-blur-md transition hover:border-violet-300/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-violet-300/70">Custom bot</div>
          <div className="mt-1 truncate text-sm font-semibold text-white">{bot.name}</div>
        </div>
        <span className="rounded-full border border-violet-300/30 bg-violet-400/15 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-100">
          Deployed
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${
          ready ? 'border-violet-300/30 bg-violet-400/20 text-violet-100' : 'border-violet-400/20 bg-violet-400/10 text-violet-200'
        }`}>
          <DirectionIcon className="h-3.5 w-3.5" />
          {directionLabel}
        </span>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Live Score</div>
          <div className="mt-1 text-sm font-semibold text-white">{maxScore > 0 ? `${score}/${maxScore}` : '0/0'}</div>
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-all ${ready ? 'bg-violet-300' : 'bg-violet-400/85'}`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${slots.length || 1}, minmax(0, 1fr))` }}>
        {slots.map((slot) => (
          <div key={slot.key} className={`h-1.5 rounded-full ${slot.passed ? 'bg-violet-300' : 'bg-white/10'}`} />
        ))}
      </div>

      <div className="mt-3 text-xs text-slate-300">{statusLine}</div>

      <div className="mt-3 rounded-xl border border-violet-400/20 bg-violet-400/10 px-3 py-3 text-violet-100">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-80">
            {bot.combinationMode === 'THRESHOLD' ? `${bot.minimumAligned} of ${bot.componentSignalItems.length} aligned` : 'All must align'}
          </div>
          <div className="text-[11px] font-semibold">{symbol}</div>
        </div>
        <div className="mt-2 text-[11px] leading-5 opacity-90">
          {bot.componentSignalItems.length} signals from {modelCount} bots - risk from {getSignalModel(bot.riskSourceModelId).name}.
        </div>
      </div>

      <div className="mt-2 text-[11px] text-slate-500">Live signal preview only - auto-trading for custom bots isn't wired up yet.</div>
    </div>
  )
}

/**
 * All registered bot status cards. Extracted from the candlestick chart so
 * the dashboard Overview tab includes Wallet 10 / consolidated visibility.
 */
export function BotStatusGrid({
  modelAnalyses = {},
  signalModelPerformance = {},
  activeSignalModelId,
  activeModelAnalysis = null,
  // SaaS Phase 8B: the set of signal-model ids the viewer actually owns (their unlocked bot
  // wallets' assignedSignalModelId). null means "no entitlement filtering" - kept opt-in so
  // this stays safe for the admin (unlimited, per getEffectiveBotSlots) without every caller
  // needing to pass the full list explicitly.
  ownedModelIds = null,
  // Optional "buy another slot" tile rendered as the last cell of the grid (plus sign in a box).
  buySlotTo = null,
  // Deployed custom bots (SaaS Phase 8G/8I) - shown after the native bots. Cards link to Bot Creation.
  customBots = [],
  // Symbol the custom-bot cards evaluate their live preview on (the dashboard's selected symbol).
  symbol = 'BTCUSDT',
  // Bought-but-unfilled bot slots ({id, assignment: ''}); each opens Bot Creation to be set up.
  emptySlots = [],
  // Bots whose wallet is switched off in Bot Creation (Undeploy) - shown dimmed with an Undeployed badge.
  undeployedModelIds = [],
}) {
  const navigate = useNavigate()
  const openBot = (botId) => navigate(`/bot-creation?bot=${encodeURIComponent(botId)}`)
  const models = ownedModelIds ? visibleSignalModels().filter((model) => ownedModelIds.includes(model.id)) : visibleSignalModels()

  return (
    <Panel title="Bot Status">
      <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {models.map((model) => {
          const analysis = modelAnalyses[model.id] || null
          const isActive = model.id === activeSignalModelId
          const tone = getModelTone(model, analysis, isActive)
          const directionMeta = getModelDirectionMeta(model, analysis)
          const stats = signalModelPerformance[model.id] || EMPTY_MODEL_STATS
          const signalSlots = getSignalSlots(model, analysis)
          const score = Number(analysis?.score || 0)
          const maxScore = Number(analysis?.maxScore || model.totalSignals || 0)
          const progressPercent = maxScore > 0 ? Math.max(0, Math.min(100, (score / maxScore) * 100)) : 0
          const pnl = Number(stats.pnl || 0)
          const pnlTone = pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-300'
          const hasProfessionalFilters = model.professionalSignalCount > 0 && analysis
          const aiMeta = getAiStatusMeta(analysis?.aiAdvisory || null)
          const undeployed = undeployedModelIds.includes(model.id)

          return (
            <div
              key={model.id}
              role="link"
              tabIndex={0}
              title="Open in Bot Creation"
              onClick={() => openBot(model.id)}
              onKeyDown={(event) => { if (event.key === 'Enter') openBot(model.id) }}
              className={`cursor-pointer rounded-2xl border px-4 py-3 backdrop-blur-md transition hover:border-sky-300/40 ${tone.card} ${undeployed ? 'opacity-60' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{model.name}</div>
                  <div className="mt-1 truncate text-sm font-semibold text-white">{model.tag}</div>
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${tone.badge}`}>
                  {undeployed ? 'Undeployed' : isActive ? 'Focus' : model.status}
                </span>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${tone.badge}`}>
                  <directionMeta.Icon className="h-3.5 w-3.5" />
                  {directionMeta.label}
                </span>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Live Score</div>
                  <div className="mt-1 text-sm font-semibold text-white">
                    {maxScore > 0 ? `${score}/${maxScore}` : '0/0'}
                  </div>
                </div>
              </div>

              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-all ${tone.fill}`}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              <div
                className="mt-2 grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${signalSlots.length || 1}, minmax(0, 1fr))` }}
              >
                {signalSlots.map((signal) => (
                  <div
                    key={signal.key}
                    className={`h-1.5 rounded-full ${signal.passed ? tone.signalOn : tone.signalOff}`}
                  />
                ))}
              </div>

              <div className="mt-3 text-xs text-slate-300">{getModelStatusLine(model, analysis)}</div>

              <div className={`mt-3 rounded-xl border px-3 py-3 ${aiMeta.tone}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] opacity-80">{aiMeta.label}</div>
                  <div className="text-[11px] font-semibold">{aiMeta.score}</div>
                </div>
                <div className="mt-2 text-[11px] leading-5 opacity-90">{aiMeta.detail}</div>
                {analysis?.aiAdvisory?.policyLabel ? (
                  <div className="mt-2 text-[10px] uppercase tracking-[0.16em] opacity-70">
                    {analysis.aiAdvisory.policyLabel} • {analysis.aiAdvisory.datasetRows || 0} trained rows
                  </div>
                ) : null}
              </div>

              <div className="mt-2 text-[11px] text-slate-500">Live bot status is shown above in direction and score. History shows the closed-trade win rate.</div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                <div>
                  <div>History</div>
                  <div className="mt-1 text-slate-200">{formatWinRate(stats.winRate, stats.closedTrades)}</div>
                </div>
                <div className="text-right">
                  <div>PnL</div>
                  <div className={`mt-1 ${pnlTone}`}>{formatSignedUsdt(pnl)}</div>
                </div>
              </div>

              {hasProfessionalFilters ? (
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                  <span>Professional filters</span>
                  <span className="font-medium text-slate-200">
                    {analysis.professionalSignalScore}/{model.professionalSignalCount}
                  </span>
                </div>
              ) : null}

              {isActive && activeModelAnalysis?.ready && isFinitePrice(activeModelAnalysis.entryPrice) ? (
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                  <span>Live entry</span>
                  <span className="font-medium text-white">{formatPrice(activeModelAnalysis.entryPrice, 5)}</span>
                </div>
              ) : null}
            </div>
          )
        })}
        {customBots.map((bot) => (
          <CustomBotStatusCard key={bot.id} bot={bot} symbol={symbol} onOpen={openBot} />
        ))}
        {emptySlots.map((slot, index) => (
          <div
            key={slot.id}
            role="link"
            tabIndex={0}
            title="Set up this bot in Bot Creation"
            onClick={() => navigate(`/bot-creation?slot=${encodeURIComponent(slot.id)}`)}
            onKeyDown={(event) => { if (event.key === 'Enter') navigate(`/bot-creation?slot=${encodeURIComponent(slot.id)}`) }}
            className="flex min-h-[140px] cursor-pointer flex-col rounded-2xl border border-white/10 bg-slate-950/88 px-4 py-3 backdrop-blur-md transition hover:border-sky-300/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Slot {slot.id.replace('slot-', '') || index + 1}</div>
                <div className="mt-1 truncate text-sm font-semibold text-white">Empty bot</div>
              </div>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
                Empty
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10" />
            <div className="mt-3 text-xs text-slate-300">No strategy yet.</div>
            <div className="mt-auto pt-3 text-[11px] text-sky-200">Click to choose a premade bot or combine signals</div>
          </div>
        ))}
        {buySlotTo ? (
          <Link
            to={buySlotTo}
            className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-3 text-center transition hover:border-sky-300/40 hover:bg-white/[0.05]"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-300/25 bg-sky-400/10 text-sky-200">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-xs font-semibold text-slate-200">Buy another bot slot</span>
          </Link>
        ) : null}
      </div>
    </Panel>
  )
}
