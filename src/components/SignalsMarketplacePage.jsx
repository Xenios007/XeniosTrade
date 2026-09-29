import {
  Boxes,
  CheckCircle2,
  ChevronDown,
  Hammer,
  Layers,
  Lock,
  Search,
  ShoppingCart,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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

// Storefront layout modelled on how comparable trading-bot marketplaces present products
// (Cryptohopper separates signals / strategies / templates; 3Commas filters by popular / free /
// on sale; MQL5 leads with performance stats and lets you compare before buying): two product
// types as tabs, a search + filter + sort toolbar, stat-forward cards, and a cart for buying
// several individual signals at once. Buying stays instant self-service - see
// /api/marketplace/signal-item/buy and /bot-signal/buy. Signals have no stats of their own, so
// a signal always shows its parent bot's real backtest row count, labelled as such.

const SORT_OPTIONS = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'rows', label: 'Most backtest rows' },
  { id: 'signals', label: 'Most signals' },
  { id: 'name', label: 'Name' },
]

const OWNERSHIP_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'available', label: 'Available' },
  { id: 'owned', label: 'Owned' },
]

// A bot counts as fully owned when it was bought outright, or when every one of its signals
// has been bought individually (the signals are what you actually get to build with).
function isFullyOwned(listing) {
  const signals = listing.signals || []
  return listing.owned || (signals.length > 0 && signals.every((signal) => signal.owned))
}

