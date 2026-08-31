import { BrainCircuit } from 'lucide-react'
import { formatDateTimeWithSeconds } from '../lib/formatters'
import { Panel } from './Panel'

function formatPercent(value, fractionDigits = 1) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue)) {
    return 'N/A'
  }

  return `${numericValue.toFixed(fractionDigits)}%`
}

function formatTradeCount(value) {
  const count = Number(value || 0)
  return `${count} trade${count === 1 ? '' : 's'}`
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

// The read-only AI advisory readout. It used to live inline in the Mock Trading
// control room; it now has its own page under AI Training. `analysis` is the
// same server-side signal-model analysis payload the Mock Trading page consumes.
export function AIAdvisoryPanel({ analysis }) {
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

  return (
    <Panel title="AI Advisory" action={<BrainCircuit className="h-4 w-4 text-sky-300" />}>
      <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
        This is the read-only AI advisory for the bot currently in analysis focus. It never blocks a trade on its own — it
        reports what the learned model thinks of the latest setup. Change the analysis focus from Mock Trading &rarr; Signal Models.
      </div>

      <div className={`mt-4 rounded-[26px] border p-5 ${getAiAdvisoryPanelTone(aiAdvisory?.status)}`}>
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
    </Panel>
  )
}
