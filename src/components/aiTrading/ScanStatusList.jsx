import { formatDateTime } from '../../lib/formatters'
import { Badge } from '../ui/Badge'

const OUTCOME_TONE = { opened: 'up', approved: 'up', error: 'down' }

/** Last auto-scan cycle plus the latest outcome per symbol (from `GET /api/ai-trading/config` -> `scanStatus`). */
export function ScanStatusList({ scanStatus, enabled }) {
  const results = scanStatus?.results && Object.keys(scanStatus.results).length ? Object.entries(scanStatus.results) : []
  const headline = scanStatus?.running
    ? 'Scanning now…'
    : scanStatus?.lastFinishedAt
      ? `Last scan finished ${formatDateTime(scanStatus.lastFinishedAt)}`
      : enabled === false ? 'Auto-scan is off.' : 'No scan has run yet.'

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 text-xs text-slate-400">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{headline}</span>
        {scanStatus?.lastError ? <span className="text-rose-300">Last error: {scanStatus.lastError}</span> : null}
      </div>
      {results.length ? (
        <ul className="mt-2 grid gap-1">
          {results.map(([symbol, result]) => (
            <li key={symbol} className="flex flex-wrap items-baseline gap-x-2">
              <span className="w-16 shrink-0 font-medium text-slate-200">{symbol.replace('USDT', '')}</span>
              <Badge tone={OUTCOME_TONE[result.outcome] || 'neutral'}>{result.outcome}</Badge>
              <span className="min-w-0 flex-1 truncate text-slate-500" title={result.detail}>{result.detail}</span>
              <span className="shrink-0 text-slate-600">{formatDateTime(result.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