function StatsStrip({ stats, compact = false }) {
  if (!stats) {
    return <div className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-500">No backtest data yet.</div>
  }
  return (
    <div className={`rounded-2xl border border-white/10 bg-slate-950/60 ${compact ? 'p-2.5' : 'p-3'}`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Backtest rows</div>
      <div className="mt-1 text-sm font-semibold text-slate-100">{stats.trades.toLocaleString()} <span className="font-normal text-slate-500">simulated trades</span></div>
    </div>
  )
}

function BotProductCard({ listing, onBuyBot, onBuySignal, buyingId, cart, onToggleCart }) {
  const [expanded, setExpanded] = useState(false)
  const signals = listing.signals || []
  const ownedCount = signals.filter((signal) => signal.owned).length
  const buyingBot = buyingId === listing.id
  const fullyOwned = isFullyOwned(listing)

  return (
    <div className={`flex flex-col rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.18)] ${
      fullyOwned ? 'border-emerald-400/20 bg-emerald-400/[0.04]' : 'border-white/10 bg-white/[0.03]'
    }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{listing.name}</div>
          <div className="mt-1 text-lg font-semibold text-white">{listing.tag}</div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
          fullyOwned
            ? 'border-emerald-400/30 bg-emerald-400/15 text-emerald-100'
            : ownedCount > 0
              ? 'border-sky-400/30 bg-sky-400/10 text-sky-100'
              : 'border-white/10 bg-white/[0.04] text-slate-400'
        }`}
        >
          {fullyOwned ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          {fullyOwned ? 'Owned' : `${ownedCount}/${signals.length} owned`}
        </span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-300">{listing.description}</p>

      <div className="mt-4"><StatsStrip stats={listing.stats} /></div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {signals.slice(0, expanded ? 0 : 4).map((signal) => (
          <span
            key={signal.id}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              signal.owned ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100' : 'border-white/10 bg-white/[0.03] text-slate-300'
            }`}
          >
            {signal.label}
          </span>
        ))}
        {!expanded && signals.length > 4 ? (
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-500">+{signals.length - 4} more</span>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-1 grid gap-2">
          {signals.map((signal) => {
            const inCart = cart.has(signal.id)
            return (
              <div key={signal.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-slate-200">{signal.label}</div>
                  {signal.owned ? <div className="truncate text-[11px] text-slate-500">{signal.detail}</div> : null}
                </div>
                {signal.owned ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Owned
                  </span>
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onToggleCart(signal.id)}
                      className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ring-1 transition ${
                        inCart ? 'bg-violet-400/20 text-violet-100 ring-violet-400/40' : 'bg-white/[0.04] text-slate-300 ring-white/10 hover:bg-white/[0.08]'
                      }`}
                    >
                      {inCart ? 'In cart' : 'Add'}
                    </button>
                    <button
                      type="button"
                      disabled={buyingId === signal.id}
                      onClick={() => onBuySignal(listing.id, signal.key)}
                      className="rounded-lg bg-sky-400/15 px-2.5 py-1.5 text-[11px] font-semibold text-sky-100 ring-1 ring-sky-400/30 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {buyingId === signal.id ? 'Buying…' : 'Buy'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      {listing.owned ? (
        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Execution rule</div>
          <div className="mt-2 text-sm leading-relaxed text-slate-200">{listing.executionRule}</div>
          <div className="mt-2 text-xs text-slate-500">Minimum score: {listing.minimumScore}</div>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {!listing.owned ? (
          <button
            type="button"
            disabled={buyingBot}
            onClick={() => onBuyBot(listing.id)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-400 px-4 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShoppingCart className="h-3.5 w-3.5" />
            {buyingBot ? 'Buying…' : fullyOwned ? 'Get the bot itself' : `Buy whole bot - ${signals.length} signals`}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08]"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Hide signals' : `Browse ${signals.length} signals`}
        </button>
      </div>
    </div>
  )
}

function SignalTile({ signal, listing, inCart, onToggleCart, onBuy, buying }) {
  return (
    <div className={`flex flex-col rounded-2xl border p-4 transition ${
      signal.owned ? 'border-emerald-400/20 bg-emerald-400/[0.04]' : inCart ? 'border-violet-400/40 bg-violet-400/[0.06]' : 'border-white/10 bg-white/[0.03]'
    }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{signal.label}</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">{listing.name} - {listing.tag}</div>
        </div>
        {signal.owned ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> Owned
          </span>
        ) : null}
      </div>

      {signal.owned ? (
        <p className="mt-2 text-xs leading-relaxed text-slate-400">{signal.detail}</p>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
          <Lock className="h-3 w-3" /> Rule details unlock when you own it.
        </p>
      )}

      <div className="mt-3">
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-slate-500">Parent bot backtest</div>
        <StatsStrip stats={listing.stats} compact />
      </div>

      {!signal.owned ? (
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={buying}
            onClick={() => onBuy(listing.id, signal.key)}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-sky-400/15 px-3 py-2 text-xs font-semibold text-sky-100 ring-1 ring-sky-400/30 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ShoppingCart className="h-3.5 w-3.5" />
            {buying ? 'Buying…' : 'Buy signal'}
          </button>
          <button
            type="button"
            onClick={() => onToggleCart(signal.id)}
            className={`rounded-xl px-3 py-2 text-xs font-semibold ring-1 transition ${
              inCart ? 'bg-violet-400/20 text-violet-100 ring-violet-400/40' : 'bg-white/[0.04] text-slate-300 ring-white/10 hover:bg-white/[0.08]'
            }`}
          >
            {inCart ? 'In cart' : 'Add to cart'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function SignalsMarketplacePage() {
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [buyingId, setBuyingId] = useState('')
  const [view, setView] = useState('bots')
  const [query, setQuery] = useState('')
  const [ownership, setOwnership] = useState('all')
  const [botFilter, setBotFilter] = useState('all')
  const [sort, setSort] = useState('recommended')
  const [cart, setCart] = useState(() => new Set())
  const [checkingOut, setCheckingOut] = useState(false)

  function loadCatalog() {
    return fetchJson('/api/signals-marketplace').then((payload) => setCatalog(payload))
  }

  useEffect(() => {
    let ignore = false
    loadCatalog()
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

  const listings = useMemo(() => catalog?.listings || [], [catalog])

  const allSignals = useMemo(() => (
    listings.flatMap((listing) => (listing.signals || []).map((signal) => ({ signal, listing })))
  ), [listings])

  const totals = useMemo(() => ({
    ownedSignals: allSignals.filter(({ signal }) => signal.owned).length,
    totalSignals: allSignals.length,
    ownedBots: listings.filter(isFullyOwned).length,
    totalBots: listings.length,
  }), [allSignals, listings])

  // Drop cart entries that became owned (or vanished) after a refresh.
  const cartIds = useMemo(() => {
    const purchasable = new Set(allSignals.filter(({ signal }) => !signal.owned).map(({ signal }) => signal.id))
    return [...cart].filter((id) => purchasable.has(id))
  }, [cart, allSignals])

  function toggleCart(signalId) {
    setCart((current) => {
      const next = new Set(current)
      if (next.has(signalId)) next.delete(signalId)
      else next.add(signalId)
      return next
    })
  }

  const normalizedQuery = query.trim().toLowerCase()

  function compareListings(a, b) {
    switch (sort) {
      case 'rows': return (b.stats?.trades ?? -Infinity) - (a.stats?.trades ?? -Infinity)
      case 'signals': return (b.signals?.length || 0) - (a.signals?.length || 0)
      case 'name': return a.name.localeCompare(b.name, undefined, { numeric: true })
      default: return 0
    }
  }

  const visibleListings = useMemo(() => (
    listings
      .filter((listing) => {
        // A partly-owned bot is in both lists: it has something you own and something left to buy.
        const ownsAny = listing.owned || (listing.signals || []).some((signal) => signal.owned)
        if (ownership === 'owned' && !ownsAny) return false
        if (ownership === 'available' && isFullyOwned(listing)) return false
        if (!normalizedQuery) return true
        return [listing.name, listing.tag, listing.description, ...(listing.signals || []).map((signal) => signal.label)]
          .some((text) => String(text || '').toLowerCase().includes(normalizedQuery))
      })
      .sort(compareListings)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [listings, ownership, normalizedQuery, sort])

  const visibleSignals = useMemo(() => (
    allSignals
      .filter(({ signal, listing }) => {
        if (botFilter !== 'all' && listing.id !== botFilter) return false
        if (ownership === 'owned' && !signal.owned) return false
        if (ownership === 'available' && signal.owned) return false
        if (!normalizedQuery) return true
        return [signal.label, listing.name, listing.tag].some((text) => String(text || '').toLowerCase().includes(normalizedQuery))
      })
      .sort((a, b) => (sort === 'name' ? a.signal.label.localeCompare(b.signal.label) : compareListings(a.listing, b.listing)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [allSignals, botFilter, ownership, normalizedQuery, sort])

  async function handleBuySignal(modelId, key) {
    const compositeId = `${modelId}:${key}`
    setBuyingId(compositeId)
    setError('')

    try {
      await fetchJson('/api/marketplace/signal-item/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, key }),
      })
      await loadCatalog()
    } catch (buyError) {
      setError(buyError instanceof Error ? buyError.message : 'Unable to buy this signal.')
    } finally {
      setBuyingId('')
    }
  }

  async function handleBuyBot(modelId) {
    setBuyingId(modelId)
    setError('')

    try {
      await fetchJson('/api/marketplace/bot-signal/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      })
      await loadCatalog()
    } catch (buyError) {
      setError(buyError instanceof Error ? buyError.message : 'Unable to buy this bot.')
    } finally {
      setBuyingId('')
    }
  }

  async function handleCheckout() {
    setCheckingOut(true)
    setError('')
    const failures = []
    for (const compositeId of cartIds) {
      const [modelId, ...rest] = compositeId.split(':')
      try {
        await fetchJson('/api/marketplace/signal-item/buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, key: rest.join(':') }),
        })
      } catch (buyError) {
        failures.push(buyError instanceof Error ? buyError.message : compositeId)
      }
    }
    setCart(new Set())
    try {
      await loadCatalog()
    } catch {
      // the catalog reload is best-effort; the purchases above already landed
    }
    if (failures.length > 0) {
      setError(`${failures.length} of ${cartIds.length} purchases failed: ${failures[0]}`)
    }
    setCheckingOut(false)
  }

  const shownCount = view === 'bots' ? visibleListings.length : visibleSignals.length

  return (
    <div className="grid gap-6 pb-24">
      <PageHeader
        title="Bot Signal"
        description="Buy a whole premade bot, or pick up individual signals from any bot and combine them into your own on Bot Creation. The backtest row count is real - never fabricated. Purchases are instant while we're in the test phase."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Signals owned</div>
          <div className="mt-1 text-xl font-semibold text-white">{totals.ownedSignals} <span className="text-sm font-normal text-slate-500">of {totals.totalSignals}</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-sky-400/80" style={{ width: `${totals.totalSignals ? (totals.ownedSignals / totals.totalSignals) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Bots fully owned</div>
          <div className="mt-1 text-xl font-semibold text-white">{totals.ownedBots} <span className="text-sm font-normal text-slate-500">of {totals.totalBots}</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-emerald-400/80" style={{ width: `${totals.totalBots ? (totals.ownedBots / totals.totalBots) * 100 : 0}%` }} />
          </div>
        </div>
        <Link
          to="/bot-creation"
          className="flex items-center justify-between gap-3 rounded-2xl border border-violet-400/25 bg-violet-400/[0.07] px-4 py-3 transition hover:border-violet-300/50"
        >
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-violet-300/80">Put them to work</div>
            <div className="mt-1 text-sm font-semibold text-white">Combine signals in Bot Creation</div>
          </div>
          <Hammer className="h-5 w-5 text-violet-200" />
        </Link>
      </div>

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

      <Panel
        title={view === 'bots' ? 'Premade Bots' : 'Individual Signals'}
        action={(
          <div className="inline-flex rounded-xl border border-white/10 bg-slate-950/60 p-1">
            {[
              { id: 'bots', label: 'Premade Bots', Icon: Boxes },
              { id: 'signals', label: 'Individual Signals', Icon: Layers },
            ].map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  view === id ? 'bg-sky-400 text-slate-950' : 'text-slate-300 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        )}
      >
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={view === 'bots' ? 'Search bots or signals...' : 'Search signals...'}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-500"
            />
          </div>
          <div className="inline-flex rounded-xl border border-white/10 bg-slate-950/60 p-1">
            {OWNERSHIP_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setOwnership(filter.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  ownership === filter.id ? 'bg-white/15 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {view === 'signals' ? (
            <select
              value={botFilter}
              onChange={(event) => setBotFilter(event.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-xs font-semibold text-slate-200 outline-none"
            >
              <option value="all" className="bg-slate-900">All bots</option>
              {listings.map((listing) => (
                <option key={listing.id} value={listing.id} className="bg-slate-900">{listing.name} - {listing.tag}</option>
              ))}
            </select>
          ) : null}
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-xs font-semibold text-slate-200 outline-none"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id} className="bg-slate-900">{option.label}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="text-sm text-slate-400">Loading the marketplace...</div>
        ) : shownCount === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-10 text-center text-sm text-slate-400">
            Nothing matches those filters.
          </div>
        ) : view === 'bots' ? (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {visibleListings.map((listing) => (
              <BotProductCard
                key={listing.id}
                listing={listing}
                onBuyBot={handleBuyBot}
                onBuySignal={handleBuySignal}
                buyingId={buyingId}
                cart={cart}
                onToggleCart={toggleCart}
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleSignals.map(({ signal, listing }) => (
              <SignalTile
                key={signal.id}
                signal={signal}
                listing={listing}
                inCart={cart.has(signal.id)}
                onToggleCart={toggleCart}
                onBuy={handleBuySignal}
                buying={buyingId === signal.id}
              />
            ))}
          </div>
        )}
      </Panel>

      {cartIds.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4">
          <div className="flex w-full max-w-2xl items-center justify-between gap-3 rounded-2xl border border-violet-400/30 bg-slate-950/95 px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.5)] backdrop-blur-md">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <ShoppingCart className="h-4 w-4 text-violet-200" />
              {cartIds.length} signal{cartIds.length === 1 ? '' : 's'} in cart
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCart(new Set())}
                className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold text-slate-400 transition hover:text-white"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
              <button
                type="button"
                onClick={handleCheckout}
                disabled={checkingOut}
                className="rounded-xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {checkingOut ? 'Buying…' : `Buy ${cartIds.length} signal${cartIds.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
