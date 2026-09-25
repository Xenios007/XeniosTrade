import { useEffect, useState } from 'react'
import { Panel } from '../Panel'
import { Badge } from '../ui/Badge'

const pct = (value, digits = 0) => (value == null ? '—' : `${(value * 100).toFixed(digits)}%`)
const signedPct = (value) => (value == null ? '—' : `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`)

// How to read a group's hit rate against break-even and the "no skill" baseline.
function verdictFor(group) {
  if (group.targetRate == null || group.breakEvenRate == null) return null
  if (group.weak) return { tone: 'warn', label: 'Weak evidence' }
  if (group.targetRateLow > group.breakEvenRate) return { tone: 'up', label: 'Clearly above break-even' }
  if (group.targetRateHigh < group.breakEvenRate) return { tone: 'down', label: 'Clearly below break-even' }
  return { tone: 'neutral', label: 'Inconclusive' }
}

// One group per card: same fields as the table, stacked, for viewports too narrow for the 9-column table.
function SummaryCards({ groups }) {
  return (
    <div className="grid min-w-0 gap-2 sm:hidden">
      {groups.map((group) => {
        const verdict = verdictFor(group)
        return (
          <div key={group.key} className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-words font-medium text-white">{group.label}</span>
              {verdict ? <Badge tone={verdict.tone}>{verdict.label}</Badge> : <span className="text-slate-500">—</span>}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-slate-300">
              <div className="min-w-0"><span className="text-slate-500">Signals </span>{group.signals}{group.pending ? <span className="text-slate-500"> ({group.pending} pending)</span> : null}</div>
              <div className="min-w-0"><span className="text-slate-500">Decided </span>{group.decided}<span className="text-slate-500"> · {group.expired} exp.</span></div>
              <div className="min-w-0"><span className="text-slate-500">Target first </span>{pct(group.targetRate)}</div>
              <div className="min-w-0"><span className="text-slate-500">Break-even </span>{pct(group.breakEvenRate)}</div>
              <div className="col-span-2 min-w-0"><span className="text-slate-500">95% range </span>{group.targetRateLow == null ? '—' : `${pct(group.targetRateLow)} – ${pct(group.targetRateHigh)}`}</div>
              <div className="min-w-0"><span className="text-slate-500">No-skill baseline </span>{pct(group.baselineTargetRate)}{group.baselineSignals ? <span className="text-slate-500"> (n={group.baselineSignals})</span> : null}</div>
              <div className="min-w-0"><span className="text-slate-500">Avg net / signal </span>{signedPct(group.avgNetPct)}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SummaryTable({ summary }) {
  if (!summary?.groups?.length || summary.groups[0].signals === 0) {
    return <div className="py-4 text-center text-sm text-slate-400">No signals recorded yet.</div>
  }
  return (
    <>
      <SummaryCards groups={summary.groups} />
      <div className="hidden min-w-0 overflow-x-auto sm:block">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
            <tr>
              <th className="py-2 pr-3 font-medium">Where the signal went</th>
              <th className="py-2 pr-3 font-medium">Signals</th>
              <th className="py-2 pr-3 font-medium">Decided</th>
              <th className="py-2 pr-3 font-medium">Target first</th>
              <th className="py-2 pr-3 font-medium">95% range</th>
              <th className="py-2 pr-3 font-medium">Break-even</th>
              <th className="py-2 pr-3 font-medium">No-skill baseline</th>
              <th className="py-2 pr-3 font-medium">Avg net / signal</th>
              <th className="py-2 font-medium">Reading</th>
            </tr>
          </thead>
          <tbody className="text-slate-200">
            {summary.groups.map((group) => {
              const verdict = verdictFor(group)
              return (
                <tr key={group.key} className="border-t border-white/5">
                  <td className="py-2 pr-3 font-medium text-white">{group.label}</td>
                  <td className="py-2 pr-3">{group.signals}{group.pending ? <span className="text-slate-500"> ({group.pending} pending)</span> : null}</td>
                  <td className="py-2 pr-3">{group.decided}<span className="text-slate-500"> · {group.expired} expired</span></td>
                  <td className="py-2 pr-3">{pct(group.targetRate)}</td>
                  <td className="py-2 pr-3 text-slate-400">{group.targetRateLow == null ? '—' : `${pct(group.targetRateLow)} – ${pct(group.targetRateHigh)}`}</td>
                  <td className="py-2 pr-3">{pct(group.breakEvenRate)}</td>
                  <td className="py-2 pr-3">{pct(group.baselineTargetRate)}{group.baselineSignals ? <span className="text-slate-500"> (n={group.baselineSignals})</span> : null}</td>
                  <td className="py-2 pr-3">{signedPct(group.avgNetPct)}</td>
                  <td className="py-2">{verdict ? <Badge tone={verdict.tone}>{verdict.label}</Badge> : <span className="text-slate-500">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * Shadow outcomes: what every Analyst LONG/SHORT would have done with its own stop/target, whether or not a gate blocked it, so the gates
 * (Market Flow, Critic, Risk Manager) can be judged on many samples. Free (public candles); read-only.
 */
// `experiment`: the pipeline setting picked on the page (an aiStrategyTag, or 'all'); only its signals are summarized, and its real-money
// readiness is shown. Without one, the experiment configured now is used.
export function ShadowOutcomesPanel({ experiment = null }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [showTest, setShowTest] = useState(false)
  // Only signals newer than this many hours (0 = everything). Lets a prompt change be judged on the signals made after it.
  const [sinceHours, setSinceHours] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = (refresh) => {
      const params = new URLSearchParams()
      if (refresh) params.set('refresh', '1')
      if (sinceHours > 0) params.set('since', String(Date.now() - sinceHours * 3_600_000))
      if (experiment && experiment !== 'all') params.set('strategy', experiment)
      const query = params.toString()
      fetch(`/api/ai-trading/shadow${query ? `?${query}` : ''}`)
        .then((response) => response.json().then((payload) => ({ response, payload })))
        .then(({ response, payload }) => {
          if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
          if (!cancelled) { setData(payload); setError('') }
        })
        .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load shadow outcomes.') })
    }
    load(true)
    const timer = setInterval(() => { if (!document.hidden) load(false) }, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sinceHours, experiment])

  const allExperiments = experiment === 'all'
  const summary = showTest ? data?.testModeSummary : (!allExperiments && data?.strategySummary ? data.strategySummary : data?.summary)
  const readiness = allExperiments ? null : data?.strategySummary?.readiness
  const criticRate = summary?.criticRejectRate

  return (
    <Panel
      title="Shadow outcomes"
      action={(
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sinceHours}
            onChange={(event) => setSinceHours(Number(event.target.value))}
            aria-label="Signals to include"
            className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-xs text-slate-300 outline-none"
          >
            <option value={0}>All signals</option>
            <option value={24}>Last 24 hours</option>
            <option value={6}>Last 6 hours</option>
            <option value={2}>Last 2 hours</option>
          </select>
          <button
            type="button"
            onClick={() => setShowTest((value) => !value)}
            className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 hover:border-white/20"
          >
            {showTest ? 'Showing test-mode signals' : 'Showing normal-mode signals'}
          </button>

        </div>
      )}
    >
      <div className="grid gap-3">
        <p className="text-xs leading-relaxed text-slate-400">
          Every time the Analyst went LONG or SHORT, its own stop and target are replayed against 1-minute prices to see which was hit first, whether or not a stage blocked the
          trade. Compare each stage&apos;s hit rate with the break-even rate and with the no-skill baseline (the same bracket entered every 5 minutes through the hour after the signal).
          {summary ? ` Fees assumed at ${summary.feePct}% round trip; signals are followed for ${summary.horizonMinutes} minutes; a candle touching both levels counts as a stop.` : ''}
        </p>
        {error ? <div className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">{error}</div> : null}
        {readiness && !showTest ? (
          <div className={`rounded-xl border px-3 py-2 text-xs ${readiness.ready ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200' : 'border-white/10 bg-slate-950/50 text-slate-300'}`}>
            Real-money readiness ({data.strategy}): {readiness.message}
          </div>
        ) : null}
        {!data && !error ? <div className="py-4 text-center text-sm text-slate-400">Loading…</div> : null}
        {data ? <SummaryTable summary={summary} /> : null}
        {criticRate != null ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Critic REJECT rate among signals it reviewed:</span>
            <Badge tone={criticRate > 0.6 ? 'warn' : 'neutral'}>{pct(criticRate)}</Badge>
            <span className="text-slate-500">
              (PASS {summary.verdicts.critic.PASS || 0} · CAUTION {summary.verdicts.critic.CAUTION || 0} · REJECT {summary.verdicts.critic.REJECT || 0}; the aim is roughly 20–40%)
            </span>
          </div>
        ) : null}
        <p className="text-[11px] leading-relaxed text-slate-500">
          A rate on fewer than 30 decided signals is weak evidence, so the 95% range is shown. &quot;Reading&quot; only calls a stage clearly above or below break-even when that whole range is on one side of it.
        </p>
      </div>
    </Panel>
  )
}
