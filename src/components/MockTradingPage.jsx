import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, FlaskConical, Lock, PlayCircle } from 'lucide-react'
import { CoinAvatar } from './CoinAvatar'
import { getEffectiveSignalModelStrategy, SIGNAL_MODELS, getSignalModel } from '../lib/signalModels'
import { formatDateTimeWithSeconds, formatPrice } from '../lib/formatters'
import { usePersistentBoolean } from '../lib/usePersistentBoolean'
import { formatTradeSource } from '../lib/trades'
import { Panel } from './Panel'
import { TradeDirectionBadge } from './TradeDirectionBadge'

function formatWinRate(winRate, closedTrades) {
  if (!closedTrades) {
    return 'No closed trades yet'
  }

  return `${(winRate * 100).toFixed(2)}% win rate`
}

function formatSignedUsdt(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function formatTradeCount(value) {
  const count = Number(value || 0)
  return `${count} trade${count === 1 ? '' : 's'}`
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

function getModelTone(model, isActive) {
  if (isActive) {
    return 'border-sky-400/40 bg-sky-400/10'
  }

  if (model.status === 'blank') {
    return 'border-white/10 bg-slate-950/45'
  }

  return 'border-white/10 bg-slate-950/60'
}

function summarizeActivitySteps(steps) {
  return steps.reduce((summary, step) => {
    if (step.status === 'pass') {
      summary.pass += 1
    } else if (step.status === 'blocked') {
      summary.blocked += 1
    } else {
      summary.info += 1
    }

    return summary
  }, { pass: 0, blocked: 0, info: 0 })
}

function getStepHighlightLabel(step) {
  if (step.symbol) {
    const direction = step.direction ? ` ${step.direction}` : ''
    return `${step.symbol}${direction}`.trim()
  }

  return step.message
    .replace(/\.$/, '')
    .replace(/^Found\s+/i, '')
}

function getCollapsedStepHighlights(steps) {
  const seen = new Set()

  return steps
    .filter((step) => step.status === 'pass' || step.status === 'blocked')
    .map((step) => ({
      label: getStepHighlightLabel(step),
      status: step.status,
    }))
    .filter((item) => {
      if (!item.label || seen.has(item.label)) {
        return false
      }

      seen.add(item.label)
      return true
    })
    .slice(0, 4)
}

function getAiDecisionSummary(entry) {
  const reason = String(entry?.result?.reason || '')
  const steps = entry?.result?.steps || []
  const aiStep = steps.find((step) => String(step?.message || '').startsWith('AI filter scored '))
  const paperOnlyStep = steps.find((step) => String(step?.message || '').startsWith('Paper-only AI filter would '))
  const aiModeStep = steps.find((step) => String(step?.message || '').startsWith('AI mode for '))

  if (reason.includes('AI filter skipped')) {
    const scoreMatch = reason.match(/score\s+(\d+)\/(\d+)/i)
    return {
      label: scoreMatch ? `AI skipped ${scoreMatch[1]}/${scoreMatch[2]}` : 'AI skipped',
      tone: 'skip',
      detail: null,
      mode: aiModeStep?.message.includes('paper-only') ? 'paper-only' : aiModeStep?.message.includes('hard-block') ? 'hard-block' : null,
    }
  }

  if (paperOnlyStep) {
    return {
      label: paperOnlyStep.message.includes('accept') ? 'AI accepted (paper-only)' : 'AI skipped (paper-only)',
      tone: paperOnlyStep.message.includes('accept') ? 'accept' : 'skip',
      detail: null,
      mode: aiModeStep?.message.includes('paper-only') ? 'paper-only' : aiModeStep?.message.includes('hard-block') ? 'hard-block' : null,
    }
  }

  if (aiStep) {
    const scoreMatch = aiStep.message.match(/scored .*? (\d+)\/100 .*using ([a-z0-9:-]+) policy \(threshold (\d+)\)/i)
    const accepted = String(aiStep.status || '').toLowerCase() === 'pass'

    return {
      label: scoreMatch
        ? `${accepted ? 'AI accepted' : 'AI skipped'} ${scoreMatch[1]}/${scoreMatch[3]}`
        : accepted ? 'AI accepted' : 'AI skipped',
      tone: accepted ? 'accept' : 'skip',
      detail: scoreMatch ? `policy ${scoreMatch[2]}` : null,
      mode: aiModeStep?.message.includes('paper-only') ? 'paper-only' : aiModeStep?.message.includes('hard-block') ? 'hard-block' : null,
    }
  }

  return null
}

function formatPercent(value, fractionDigits = 1) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue)) {
    return 'N/A'
  }

  return `${numericValue.toFixed(fractionDigits)}%`
}

