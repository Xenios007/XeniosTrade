import { CheckCircle2, Lock, TrendingDown, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Panel } from './Panel'
import { PageHeader } from './ui/PageHeader'

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }
  return payload
}

function formatUsdt(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function SignalCard({ listing, onRequest, requesting, requested }) {
  const stats = listing.stats
  const profitable = stats ? stats.totalUsd > 0 : null

  return (
    <div className={`rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.18)] ${
      listing.owned ? 'border-emerald-400/20 bg-emerald-400/[0.04]' : 'border-white/10 bg-white/[0.03]'
    }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{listing.name}</div>
          <div className="mt-1 text-lg font-semibold text-white">{listing.tag}</div>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
          listing.owned
            ? 'border-emerald-400/30 bg-emerald-400/15 text-emerald-100'
            : 'border-white/10 bg-white/[0.04] text-slate-400'
        }`}
        >
          {listing.owned ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          {listing.owned ? 'Owned' : 'Locked'}
        </span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-300">{listing.description}</p>

      {stats ? (
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Win Rate</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{stats.winRate.toFixed(1)}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Backtest P/L</div>
            <div className={`mt-1 flex items-center gap-1 text-sm font-semibold ${profitable ? 'text-emerald-300' : 'text-rose-300'}`}>
              {profitable ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
              {formatUsdt(stats.totalUsd)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Trades</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{stats.trades.toLocaleString()}</div>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-3 text-xs text-slate-500">
          No backtest data yet for this signal.
        </div>
      )}

      {listing.owned ? (
        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Execution Rule</div>
          <div className="mt-2 text-sm leading-relaxed text-slate-200">{listing.executionRule}</div>
          <div className="mt-2 text-xs text-slate-500">Minimum score: {listing.minimumScore}</div>
        </div>
      ) : (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <div className="text-xs leading-relaxed text-slate-400">
            Strategy rules and thresholds unlock once you own this signal.
          </div>
          <button
            type="button"
            disabled={requesting || requested}
            onClick={() => onRequest(listing.id)}
            className="shrink-0 rounded-xl bg-sky-400/15 px-3 py-2 text-xs font-semibold text-sky-100 ring-1 ring-sky-400/30 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {requested ? 'Requested' : requesting ? 'Requesting…' : 'Request Access'}
          </button>
        </div>
      )}
    </div>
  )
}

export function SignalsMarketplacePage() {
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [requestingId, setRequestingId] = useState('')
  const [requestedIds, setRequestedIds] = useState(new Set())

  useEffect(() => {
    let ignore = false
    fetchJson('/api/signals-marketplace')
      .then((payload) => {
        if (!ignore) {
          setCatalog(payload)
        }
      })
      .catch((fetchError) => {
        if (!ignore) {
          setError(fetchError instanceof Error ? fetchError.message : 'Unable to load the marketplace.')
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false)
        }
      })

    return () => {
      ignore = true
    }
  }, [])

  async function handleRequest(signalId) {
    setRequestingId(signalId)
    setError('')

    try {
      await fetchJson(`/api/signals-marketplace/${signalId}/request`, { method: 'POST' })
      setRequestedIds((current) => new Set(current).add(signalId))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to send the request.')
    } finally {
      setRequestingId('')
    }
  }

  const ownedCount = catalog?.listings?.filter((listing) => listing.owned).length ?? 0
  const totalCount = catalog?.listings?.length ?? 0

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Signals Marketplace"
        description="Every bot's strategy family, with real backtest results - not fabricated numbers. Own a signal to see its exact rules and trade it on one of your bot slots."
      />

      {catalog?.backtestRunDate ? (
        <div className="text-xs text-slate-500">
          Stats from the most recent full backtest run, {new Date(catalog.backtestRunDate).toLocaleDateString()}.
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      <Panel title={`Signals (${ownedCount} of ${totalCount} owned)`}>
        {loading ? (
          <div className="text-sm text-slate-400">Loading the marketplace...</div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {(catalog?.listings || []).map((listing) => (
              <SignalCard
                key={listing.id}
                listing={listing}
                onRequest={handleRequest}
                requesting={requestingId === listing.id}
                requested={requestedIds.has(listing.id)}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
