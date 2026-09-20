import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { requestJson } from '../../lib/aiTradingApi'

export const AI_CONFIG_CHANGED_EVENT = 'ai-trading-config-changed'

// Top-bar indicator of where approved AI decisions would trade. Kept loud for real money:
// amber while disarmed, red while armed.
export function AiModeBadge() {
  const [execution, setExecution] = useState(null)

  useEffect(() => {
    let alive = true
    const load = () => requestJson('/api/ai-trading/config')
      .then((payload) => { if (alive) setExecution(payload.config.execution) })
      .catch(() => {})
    load()
    const timer = setInterval(load, 30_000)
    window.addEventListener(AI_CONFIG_CHANGED_EVENT, load)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener(AI_CONFIG_CHANGED_EVENT, load)
    }
  }, [])

  if (!execution) {
    return <span className="inline-flex items-center rounded-full border border-white/10 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-500">AI Trading</span>
  }

  const real = execution.mode === 'real'
  const tone = !real
    ? 'border-sky-400/20 bg-sky-400/10 text-sky-200'
    : execution.realArmed
      ? 'border-rose-400/40 bg-rose-400/15 text-rose-200'
      : 'border-amber-400/30 bg-amber-400/10 text-amber-200'
  const label = !real ? 'Testnet mode' : execution.realArmed ? 'Real money · armed' : 'Real money · disarmed'

  return (
    <Link to="/ai-settings" title="Change trading mode" className={`inline-flex items-center rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] ${tone}`}>
      {label}
    </Link>
  )
}