function getAiAdvisoryTone(status) {
  if (status === 'accept') {
    return 'text-sky-200'
  }

  if (status === 'caution') {
    return 'text-rose-300'
  }

  if (status === 'waiting') {
    return 'text-amber-200'
  }

  return 'text-slate-200'
}

function getAiAdvisoryPanelTone(status) {
  if (status === 'accept') {
    return 'border-sky-400/20 bg-sky-400/10'
  }

  if (status === 'caution') {
    return 'border-rose-400/20 bg-rose-400/10'
  }

  if (status === 'waiting') {
    return 'border-amber-400/20 bg-amber-400/10'
  }

  return 'border-white/10 bg-slate-950/70'
}

function getAiLiveModeLabel(mode) {
  if (mode === 'paper-only') {
    return 'Paper Only'
  }

  if (mode === 'hard-block') {
    return 'Hard Block'
  }

  return 'Disabled'
}

function SummaryStat({ label, value, detail = null, tone = 'text-white' }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${tone}`}>{value}</div>
      {detail ? <div className="mt-0.5 text-[11px] text-slate-400">{detail}</div> : null}
    </div>
  )
}

function FriendlyStatCard({ label, value, detail, tone = 'text-white' }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-slate-950/70 px-4 py-4 shadow-[0_12px_30px_rgba(15,23,42,0.18)]">
      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${tone}`}>{value}</div>
      <div className="mt-2 text-sm leading-relaxed text-slate-400">{detail}</div>
    </div>
  )
}

