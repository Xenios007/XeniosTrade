import { useEffect, useState } from 'react'
import { BrainCircuit } from 'lucide-react'
import { getLearningBotSignalInsights } from '../lib/api'
import { Panel } from './Panel'

const BOT_LABELS = {
  'model-1': 'Bot 1',
  'model-2': 'Bot 2',
  'model-3': 'Bot 3',
  'model-4': 'Bot 4',
}

const VERDICT_STYLES = {
  works: 'bg-emerald-400/12 text-emerald-200',
  marginal: 'bg-amber-400/12 text-amber-100',
  losing: 'bg-rose-400/15 text-rose-200',
}

function fmtTs(value) {
  const ts = Number(value || 0)
  if (!Number.isFinite(ts) || ts <= 0) return 'unknown'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(ts)
}

function BotBlock({ modelId, families }) {
  const works = families.filter((f) => f.verdict === 'works')
  const losing = families.filter((f) => f.verdict === 'losing').sort((a, b) => b.count - a.count)
  return (
    <article className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <div className="text-lg font-semibold text-white">{BOT_LABELS[modelId] || modelId}</div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm text-slate-300">
          <thead className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">Setup family</th>
              <th className="py-2 pr-3">Count</th>
              <th className="py-2 pr-3">Win %</th>
              <th className="py-2 pr-3">Avg reward</th>
              <th className="py-2 pr-3">Entry qual.</th>
              <th className="py-2 pr-3">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {families.map((f) => (
              <tr key={f.family} className="border-t border-white/5">
                <td className="py-2 pr-3 text-white">{f.family}</td>
                <td className="py-2 pr-3">{f.count}</td>
                <td className="py-2 pr-3">{f.winRate.toFixed(1)}%</td>
                <td className={`py-2 pr-3 ${f.avgReward >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{f.avgReward.toFixed(2)}</td>
                <td className="py-2 pr-3">{f.avgEntryQuality.toFixed(0)}</td>
                <td className="py-2 pr-3">
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${VERDICT_STYLES[f.verdict] || 'bg-slate-800 text-slate-300'}`}>
                    {f.verdict}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-xs text-slate-400">
        {works.length
          ? <>Lean into: <span className="text-emerald-300">{works.map((f) => f.family).join(', ')}</span>. </>
          : <>No family clears the "works" bar (avg reward &gt; 0 and win rate ≥ 45%). </>}
        {losing.length
          ? <>Redesign or drop: <span className="text-rose-300">{losing.slice(0, 3).map((f) => f.family).join(', ')}</span>.</>
          : null}
      </div>
    </article>
  )
}

export function SignalInsightsPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let ignore = false
    getLearningBotSignalInsights()
      .then((payload) => { if (!ignore) { setData(payload); setError('') } })
      .catch((err) => { if (!ignore) setError(err instanceof Error ? err.message : 'Unable to load signal insights') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [])

  const bots = data?.bots || []

  return (
    <div className="grid gap-6">
      <Panel title="Signal Insights" action={<BrainCircuit className="h-4 w-4 text-sky-300" />}>
        <p className="text-sm leading-6 text-slate-300">
          What the trained policy has learned per bot and setup family, from the merged live + backtest dataset.
          Use it to decide which entry ideas to keep, redesign, or drop before building the next signal.
        </p>
        {data ? (
          <div className="mt-3 text-xs text-slate-500">
            {data.rows?.toLocaleString?.() || data.rows || 0} rows · {data.framework || 'model'} · action alignment {Number(data.actionAlignment || 0).toFixed(1)} · trained {fmtTs(data.generatedAt)}
          </div>
        ) : null}
        <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-xs text-slate-400">
          <strong className="text-slate-300">works</strong> = avg reward &gt; 0 and win rate ≥ 45% ·{' '}
          <strong className="text-slate-300">marginal</strong> = avg reward ≥ −1 ·{' '}
          <strong className="text-slate-300">losing</strong> = worse than −1 avg reward
        </div>
        {error ? <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
        {loading ? <div className="mt-4 text-sm text-slate-500">Loading…</div> : null}
        {!loading && !error && !bots.length ? (
          <div className="mt-4 text-sm text-slate-500">No trained policy artifact found yet. Run AI training first.</div>
        ) : null}
      </Panel>

      {bots.map((bot) => (
        <BotBlock key={bot.modelId} modelId={bot.modelId} families={bot.families} />
      ))}
    </div>
  )
}
