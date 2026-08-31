import { ShieldAlert } from 'lucide-react'
import { formatPrice } from '../lib/formatters'
import { Panel } from './Panel'

/**
 * Take-profit / stop-loss / support / resistance readout for the active
 * model analysis. Lives next to the chart on the Market tab.
 */
export function ProExitStrategy({ analysis }) {
  const displayAnalysis = analysis || {}

  const rows = [
    {
      label: 'Take Profit',
      value: displayAnalysis.takeProfit ? formatPrice(displayAnalysis.takeProfit, 5) : 'Wait',
      set: Boolean(displayAnalysis.takeProfit),
      valueTone: 'text-emerald-300',
      cardTone: 'border-emerald-400/25 bg-emerald-400/[0.07]',
    },
    {
      label: 'Stop Loss',
      value: displayAnalysis.stopLoss ? formatPrice(displayAnalysis.stopLoss, 5) : 'Wait',
      set: Boolean(displayAnalysis.stopLoss),
      valueTone: 'text-rose-300',
      cardTone: 'border-rose-400/25 bg-rose-400/[0.07]',
    },
    {
      label: 'Support',
      value: displayAnalysis.support ? formatPrice(displayAnalysis.support, 5) : 'N/A',
      set: Boolean(displayAnalysis.support),
      valueTone: 'text-sky-300',
      cardTone: 'border-sky-400/25 bg-sky-400/[0.07]',
    },
    {
      label: 'Resistance',
      value: displayAnalysis.resistance ? formatPrice(displayAnalysis.resistance, 5) : 'N/A',
      set: Boolean(displayAnalysis.resistance),
      valueTone: 'text-amber-300',
      cardTone: 'border-amber-400/25 bg-amber-400/[0.07]',
    },
  ]

  return (
    <Panel
      title="Pro Exit Strategy"
      action={<ShieldAlert className="h-4 w-4 text-sky-300" />}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => (
          <div
            key={row.label}
            className={`rounded-2xl border px-4 py-4 ${row.set ? row.cardTone : 'border-white/10 bg-slate-950/60'}`}
          >
            <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{row.label}</div>
            <div className={`mt-2 text-lg font-semibold ${row.set ? row.valueTone : 'text-slate-500'}`}>
              {row.value}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}