function AutoTradeActivityEntry({ entry, defaultExpanded = false }) {
  const [expanded, setExpanded] = usePersistentBoolean(
    `mock-trading:auto-trade-activity:${entry.id}:expanded`,
    defaultExpanded,
  )
  const order = entry.result?.order || null
  const walletName = entry.walletName || order?.walletName || null
  const steps = entry.result?.steps || []
  const stepSummary = summarizeActivitySteps(steps)
  const collapsedHighlights = getCollapsedStepHighlights(steps)
  const aiDecision = getAiDecisionSummary(entry)

  return (
    <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.9),rgba(15,23,42,0.72))] shadow-[0_18px_40px_rgba(15,23,42,0.16)]">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-start justify-between gap-4 px-5 py-5 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {order ? <CoinAvatar symbol={order.symbol} size="sm" /> : null}
            {order ? <div className="text-sm font-semibold text-white">{order.symbol}</div> : null}
            {order ? <TradeDirectionBadge side={order.side} /> : null}
            {order?.signalModelName ? (
              <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-sky-200">
                {order.signalModelName}
              </span>
            ) : null}
            {walletName ? (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-100">
                {walletName}
              </span>
            ) : null}
            <span className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
              entry.result.executed ? 'bg-emerald-400/12 text-emerald-300' : 'bg-amber-400/12 text-amber-300'
            }`}>
              {entry.result.executed ? 'Order Sent' : 'No Trade'}
            </span>
            {aiDecision ? (
              <span className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                aiDecision.tone === 'accept'
                  ? 'bg-sky-400/12 text-sky-200'
                  : 'bg-rose-400/12 text-rose-200'
              }`}>
                {aiDecision.label}
              </span>
            ) : null}
            {aiDecision?.detail ? (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-300">
                {aiDecision.detail}
              </span>
            ) : null}
            {aiDecision?.mode ? (
              <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                aiDecision.mode === 'paper-only'
                  ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                  : 'border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200'
              }`}>
                {aiDecision.mode}
              </span>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs uppercase tracking-[0.18em] text-slate-500">
            <span>{formatDateTimeWithSeconds(entry.timestamp)}</span>
            {order ? <span>{formatTradeSource(order.source)}</span> : null}
            <span>{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          </div>

          <div className="mt-2 truncate text-sm text-slate-300">
            {entry.result.reason}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-400 sm:inline-flex">
            {expanded ? 'Collapse' : 'Expand'}
          </span>
          <ChevronDown className={`mt-1 h-4 w-4 text-slate-500 transition ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {!expanded ? (
        <div className="border-t border-white/10 px-5 py-4">
          {order ? (
            <div className="flex flex-wrap gap-2 text-xs text-slate-300">
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
                Entry {formatPrice(order.entryPrice, 5)}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
                SL {formatPrice(order.stopLoss, 5)}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
                TP {formatPrice(order.takeProfit, 5)}
              </span>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-emerald-200">
              {stepSummary.pass} pass
            </span>
            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-amber-200">
              {stepSummary.blocked} blocked
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
              {stepSummary.info} info
            </span>
          </div>

          {collapsedHighlights.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {collapsedHighlights.map((item) => (
                <span
                  key={`${entry.id}-${item.label}`}
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                    item.status === 'pass'
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                      : 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                  }`}
                >
                  {item.label}
                </span>
              ))}
            </div>
          ) : null}
          {aiDecision ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                aiDecision.tone === 'accept'
                  ? 'border-sky-400/20 bg-sky-400/10 text-sky-200'
                  : 'border-rose-400/20 bg-rose-400/10 text-rose-200'
              }`}>
                {aiDecision.label}
              </span>
              {aiDecision.detail ? (
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300">
                  {aiDecision.detail}
                </span>
              ) : null}
              {aiDecision.mode ? (
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                  aiDecision.mode === 'paper-only'
                    ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                    : 'border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200'
                }`}>
                  {aiDecision.mode}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="border-t border-white/10 px-5 py-5">
          {order ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <CoinAvatar symbol={order.symbol} size="sm" />
                <div className="text-sm font-semibold text-white">{order.symbol}</div>
                <TradeDirectionBadge side={order.side} />
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                  {formatTradeSource(order.source)}
                </div>
                {aiDecision ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] ${
                    aiDecision.tone === 'accept'
                      ? 'border-sky-400/20 bg-sky-400/10 text-sky-200'
                      : 'border-rose-400/20 bg-rose-400/10 text-rose-200'
                  }`}>
                    {aiDecision.label}
                  </span>
                ) : null}
                {aiDecision?.detail ? (
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-300">
                    {aiDecision.detail}
                  </span>
                ) : null}
                {aiDecision?.mode ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] ${
                    aiDecision.mode === 'paper-only'
                      ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                      : 'border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200'
                  }`}>
                    {aiDecision.mode}
                  </span>
                ) : null}
                {order.signalModelName ? (
                  <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-sky-200">
                    {order.signalModelName}
                  </span>
                ) : null}
                {walletName ? (
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-100">
                    {walletName}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3 text-sm text-slate-400">
                <span>Entry {formatPrice(order.entryPrice, 5)}</span>
                <span>SL {formatPrice(order.stopLoss, 5)}</span>
                <span>TP {formatPrice(order.takeProfit, 5)}</span>
              </div>
            </>
          ) : null}

          <div className="mt-3 text-sm text-slate-300">{entry.result.reason}</div>

          <div className="mt-4 space-y-2">
            {steps.map((step, index) => (
              <div key={`${entry.id}-${index}`} className="flex items-start gap-3 text-sm">
                <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${
                  step.status === 'pass'
                    ? 'bg-emerald-400'
                    : step.status === 'blocked'
                      ? 'bg-amber-400'
                      : 'bg-slate-500'
                }`} />
                <span className="text-slate-300">{step.message}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function MockTradingPage({
  analysis,
  settings,
  autoTradeStatus,
  autoTradeLog,
  autoTradeFeedback,
  activeSignalModelId,
  signalModelPerformance,
  onSelectSignalModel,
  switchingSignalModel,
  tradingMode,
  autoTradePhase,
  children,
}) {
  const trackedSymbols = settings.strategy.preferredSymbols || []
  const latestAutoOrder = autoTradeLog.find((entry) => entry.result?.order)?.result.order || null
  const latestActivityEntry = autoTradeLog[0] || null
  const latestActivityOrder = latestActivityEntry?.result?.order || null
  const latestActivitySteps = latestActivityEntry?.result?.steps || []
  const latestActivityStepSummary = summarizeActivitySteps(latestActivitySteps)
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
  const [previewModelId, setPreviewModelId] = useState(activeSignalModelId)
  const previousActiveModelIdRef = useRef(activeSignalModelId)

  useEffect(() => {
    if (previousActiveModelIdRef.current !== activeSignalModelId) {
      previousActiveModelIdRef.current = activeSignalModelId
      setPreviewModelId(activeSignalModelId)
    }
  }, [activeSignalModelId])

  const previewModel = getSignalModel(previewModelId)
  const previewModelIsActive = previewModel.id === activeSignalModelId
  const previewModelStats = signalModelPerformance[previewModel.id] || {
    tradeCount: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    pnl: 0,
  }
  const aiAdvisory = analysis?.aiAdvisory || null
  const aiAdvisoryTitle = !aiAdvisory
    ? 'AI Advisory Offline'
    : aiAdvisory.status === 'accept'
      ? 'Advisory Pass'
      : aiAdvisory.status === 'caution'
        ? 'Advisory Caution'
        : aiAdvisory.status === 'waiting'
          ? 'Waiting For Setup'
          : 'Training Needed'
  const aiAdvisoryCardValue = aiAdvisory?.signalReady && Number.isFinite(Number(aiAdvisory.finalScore))
    ? `${aiAdvisory.finalScore}/${aiAdvisory.thresholdScore}`
    : aiAdvisory?.status === 'waiting'
      ? 'Standby'
      : aiAdvisory?.available === false
        ? 'Needs Train'
        : 'Unavailable'
  const aiAdvisoryCardDetail = !aiAdvisory
    ? 'Waiting for server-side AI analysis.'
    : aiAdvisory.signalReady
      ? `${aiAdvisory.policyLabel} • ${aiAdvisory.datasetRows || 0} trained row${aiAdvisory.datasetRows === 1 ? '' : 's'}.`
      : aiAdvisory.detail
  const aiAdvisoryScoreValue = aiAdvisory?.signalReady && Number.isFinite(Number(aiAdvisory.finalScore))
    ? `${aiAdvisory.finalScore}/${aiAdvisory.thresholdScore}`
    : aiAdvisory?.status === 'waiting'
      ? 'Standby'
      : 'Unavailable'
  const aiAdvisoryScoreDetail = aiAdvisory?.signalReady
    ? `Entry quality ${aiAdvisory.entryQualityScore}/100`
    : 'AI scores only trade-ready setups'
  const aiAdvisorySampleValue = aiAdvisory?.sampleCount
    ? formatTradeCount(aiAdvisory.sampleCount)
    : aiAdvisory?.signalReady
      ? 'No exact sample'
      : 'Standby'
  const aiAdvisorySampleDetail = aiAdvisory?.setupFamily
    ? `${aiAdvisory.policyLabel} on ${aiAdvisory.setupFamily}`
    : 'Awaiting setup classification'
  const aiAdvisoryTrainValue = aiAdvisory?.trainedAt
    ? formatDateTimeWithSeconds(aiAdvisory.trainedAt)
    : 'Not trained'
  const aiAdvisoryTrainDetail = aiAdvisory?.available
    ? `${aiAdvisory.datasetRows || 0} row${aiAdvisory.datasetRows === 1 ? '' : 's'} • ${formatPercent(aiAdvisory.actionAlignment, 1)} alignment`
    : 'Workstation training required'
  const aiAdvisoryModeValue = getAiLiveModeLabel(aiAdvisory?.liveMode)
  const aiAdvisoryModeDetail = 'The UI stays advisory-only even if live AI mode changes.'

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
  const signalModelsCollapsedContent = (
    <div className="rounded-xl border border-sky-400/40 bg-sky-400/10 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{activeModel.name}</div>
          <div className="mt-1 truncate text-sm font-semibold text-white">{activeModel.tag}</div>
        </div>
        <span className="rounded-full border border-sky-400/30 bg-sky-400/12 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-sky-200">
          Active
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-300">
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
          {activeModel.signals.length} signal{activeModel.signals.length === 1 ? '' : 's'}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
          {activeModelStats.tradeCount} trade{activeModelStats.tradeCount === 1 ? '' : 's'}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
          {(activeModelStats.winRate * 100).toFixed(0)}% win
        </span>
      </div>
    </div>
  )
  const controllerCollapsedContent = (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryStat
        label="Runtime"
        value={isRunning ? 'Running' : isStopping ? 'Stopping' : isStarting ? 'Starting' : 'Idle'}
        detail={autoTradeStatus.enabled ? 'Enabled' : 'Disabled'}
        tone={isRunning ? 'text-emerald-300' : isStopping ? 'text-rose-300' : isStarting ? 'text-amber-300' : 'text-white'}
      />
      <SummaryStat
        label="Analysis"
        value={activeModel.name}
        detail={`${activeModel.signals.length} signal${activeModel.signals.length === 1 ? '' : 's'}`}
      />
      <SummaryStat
        label="Today"
        value={`${autoTradeStatus.today?.tradeCount || 0} auto trade${autoTradeStatus.today?.tradeCount === 1 ? '' : 's'}`}
        detail={`${trackedSymbols.length} symbols`}
      />
      <SummaryStat
        label="Last Check"
        value={autoTradeStatus.lastRunAt ? formatDateTimeWithSeconds(autoTradeStatus.lastRunAt) : 'No check yet'}
        detail={autoTradeStatus.lastReason ? 'Decision saved' : 'No decision yet'}
      />
    </div>
  )
  const activityCollapsedContent = latestActivityEntry ? (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryStat
        label="Latest Run"
        value={formatDateTimeWithSeconds(latestActivityEntry.timestamp)}
        detail={`${autoTradeLog.length} logged run${autoTradeLog.length === 1 ? '' : 's'}`}
      />
      <SummaryStat
        label="Result"
        value={latestActivityEntry.result?.executed ? 'Order Sent' : 'No Trade'}
        detail={latestActivityOrder ? `${latestActivityOrder.symbol} ${latestActivityOrder.side}` : 'Scanner only'}
        tone={latestActivityEntry.result?.executed ? 'text-emerald-300' : 'text-amber-300'}
      />
      <SummaryStat
        label="Signals"
        value={`${latestActivityStepSummary.pass} pass / ${latestActivityStepSummary.blocked} blocked`}
        detail={`${latestActivityStepSummary.info} info step${latestActivityStepSummary.info === 1 ? '' : 's'}`}
      />
      <SummaryStat
        label="Latest PnL"
        value={latestActivityOrder?.pnl == null ? 'Open / Pending' : formatSignedUsdt(latestActivityOrder.pnl)}
        detail={latestActivityOrder?.walletName || latestActivityOrder?.signalModelName || 'No trade attached'}
        tone={latestActivityOrder?.pnl > 0 ? 'text-emerald-300' : latestActivityOrder?.pnl < 0 ? 'text-rose-300' : 'text-white'}
      />
    </div>
  ) : (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryStat
        label="Activity"
        value="No runs yet"
        detail="Waiting for the first scan"
        tone="text-slate-300"
      />
    </div>
  )
  const latestDecisionSummary = latestActivityEntry
    ? latestActivityEntry.result?.reason || 'Latest decision captured.'
    : 'The scanner is waiting for the next review cycle.'
  const nextActionHint = latestActivityEntry?.result?.executed
    ? 'An order was sent on the latest run.'
    : 'No order was sent on the latest run.'

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid content-start gap-6 self-start">
        <section className="overflow-hidden rounded-[30px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.16),transparent_24%),radial-gradient(circle_at_bottom_right,rgba(34,197,94,0.08),transparent_20%),rgba(15,23,42,0.92)] p-6 shadow-[0_24px_60px_rgba(15,23,42,0.24)]">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.95fr)]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-100">
                <Bot className="h-4 w-4" />
                Mock Trading Control Room
              </div>
              <h1 className="mt-4 text-3xl font-semibold text-white sm:text-4xl">
                See what the bots are doing, why they acted, and where AI changed the decision.
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base">
                This page is designed to answer three simple questions: which bot is active, what the latest scan decided,
                and whether AI helped approve or skip the trade. It keeps the complex strategy data visible, but easier to read.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <FriendlyStatCard
                  label="Runtime"
                  value={getRuntimeLabel(autoTradePhase)}
                  detail={autoTradeStatus.enabled ? 'Auto trading is enabled.' : 'Auto trading is currently off.'}
                  tone={isRunning ? 'text-emerald-300' : isStopping ? 'text-rose-300' : isStarting ? 'text-amber-300' : 'text-white'}
                />
                <FriendlyStatCard
                  label="Today"
                  value={formatTradeCount(autoTradeStatus.today?.tradeCount || 0)}
                  detail={`${autoTradeStatus.today?.lossCount || 0} losing trade${autoTradeStatus.today?.lossCount === 1 ? '' : 's'} today.`}
                  tone="text-sky-200"
                />
                <FriendlyStatCard
                  label="Active Bot"
                  value={activeModel.name}
                  detail={`${activeModel.tag} is the current analysis focus.`}
                  tone="text-white"
                />
                <FriendlyStatCard
                  label="Model Win Rate"
                  value={activeModelStats.closedTrades ? `${(activeModelStats.winRate * 100).toFixed(1)}%` : 'No data'}
                  detail={activeModelStats.closedTrades ? `${activeModelStats.closedTrades} closed trades tracked.` : 'The bot needs more closed trades for a useful read.'}
                  tone={getWinRateTone(activeModelStats.winRate, activeModelStats.closedTrades)}
                />
                <FriendlyStatCard
                  label="AI Advisory"
                  value={aiAdvisoryCardValue}
                  detail={aiAdvisoryCardDetail}
                  tone={getAiAdvisoryTone(aiAdvisory?.status)}
                />
              </div>
            </div>

            <div className="grid gap-4 self-start">
              <div className="rounded-[26px] border border-white/10 bg-slate-950/70 p-5">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Latest Decision</div>
                <div className="mt-3 text-xl font-semibold text-white">
                  {latestActivityEntry ? (latestActivityEntry.result?.executed ? 'Trade Approved' : 'Trade Skipped') : 'Waiting For First Scan'}
                </div>
                <div className="mt-3 text-sm leading-7 text-slate-300">{latestDecisionSummary}</div>
                <div className="mt-3 text-sm text-slate-400">{nextActionHint}</div>
              </div>
              <div className={`rounded-[26px] border p-5 ${getAiAdvisoryPanelTone(aiAdvisory?.status)}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">AI Advisory</div>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-200">
                    Advisory Only
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-200">
                    Live Mode {aiAdvisoryModeValue}
                  </span>
                </div>
                <div className={`mt-3 text-xl font-semibold ${getAiAdvisoryTone(aiAdvisory?.status)}`}>
                  {aiAdvisoryTitle}
                </div>
                <div className="mt-3 text-sm leading-7 text-slate-300">
                  {aiAdvisory?.detail || 'The server analysis is still loading the latest AI advisory.'}
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <SummaryStat
                    label="Score"
                    value={aiAdvisoryScoreValue}
                    detail={aiAdvisoryScoreDetail}
                    tone={getAiAdvisoryTone(aiAdvisory?.status)}
                  />
                  <SummaryStat
                    label="Coverage"
                    value={aiAdvisorySampleValue}
                    detail={aiAdvisorySampleDetail}
                  />
                  <SummaryStat
                    label="Last Train"
                    value={aiAdvisoryTrainValue}
                    detail={aiAdvisoryTrainDetail}
                  />
                  <SummaryStat
                    label="Live Filter"
                    value={aiAdvisoryModeValue}
                    detail={aiAdvisoryModeDetail}
                  />
                </div>
              </div>
              <div className="rounded-[26px] border border-white/10 bg-slate-950/70 p-5">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">How To Read This Page</div>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  <div>`Signal Models` explains what each bot is built to look for.</div>
                  <div>`Auto Trade Controller` shows the live runtime and current trading conditions.</div>
                  <div>`Auto Trade Activity` is the most important section if you want to know why a trade was taken or skipped.</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <Panel
          title="Signal Models"
          action={<FlaskConical className="h-4 w-4 text-sky-300" />}
          collapsible
          storageKey="mock-trading:signal-models:collapsed"
          keepMountedWhenCollapsed
          collapsedContent={signalModelsCollapsedContent}
        >
          <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
            Pick a bot from the dropdown below to see its role, win-rate trend, and the rule that must align before it can place a trade.
          </div>

          <div className="mt-4 rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-4 text-sm text-sky-100">
            Choosing a bot here changes the analysis focus only. Real automated execution still follows the model assigned to each wallet.
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:max-w-md">
              <label
                htmlFor="signal-model-picker"
                className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500"
              >
                Choose bot to use
              </label>
              <div className="relative mt-2">
                <select
                  id="signal-model-picker"
                  value={previewModelId}
                  onChange={(event) => setPreviewModelId(event.target.value)}
                  className="w-full appearance-none rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 pr-11 text-sm font-semibold text-white outline-none transition focus:border-sky-400/40"
                >
                  {SIGNAL_MODELS.map((model) => (
                    <option key={model.id} value={model.id} className="bg-slate-900 text-white">
                      {model.name} — {model.tag}
                      {model.id === activeSignalModelId ? ' (active)' : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              </div>
            </div>

            <button
              type="button"
              disabled={previewModel.status === 'blank' || previewModelIsActive || switchingSignalModel}
              onClick={() => onSelectSignalModel(previewModel.id)}
              className={`inline-flex shrink-0 items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                previewModel.status === 'blank'
                  ? 'cursor-not-allowed border border-white/10 bg-white/[0.03] text-slate-500'
                  : previewModelIsActive
                  ? 'border border-sky-400/30 bg-sky-400/12 text-sky-100'
                  : 'bg-sky-400 text-slate-950 hover:bg-sky-300 disabled:bg-slate-700 disabled:text-slate-400'
              }`}
            >
              {previewModel.status === 'blank'
                ? 'Waiting For Rules'
                : previewModelIsActive
                  ? 'Analysis Focus'
                  : switchingSignalModel
                    ? 'Switching...'
                    : 'Use For Analysis'}
            </button>
          </div>

          <div className="mt-5">
            <div
              className={`rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.22)] ${getModelTone(previewModel, previewModelIsActive)}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-slate-500">{previewModel.name}</div>
                  <div className="mt-2 text-xl font-semibold text-white">{previewModel.tag}</div>
                </div>
                <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                  previewModelIsActive
                    ? 'border-sky-400/30 bg-sky-400/12 text-sky-200'
                    : previewModel.status === 'blank'
                      ? 'border-white/10 bg-white/[0.03] text-slate-400'
                      : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                }`}>
                  {previewModelIsActive ? 'Active' : previewModel.status}
                </span>
              </div>

              <div className="mt-3 text-sm text-slate-300">{previewModel.description}</div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Current Performance</div>
                  <div className={`mt-2 text-sm font-semibold ${getWinRateTone(previewModelStats.winRate, previewModelStats.closedTrades)}`}>{formatWinRate(previewModelStats.winRate, previewModelStats.closedTrades)}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {previewModelStats.wins} win / {previewModelStats.losses} loss from {previewModelStats.tradeCount} auto trades
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">When It Can Trade</div>
                  <div className="mt-2 text-sm font-semibold text-white">{previewModel.executionRule}</div>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {previewModel.signals.length === 0 ? (
                  <div className="flex items-start gap-3 rounded-2xl border border-dashed border-white/10 bg-slate-950/50 px-4 py-4 text-sm text-slate-400 sm:col-span-2">
                    <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Signal slot is ready but intentionally blank. Add the next model here later.</span>
                  </div>
                ) : (
                  previewModel.signals.map((signal, index) => (
                    <div key={signal.key} className="rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-4">
                      <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Signal {index + 1}</div>
                      <div className="mt-2 text-sm font-semibold text-white">{signal.label}</div>
                      <div className="mt-2 text-sm text-slate-300">{signal.detail}</div>
                      {signal.sourceUrl ? (
                        <a
                          href={signal.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex text-xs font-medium uppercase tracking-[0.18em] text-sky-300 transition hover:text-sky-200"
                        >
                          {signal.sourceLabel}
                        </a>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </Panel>

        <Panel
          title="Auto Trade Controller"
          action={<PlayCircle className="h-4 w-4 text-sky-300" />}
          collapsible
          storageKey="mock-trading:auto-trade-controller:collapsed"
          keepMountedWhenCollapsed
          collapsedContent={controllerCollapsedContent}
        >
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
            This section is the control summary for the current run. It tells you whether the scanner is active, which bot is being reviewed, and what the scheduler decided most recently.
          </div>

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
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Auto universe</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {trackedSymbols.length > 0 ? trackedSymbols.map((symbol) => (
                  <span
                    key={symbol}
                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200"
                  >
                    <CoinAvatar symbol={symbol} size="xs" />
                    {symbol}
                  </span>
                )) : 'No symbols configured'}
              </div>
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

          <div className="mt-4 grid gap-4 md:grid-cols-2">
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

        <Panel
          title="Auto Trade Activity"
          action={<Bot className="h-4 w-4 text-sky-300" />}
          collapsible
          storageKey="mock-trading:auto-trade-activity:collapsed"
          keepMountedWhenCollapsed
          collapsedContent={activityCollapsedContent}
        >
          <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-4 text-sm text-sky-100">
            Each row below shows one scheduler run. Open a row to see the exact steps, including bot checks, AI filter decisions, and why a trade was placed or skipped.
          </div>

          {autoTradeLog.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
              No auto-trade activity yet.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {autoTradeLog.map((entry) => (
                <AutoTradeActivityEntry
                  key={entry.id}
                  entry={entry}
                  defaultExpanded={false}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div>{children}</div>
    </div>
  )
}
