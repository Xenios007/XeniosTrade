import { useMemo } from 'react'
import { ALL_EXPERIMENTS, filterByExperiment, summarizeExperimentTrades } from '../../lib/aiExperiments'
import { Panel } from '../Panel'

const money = (value) => (value == null ? '—' : `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}`)
const pct = (value, digits = 1) => (value == null ? '—' : `${(value * 100).toFixed(digits)}%`)
const pctPlain = (value) => (value == null ? '—' : `${value.toFixed(2)}%`)
const tone = (value) => (value == null ? 'text-slate-300' : value > 0 ? 'text-emerald-300' : value < 0 ? 'text-rose-300' : 'text-slate-300')

function hold(minutes) {
  if (minutes == null) return '—'
  if (minutes < 120) return `${minutes} min`
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`
  return `${(minutes / 1440).toFixed(1)} d`
}

const EXIT_LABELS = { tp: 'target', sl: 'stop', 'position-manager': 'Position Manager', manual: 'manual', sync: 'exchange sync' }

/** One row per experiment (same wallet), so the pipeline settings can be compared on the numbers that matter: fees, hit rate, size of wins vs losses. */
export function ExperimentComparison({ trades, experiments, selected, onSelect, title = 'Compare experiments' }) {
  const rows = useMemo(() => experiments
    .filter((item) => item.tag !== ALL_EXPERIMENTS)
    .map((item) => ({ ...item, stats: summarizeExperimentTrades(filterByExperiment(trades, item.tag)) })), [trades, experiments])

  const columns = [
    ['Trades', (s) => `${s.closed}${s.open ? ` (+${s.open} open)` : ''}`],
    ['W / L', (s) => `${s.wins} / ${s.losses}`],
    ['Win rate', (s) => pct(s.winRate)],
    ['PnL (price)', (s) => money(s.pnl), (s) => tone(s.pnl)],
    ['Est. fees', (s) => (s.estFees == null ? '—' : `-${s.estFees.toFixed(2)}`)],
    ['PnL after fees', (s) => money(s.netPnl), (s) => tone(s.netPnl)],
    ['Avg win / loss', (s) => `${money(s.avgWin)} / ${money(s.avgLoss)}`],
    ['Profit factor', (s) => (s.profitFactor == null ? '—' : s.profitFactor.toFixed(2))],
    ['Avg stop / target', (s) => `${pctPlain(s.avgStopPct)} / ${pctPlain(s.avgTargetPct)}`],
    ['Avg hold', (s) => hold(s.avgHoldMinutes)],
    ['Avg leverage', (s) => (s.avgLeverage == null ? '—' : `${s.avgLeverage}x`)],
    ['Exits', (s) => Object.entries(s.byExit).map(([key, count]) => `${count} ${EXIT_LABELS[key] || key}`).join(', ') || '—'],
  ]

  return (
    <Panel title={title}>
      <div className="grid gap-3">
        <p className="text-xs leading-relaxed text-slate-500">
          Every pipeline setting is scored separately. PnL on a trade is the price move only, so fees are estimated at a 0.1% round trip on the
          position size (a maker entry pays less). Small samples prove nothing: judge an experiment on 200 decided trades or more (see Shadow outcomes).
        </p>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-slate-500">
                <th className="py-2 pr-3 font-medium">Metric</th>
                {rows.map((row) => (
                  <th key={row.tag} className="py-2 pr-3 font-medium">
                    <button
                      type="button"
                      onClick={() => onSelect?.(row.tag)}
                      className={`text-left hover:text-sky-200 ${row.tag === selected ? 'text-sky-300' : 'text-slate-300'}`}
                    >
                      {row.name}
                      {row.current ? <span className="ml-1 text-[10px] uppercase tracking-wider text-sky-400">now</span> : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map(([label, render, colour]) => (
                <tr key={label} className="border-b border-white/5">
                  <td className="py-2 pr-3 text-slate-500">{label}</td>
                  {rows.map((row) => (
                    <td key={row.tag} className={`py-2 pr-3 ${colour ? colour(row.stats) : 'text-slate-200'}`}>{render(row.stats)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  )
}
