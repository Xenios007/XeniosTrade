import { useCallback, useEffect, useState } from 'react'
import { ALL_EXPERIMENTS, describeExperiment } from '../../lib/aiExperiments'
import { Badge } from '../ui/Badge'

// The experiment picked on one AI page (Journal, Trade History, Run History) carries over to the others. Remembered in this browser
// only; with nothing picked, the experiment configured now is shown.
const STORAGE_KEY = 'xenios.aiExperiment'
const CHANGED_EVENT = 'xenios:ai-experiment-changed'

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function useAiExperiment(current) {
  const [stored, setStored] = useState(readStored)

  useEffect(() => {
    const sync = () => setStored(readStored())
    window.addEventListener(CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const select = useCallback((tag) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, tag)
    } catch {
      // Private window or blocked storage: the choice just is not remembered.
    }
    setStored(tag)
    window.dispatchEvent(new Event(CHANGED_EVENT))
  }, [])

  return [stored || current || null, select]
}

/** `experiments` from listExperiments(); `value` an experiment tag or ALL_EXPERIMENTS. */
export function ExperimentPicker({ experiments, value, onChange, note }) {
  const options = value && !experiments.some((item) => item.tag === value) ? [describeExperiment(value), ...experiments] : experiments
  const selected = options.find((item) => item.tag === value) || options[0]
  if (!selected) return null

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-100">
          Experiment
          {selected.current ? <Badge tone="info">Running now</Badge> : null}
          {selected.tag !== ALL_EXPERIMENTS && selected.agents ? <Badge tone="neutral">{selected.agents}-agent pipeline</Badge> : null}
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          {selected.style}{selected.switches?.length ? ` · ${selected.switches.join(', ')}` : ''}
          {note ? ` · ${note}` : ''}
        </div>
      </div>
      <select
        value={selected.tag}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Experiment"
        className="w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none sm:w-auto sm:max-w-[360px]"
      >
        {options.map((item) => (
          <option key={item.tag} value={item.tag}>
            {item.name}{item.current ? ' (running now)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
