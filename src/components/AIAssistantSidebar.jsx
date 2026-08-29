import { useMemo } from 'react'
import { Bot, CheckCircle2, Circle, Radar, ShieldAlert, TrendingDown, TrendingUp } from 'lucide-react'
import { formatPercent, formatPrice } from '../lib/formatters'
import { getSignalModel } from '../lib/signalModels'
import { Panel } from './Panel'

function toneForDirection(direction) {
  if (direction === 'LONG') {
    return {
      badge: 'border-emerald-400/30 bg-emerald-400/12 text-emerald-300',
      icon: TrendingUp,
    }
  }

  if (direction === 'SHORT') {
    return {
      badge: 'border-rose-400/30 bg-rose-400/12 text-rose-300',
      icon: TrendingDown,
    }
  }

  return {
    badge: 'border-amber-400/30 bg-amber-400/12 text-amber-300',
    icon: Radar,
  }
}

function getChecklistLabel(checklistSide) {
  if (checklistSide === 'LONG') {
    return 'Long Setup Checklist'
  }

  if (checklistSide === 'SHORT') {
    return 'Short Setup Checklist'
  }

  return 'Signal Checklist'
}

export function AIAssistantSidebar({
  analysis,
  activeSignalModelId,
  activeModelRiskSummary = '',
  modelChecklistAnalysis = null,
}) {
  const displayAnalysis = modelChecklistAnalysis || analysis
  const tone = useMemo(() => toneForDirection(displayAnalysis.direction), [displayAnalysis.direction])
  const DirectionIcon = tone.icon
  const activeSymbol = displayAnalysis.symbol || analysis.symbol || 'N/A'
  const activeModel = useMemo(() => getSignalModel(activeSignalModelId), [activeSignalModelId])
  const checklist = modelChecklistAnalysis?.checklist || []
  const passedChecklistCount = checklist.filter((item) => item.passed).length
  const ready = Boolean(modelChecklistAnalysis?.ready)
  const checklistLabel = useMemo(() => {
    if (activeModel.status === 'blank') {
      return `${activeModel.name} Checklist`
    }

    return `${activeModel.name} ${getChecklistLabel(modelChecklistAnalysis?.checklistSide || analysis.checklistSide)}`
  }, [activeModel, analysis.checklistSide, modelChecklistAnalysis?.checklistSide])
  const modelSignalSummary = useMemo(() => {
    const riskSummary = activeModelRiskSummary
      ? ` ${activeModelRiskSummary}`
      : activeModel.riskProfile?.summary
        ? ` ${activeModel.riskProfile.summary}`
        : ''

    if (activeModel.status === 'blank') {
      return 'This model is reserved but has no live signals yet.'
    }

    if (modelChecklistAnalysis?.professionalRequiredCount > 0) {
      return `${activeModel.totalSignals} total signals. Need ${activeModel.minimumScore} aligned, with at least ${modelChecklistAnalysis.professionalRequiredCount} professional filters.${riskSummary}`
    }

    return `${activeModel.totalSignals} total signals. Need ${activeModel.minimumScore} aligned before auto-entry.${riskSummary}`
  }, [activeModel, activeModelRiskSummary, modelChecklistAnalysis?.professionalRequiredCount])

  return (
    <div className="xl:sticky xl:top-4">
      <Panel
        title="AI Assistant"
        action={<Bot className="h-4 w-4 text-sky-300" />}
      >
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Coin</div>
              <div className="mt-2 break-all text-xl font-bold tracking-[0.08em] text-white">{activeSymbol}</div>
            </div>

            <div className={`flex items-center justify-between rounded-2xl border px-4 py-4 ${tone.badge}`}>
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] opacity-80">Signal</div>
                <div className="mt-2 text-2xl font-extrabold tracking-[0.12em]">{displayAnalysis.direction}</div>
              </div>
              <div className="ml-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/15">
                <DirectionIcon className="h-5 w-5" />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Summary</div>
            <p className="mt-2 text-sm leading-6 text-slate-200">{displayAnalysis.summary}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Entry</div>
              <div className="mt-2 text-lg font-semibold text-white">{displayAnalysis.entryPrice ? formatPrice(displayAnalysis.entryPrice, 5) : 'Wait'}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Confidence</div>
              <div className="mt-2 text-lg font-semibold text-white">{formatPercent((displayAnalysis.confidence || 0) * 100)}</div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.24em] text-slate-500">{checklistLabel}</div>
                <div className="mt-2 text-sm text-slate-300">{modelSignalSummary}</div>
              </div>
              <div className={`rounded-2xl border px-3 py-2 text-right ${
                ready
                  ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                  : 'border-sky-400/20 bg-sky-400/10 text-sky-100'
              }`}>
                <div className={`text-[11px] uppercase tracking-[0.18em] ${ready ? 'text-emerald-200/70' : 'text-sky-200/70'}`}>
                  {ready ? 'Possible Trade' : 'Signals Active'}
                </div>
                <div className="mt-1 text-lg font-semibold">
                  {modelChecklistAnalysis ? `${passedChecklistCount}/${modelChecklistAnalysis.maxScore}` : activeModel.totalSignals}
                </div>
              </div>
            </div>

            {activeModel.status === 'blank' ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/45 px-4 py-4 text-sm text-slate-400">
                No checklist yet. Add the next model rules here when Bot 3 is ready.
              </div>
            ) : checklist.length > 0 ? (
              <div className="space-y-3">
                {checklist.map((signal) => (
                  <div
                    key={signal.key}
                    className={`rounded-2xl border px-4 py-3 transition ${
                      signal.passed
                        ? 'border-emerald-400/20 bg-emerald-400/12 shadow-[0_0_0_1px_rgba(74,222,128,0.06)]'
                        : 'border-white/10 bg-white/[0.03]'
                    }`}
                  >
                    <div className="flex items-start gap-3 text-sm">
                      {signal.passed ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      ) : (
                        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                      )}
                      <div>
                        <div className={signal.passed ? 'font-medium text-emerald-100' : 'text-slate-100'}>{signal.label}</div>
                        <div className="mt-1 text-xs leading-5 text-slate-400">{signal.detail}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-slate-950/45 px-4 py-4 text-sm text-slate-400">
                Waiting for the active model scan to return a live checklist.
              </div>
            )}

            {modelChecklistAnalysis ? (
              <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
                ready
                  ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                  : 'border-white/10 bg-slate-950/45 text-slate-300'
              }`}>
                {ready
                  ? `${activeModel.name} has met its trade threshold on the ${modelChecklistAnalysis.checklistSide.toLowerCase()} side. A possible trade is available.`
                  : `${passedChecklistCount}/${modelChecklistAnalysis.maxScore} ${modelChecklistAnalysis.checklistSide.toLowerCase()} signals are active. More confirmations are still needed.`}
                {modelChecklistAnalysis.professionalRequiredCount > 0 ? ` Professional filters: ${modelChecklistAnalysis.professionalSignalScore}/${activeModel.professionalSignalCount}.` : ''}
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-slate-500">
              <ShieldAlert className="h-4 w-4" />
              Pro Exit Strategy
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Take Profit</span>
                <span className="font-medium text-slate-100">{displayAnalysis.takeProfit ? formatPrice(displayAnalysis.takeProfit, 5) : 'Wait'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Stop Loss</span>
                <span className="font-medium text-slate-100">{displayAnalysis.stopLoss ? formatPrice(displayAnalysis.stopLoss, 5) : 'Wait'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Support</span>
                <span className="font-medium text-slate-100">{displayAnalysis.support ? formatPrice(displayAnalysis.support, 5) : 'N/A'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Resistance</span>
                <span className="font-medium text-slate-100">{displayAnalysis.resistance ? formatPrice(displayAnalysis.resistance, 5) : 'N/A'}</span>
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}
