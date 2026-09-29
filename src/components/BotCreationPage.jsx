import { CheckCircle2, Hammer, Lock, Pencil, Play, Rocket, Search, Settings2, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getSignalModel, visibleSignalModels } from '../lib/signalModels'
import { Panel } from './Panel'
import { PageHeader } from './ui/PageHeader'

// SaaS Phase 8G: users combine 2+ signals they've bought (from different bots) into their own
// custom strategy. Intentionally simple per the confirmed decision - a multi-select plus a
// combination-mode picker, not a visual rule-graph editor. Live scan-loop *execution* for
// custom bots isn't wired yet (see the Preview panel below for why that's a deliberate,
// disclosed scope cut) - this page lets you create, edit, and live-preview a custom bot's
// signal alignment on any symbol, using the exact same analysis the eventual scan loop would.

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }
  return payload
}

// Signal picker for the custom-bot form. "Inside my bots" shows only the signals you own, grouped
// under the bot they belong to; "All signals" shows every bot's signals, with the ones you don't
// own locked (and a link to buy them) so you can see what else could go into a build.
function SignalPicker({ listings, selected, onToggle, onSelectMany }) {
  const [mode, setMode] = useState('mine')
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()

  const groups = listings
    .map((listing) => {
      const signals = (listing.signals || []).filter((signal) => (
        (mode === 'all' || signal.owned)
        && (!normalizedQuery || [signal.label, listing.name, listing.tag].some((text) => String(text || '').toLowerCase().includes(normalizedQuery)))
      ))
      return { listing, signals, ownedCount: (listing.signals || []).filter((signal) => signal.owned).length }
    })
    .filter((group) => group.signals.length > 0)
    // Bots you own the most of first, so "your" signals lead in either view.
    .sort((a, b) => b.ownedCount - a.ownedCount)

  const totalOwned = listings.reduce((sum, listing) => sum + (listing.signals || []).filter((signal) => signal.owned).length, 0)

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-xl border border-white/10 bg-slate-950/60 p-1">
          {[
            { id: 'mine', label: 'Inside my bots' },
            { id: 'all', label: 'All signals' },
          ].map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMode(option.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${mode === option.id ? 'bg-sky-400 text-slate-950' : 'text-slate-300 hover:text-white'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search signals..."
            className="w-full rounded-xl border border-white/10 bg-slate-950/70 py-2 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-500"
          />
        </div>
        <div className="text-xs text-slate-500">{totalOwned} signal{totalOwned === 1 ? '' : 's'} owned</div>
      </div>

      {totalOwned === 0 && mode === 'mine' ? (
        <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-400">
          You don't own any signals yet.{' '}
          <Link to="/marketplace/bot-signal" className="text-sky-300 underline">Browse the marketplace</Link>
          {' '}or switch to "All signals" to see what's available.
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-400">
          No signals match.
        </div>
      ) : (
        <div className="grid gap-3">
          {groups.map(({ listing, signals, ownedCount }) => {
            const ownedInGroup = signals.filter((signal) => signal.owned)
            const allSelected = ownedInGroup.length > 0 && ownedInGroup.every((signal) => selected.some((item) => item.modelId === listing.id && item.key === signal.key))
            return (
              <div key={listing.id} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{listing.name}</div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{listing.tag} - {ownedCount}/{(listing.signals || []).length} owned</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {ownedCount < (listing.signals || []).length ? (
                      <Link to="/marketplace/bot-signal" className="text-[11px] font-semibold text-sky-300 hover:underline">Get more</Link>
                    ) : null}
                    {ownedInGroup.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => onSelectMany(listing.id, ownedInGroup.map((signal) => signal.key), !allSelected)}
                        className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-slate-200 transition hover:bg-white/[0.08]"
                      >
                        {allSelected ? 'Clear' : 'Select all owned'}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {signals.map((signal) => {
                    const isSelected = selected.some((item) => item.modelId === listing.id && item.key === signal.key)
                    if (!signal.owned) {
                      return (
                        <div
                          key={signal.key}
                          title="Buy this signal in the marketplace to use it"
                          className="flex items-start gap-2 rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-3 py-2 text-left text-xs text-slate-500"
                        >
                          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{signal.label}</span>
                        </div>
                      )
                    }
                    return (
                      <button
                        key={signal.key}
                        type="button"
                        onClick={() => onToggle(listing.id, signal.key)}
                        className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-left text-xs transition ${
                          isSelected
                            ? 'border-sky-400/40 bg-sky-400/15 text-sky-100'
                            : 'border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/[0.05]'
                        }`}
                      >
                        {isSelected ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border border-white/25" />}
                        <span>
                          <span className="block font-medium">{signal.label}</span>
                          {signal.detail ? <span className="mt-0.5 block text-[11px] font-normal text-slate-500">{signal.detail}</span> : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CustomBotCard({ bot, slotNumber, onDelete, deleting, onEdit, onToggleDeploy, deploying, highlighted }) {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const componentModelIds = [...new Set(bot.componentSignalItems.map((item) => item.modelId))]

  async function handlePreview() {
    setPreviewing(true)
    setPreviewError('')
    try {
      const payload = await fetchJson(`/api/custom-bots/${bot.id}/preview?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`)
      setPreview(payload.preview)
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Unable to load preview.')
      setPreview(null)
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div id={`bot-${bot.id}`} className={`rounded-[28px] border bg-white/[0.03] p-5 ${highlighted ? 'border-sky-400/50 ring-1 ring-sky-400/30' : 'border-white/10'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-lg font-semibold text-white">{bot.name}</div>
            <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${bot.enabled ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-white/10 bg-white/[0.04] text-slate-400'}`}>
              {bot.enabled ? 'Deployed' : 'Draft'}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {bot.componentSignalItems.length} signals from {componentModelIds.map((id) => getSignalModel(id).name).join(' + ')}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onToggleDeploy(bot)}
            disabled={deploying}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${bot.enabled ? 'border border-white/10 bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]' : 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'}`}
          >
            <Rocket className="h-3.5 w-3.5" />
            {deploying ? 'Saving…' : bot.enabled ? 'Undeploy' : 'Deploy to Dashboard'}
          </button>
          <button
            type="button"
            onClick={() => onEdit(bot)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-100 transition hover:bg-sky-400/20"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(bot.id)}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-100 transition hover:bg-rose-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-2.5 py-1">
          {bot.combinationMode === 'THRESHOLD' ? `${bot.minimumAligned} of ${bot.componentSignalItems.length} aligned` : 'All signals must align'}
        </span>
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-2.5 py-1">
          Risk from {getSignalModel(bot.riskSourceModelId).name}
        </span>
        <span className="rounded-full border border-white/10 bg-slate-950/60 px-2.5 py-1">
          {slotNumber ? `Slot ${slotNumber}` : 'No slot'}{bot.allocationBalance > 0 ? ` - ${bot.allocationBalance.toFixed(2)} USDT allocated` : ''}
        </span>
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="BTCUSDT"
            className="w-40 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm font-semibold text-white outline-none"
          />
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewing}
            className="inline-flex items-center gap-1.5 rounded-xl bg-sky-400/15 px-3 py-2 text-xs font-semibold text-sky-100 ring-1 ring-sky-400/30 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {previewing ? 'Loading…' : 'Live Preview'}
          </button>
        </div>

        {previewError ? <p className="mt-3 text-xs text-rose-300">{previewError}</p> : null}

        {preview ? (
          <div className="mt-3">
            <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
              preview.ready ? 'border-emerald-400/30 bg-emerald-400/15 text-emerald-100' : 'border-white/10 bg-white/[0.04] text-slate-400'
            }`}>
              {preview.ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              {preview.score}/{preview.maxScore} aligned (needs {preview.threshold})
            </div>
            <p className="mt-2 text-xs text-slate-400">{preview.summary}</p>
            <div className="mt-3 grid gap-1.5">
              {preview.checklist.map((item) => (
                <div key={`${item.modelId}:${item.key}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-300">{item.label}</span>
                  <span className={item.passed ? 'text-emerald-300' : 'text-slate-500'}>{item.passed ? 'Passed' : 'Not yet'}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function NativeBotCard({ model, wallet, highlighted, onClearSlot, clearing, onToggleDeploy, deploying }) {
  return (
    <div id={`bot-${model.id}`} className={`rounded-[28px] border bg-white/[0.03] p-5 ${highlighted ? 'border-sky-400/50 ring-1 ring-sky-400/30' : 'border-white/10'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{model.name}</div>
        {wallet ? (
          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${wallet.enabled ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-white/10 bg-white/[0.04] text-slate-400'}`}>
            {wallet.enabled ? 'Deployed' : 'Undeployed'}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-lg font-semibold text-white">{model.tag}</div>
      <div className="mt-2 text-xs text-slate-400">Wallet: {wallet ? wallet.name : 'unassigned'}</div>
      <Link
        to={`/settings/strategy?bot=${encodeURIComponent(model.id)}`}
        className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-100 transition hover:bg-sky-400/20"
      >
        <Settings2 className="h-3.5 w-3.5" />
        Edit strategy
      </Link>
      {wallet && onToggleDeploy ? (
        <button
          type="button"
          onClick={onToggleDeploy}
          disabled={deploying}
          className={`ml-2 mt-4 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${wallet.enabled ? 'border border-white/10 bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]' : 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'}`}
        >
          <Rocket className="h-3.5 w-3.5" />
          {deploying ? 'Saving…' : wallet.enabled ? 'Undeploy' : 'Deploy'}
        </button>
      ) : null}
      {onClearSlot ? (
        <button
          type="button"
          onClick={onClearSlot}
          disabled={clearing}
          className="ml-2 mt-4 inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {clearing ? 'Clearing…' : 'Empty this slot'}
        </button>
      ) : null}
    </div>
  )
}

// One bought-but-unfilled bot slot: pick a premade bot for it, or start a custom build.
function EmptySlotCard({ slot, number, pickableModels, onPickModel, onBuildCustom, picking, highlighted }) {
  return (
    <div id={`bot-${slot.id}`} className={`rounded-[28px] border bg-white/[0.03] p-5 ${highlighted ? 'border-sky-400/50 ring-1 ring-sky-400/30' : 'border-white/10'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Slot {number}</div>
          <div className="mt-1 text-lg font-semibold text-white">Empty bot</div>
        </div>
        <button
          type="button"
          onClick={() => onBuildCustom(slot.id)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-xs font-semibold text-violet-100 transition hover:bg-violet-400/20"
        >
          <Hammer className="h-3.5 w-3.5" />
          Combine signals
        </button>
      </div>
      <div className="mt-4 text-[11px] uppercase tracking-[0.2em] text-slate-500">Or start from a premade bot</div>
      {pickableModels.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-white/15 px-3 py-3 text-xs text-slate-400">
          You don't own a premade bot that isn't already in use.{' '}
          <Link to="/marketplace/bot-signal" className="text-sky-300 underline">Buy one on the Marketplace</Link>
          {' '}to choose it here.
        </div>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {pickableModels.map((model) => (
            <button
              key={model.id}
              type="button"
              disabled={picking}
              onClick={() => onPickModel(slot.id, model.id)}
              className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-left text-xs transition hover:border-sky-300/40 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="font-semibold text-white">{model.name}</div>
              <div className="mt-0.5 text-slate-400">{model.tag}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function BotCreationPage({ settings, isAdmin = false, ownedBotModelIds = null, onRefresh, onSaveSettings }) {
  const [searchParams] = useSearchParams()
  const focusedBotId = searchParams.get('bot') || searchParams.get('slot') || ''
  const requestedSlotId = searchParams.get('slot') || ''
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState([])
  const [combinationMode, setCombinationMode] = useState('ALL')
  const [minimumAligned, setMinimumAligned] = useState(1)
  const [riskSourceModelId, setRiskSourceModelId] = useState('')
  const [slotId, setSlotId] = useState('')
  const [pickingSlot, setPickingSlot] = useState(false)
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [deletingId, setDeletingId] = useState('')
  const [deployingId, setDeployingId] = useState('')
  const formRef = useRef(null)
  const autoOpenedRef = useRef('')

  const customBots = settings.customBots || []
  const botSlotList = isAdmin ? [] : (settings.botSlotList || [])
  const emptySlots = botSlotList.filter((slot) => !slot.assignment)
  const slotByModelId = Object.fromEntries(botSlotList.filter((slot) => slot.assignment && !slot.assignment.startsWith('custom-')).map((slot) => [slot.assignment, slot.id]))
  const nativeBots = useMemo(() => (
    ownedBotModelIds ? visibleSignalModels().filter((model) => ownedBotModelIds.includes(model.id)) : visibleSignalModels()
  ), [ownedBotModelIds])

  // Re-fetched whenever the slots or active bots change, since emptying a bot changes what is owned.
  const ownershipKey = JSON.stringify([botSlotList, ownedBotModelIds])
  useEffect(() => {
    let ignore = false
    fetchJson('/api/signals-marketplace')
      .then((payload) => { if (!ignore) setCatalog(payload) })
      .catch((fetchError) => { if (!ignore) setError(fetchError instanceof Error ? fetchError.message : 'Unable to load your signals.') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [ownershipKey])

  const catalogListings = useMemo(() => catalog?.listings || [], [catalog])

  // Premade bots that may go in an empty slot: ones the user owns (the whole bot, or every one of
  // its signals) that aren't already active on the account. Not-yet-bought bots never appear.
  const pickableModels = useMemo(() => {
    const activeIds = new Set(ownedBotModelIds || [])
    const ownedListingIds = new Set(
      catalogListings
        .filter((listing) => listing.owned || ((listing.signals || []).length > 0 && listing.signals.every((signal) => signal.owned)))
        .map((listing) => listing.id),
    )
    return visibleSignalModels().filter((model) => ownedListingIds.has(model.id) && !activeIds.has(model.id))
  }, [catalogListings, ownedBotModelIds])

  const componentModelIds = [...new Set(selected.map((item) => item.modelId))]
  // Default the risk source to the first picked bot so the form is never blocked on an untouched dropdown.
  const effectiveRiskSourceModelId = componentModelIds.includes(riskSourceModelId) ? riskSourceModelId : (componentModelIds[0] || '')

  function resetForm() {
    setEditingId('')
    setSelected([])
    setName('')
    setRiskSourceModelId('')
    setSlotId('')
    setCombinationMode('ALL')
    setMinimumAligned(1)
  }

  function startEdit(bot) {
    setEditingId(bot.id)
    setName(bot.name)
    setSelected((bot.componentSignalItems || []).map((item) => ({ modelId: item.modelId, key: item.key })))
    setCombinationMode(bot.combinationMode)
    setMinimumAligned(bot.minimumAligned || 1)
    setRiskSourceModelId(bot.riskSourceModelId)
    setError('')
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  function buildCustomInSlot(nextSlotId) {
    resetForm()
    setSlotId(nextSlotId)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  // A bot owned outright (not in a slot) becomes an empty slot - see POST /api/bots/:modelId/empty.
  async function emptyOwnedBot(modelId) {
    setPickingSlot(true)
    setError('')
    try {
      await fetchJson(`/api/bots/${encodeURIComponent(modelId)}/empty`, { method: 'POST' })
      await onRefresh?.()
    } catch (emptyError) {
      setError(emptyError instanceof Error ? emptyError.message : 'Unable to empty this bot.')
    } finally {
      setPickingSlot(false)
    }
  }

  async function putSlot(targetSlotId, body) {
    setPickingSlot(true)
    setError('')
    try {
      await fetchJson(`/api/bot-slots/${encodeURIComponent(targetSlotId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await onRefresh?.()
    } catch (slotError) {
      setError(slotError instanceof Error ? slotError.message : 'Unable to update this bot slot.')
    } finally {
      setPickingSlot(false)
    }
  }

  // The slot the create form will use: an explicit choice, else the one Overview linked to, else the first empty one.
  const effectiveSlotId = emptySlots.some((slot) => slot.id === slotId)
    ? slotId
    : emptySlots.some((slot) => slot.id === requestedSlotId) ? requestedSlotId : (emptySlots[0]?.id || '')

  // Arriving from a Dashboard Bot Status card (?bot=<id>): scroll to that bot, and for a custom
  // bot open it straight in the editor. Runs once per bot id so it doesn't fight later edits.
  useEffect(() => {
    if (!focusedBotId || autoOpenedRef.current === focusedBotId) return
    const custom = customBots.find((bot) => bot.id === focusedBotId)
    if (custom) {
      autoOpenedRef.current = focusedBotId
      startEdit(custom)
      return
    }
    if (botSlotList.some((slot) => slot.id === focusedBotId) || nativeBots.some((model) => model.id === focusedBotId)) {
      autoOpenedRef.current = focusedBotId
      requestAnimationFrame(() => document.getElementById(`bot-${focusedBotId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedBotId, customBots.length, nativeBots.length, botSlotList.length])

  function toggleSignal(modelId, key) {
    setSelected((current) => (
      current.some((item) => item.modelId === modelId && item.key === key)
        ? current.filter((item) => !(item.modelId === modelId && item.key === key))
        : [...current, { modelId, key }]
    ))
  }

  function selectMany(modelId, keys, select) {
    setSelected((current) => {
      const rest = current.filter((item) => !(item.modelId === modelId && keys.includes(item.key)))
      return select ? [...rest, ...keys.map((key) => ({ modelId, key }))] : rest
    })
  }

  async function saveBot(deployAfter) {
    setFormError('')
    setNotice('')

    if (componentModelIds.length < 2) {
      setFormError('Pick signals from at least 2 different bots.')
      return
    }
    if (!effectiveRiskSourceModelId) {
      setFormError('Choose a risk source bot.')
      return
    }
    if (!editingId && !isAdmin && !effectiveSlotId) {
      setFormError('You have no empty bot slot - buy one on the Marketplace first.')
      return
    }

    setSaving(true)
    try {
      const botName = name.trim() || 'Custom Bot'
      const body = {
        name: botName,
        componentSignalItems: selected,
        combinationMode,
        minimumAligned,
        riskSourceModelId: effectiveRiskSourceModelId,
        // Bots are funded from Wallets > Bot allocation now, not by picking a wallet. Sending an
        // empty id also clears a stale wallet left on older bots.
        walletId: '',
      }
      if (editingId) {
        await fetchJson(`/api/custom-bots/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(deployAfter ? { ...body, enabled: true } : body),
        })
      } else {
        await fetchJson('/api/custom-bots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, slotId: effectiveSlotId, enabled: deployAfter }),
        })
      }
      resetForm()
      await onRefresh?.()
      setNotice(
        deployAfter
          ? `"${botName}" is deployed - it now shows on Dashboard > Overview.`
          : `"${botName}" saved as a draft. Press Deploy on its card when you want it on the Dashboard.`,
      )
      // After the refreshed list has rendered, bring the saved bot's card into view.
      window.setTimeout(() => document.getElementById('custom-bots-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'Unable to save this bot.')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleDeploy(bot) {
    setDeployingId(bot.id)
    setError('')
    try {
      await fetchJson(`/api/custom-bots/${bot.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !bot.enabled }),
      })
      await onRefresh?.()
    } catch (deployError) {
      setError(deployError instanceof Error ? deployError.message : 'Unable to change deployment.')
    } finally {
      setDeployingId('')
    }
  }

  // Deploy/Undeploy a premade bot = switch its wallet's automation on/off (the same flag as the
  // Wallets page's Enable button); an undeployed bot stays owned and editable, it just stops trading.
  async function handleToggleNativeDeploy(walletToToggle) {
    setDeployingId(walletToToggle.id)
    setError('')
    try {
      const result = await onSaveSettings?.({
        ...settings,
        wallets: (settings.wallets || []).map((item) => (
          item.id === walletToToggle.id ? { ...item, enabled: !item.enabled } : item
        )),
      })
      if (result && result.ok === false) {
        throw new Error(result.error || 'Unable to change deployment.')
      }
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Unable to change deployment.')
    } finally {
      setDeployingId('')
    }
  }

  async function handleDelete(customBotId) {
    setDeletingId(customBotId)
    setError('')
    try {
      await fetchJson(`/api/custom-bots/${customBotId}`, { method: 'DELETE' })
      if (editingId === customBotId) resetForm()
      await onRefresh?.()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this bot.')
    } finally {
      setDeletingId('')
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Bot Creation"
        description="See and edit all your bots here. Fill an empty slot with a premade bot, or combine 2 or more signals you own into a custom bot and Deploy it to show it on Dashboard > Overview. Live auto-trading for custom bots isn't wired up yet - Live Preview shows what each would signal right now."
      />

      {error ? (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">{error}</div>
      ) : null}

      {notice ? (
        <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">{notice}</div>
      ) : null}

      {!isAdmin ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="text-sm text-slate-300">
            <span className="font-semibold text-white">{botSlotList.length}</span> bot slot{botSlotList.length === 1 ? '' : 's'}
            {' - '}
            <span className="font-semibold text-white">{botSlotList.length - emptySlots.length}</span> in use
            {' - '}
            <span className="font-semibold text-emerald-300">{emptySlots.length}</span> empty
            <span className="text-slate-500"> (each slot can hold a premade bot or its own custom bot)</span>
          </div>
          <Link to="/marketplace/bot-slot" className="text-xs font-semibold text-sky-300 hover:underline">Buy another slot</Link>
        </div>
      ) : null}

      {emptySlots.length > 0 ? (
        <Panel title={`Empty Bot Slots (${emptySlots.length})`}>
          <div className="grid gap-4 md:grid-cols-2">
            {emptySlots.map((slot) => (
              <EmptySlotCard
                key={slot.id}
                slot={slot}
                number={botSlotList.findIndex((item) => item.id === slot.id) + 1}
                pickableModels={pickableModels}
                onPickModel={(targetSlotId, modelId) => putSlot(targetSlotId, { modelId })}
                onBuildCustom={buildCustomInSlot}
                picking={pickingSlot}
                highlighted={focusedBotId === slot.id}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title={`Your Bots (${nativeBots.length})`}>
        {nativeBots.length === 0 ? (
          <div className="text-sm text-slate-400">You don't have any bots yet - claim your free bot from the Dashboard, or buy a bot slot and fill it here.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {nativeBots.map((model) => {
              const modelWallet = (settings.wallets || []).find((item) => item.assignedSignalModelId === model.id)
              return (
              <NativeBotCard
                key={model.id}
                model={model}
                wallet={modelWallet}
                onToggleDeploy={onSaveSettings && modelWallet ? () => handleToggleNativeDeploy(modelWallet) : null}
                deploying={modelWallet ? deployingId === modelWallet.id : false}
                highlighted={focusedBotId === model.id}
                onClearSlot={isAdmin ? null : () => (slotByModelId[model.id] ? putSlot(slotByModelId[model.id], { clear: true }) : emptyOwnedBot(model.id))}
                clearing={pickingSlot}
              />
              )
            })}
          </div>
        )}
      </Panel>

      {customBots.length > 0 ? (
        <div id="custom-bots-panel">
        <Panel
          title={`Your Custom Bots (${customBots.length})`}
          action={(
            <button
              type="button"
              onClick={() => buildCustomInSlot(emptySlots[0]?.id || '')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-1.5 text-xs font-semibold text-violet-100 transition hover:bg-violet-400/20"
            >
              <Hammer className="h-3.5 w-3.5" />
              New custom bot
            </button>
          )}
        >
          <div className="grid gap-4 md:grid-cols-2">
            {customBots.map((bot) => (
              <CustomBotCard
                key={bot.id}
                bot={bot}
                slotNumber={botSlotList.findIndex((slot) => slot.assignment === bot.id) + 1}
                onDelete={handleDelete}
                deleting={deletingId === bot.id}
                onEdit={startEdit}
                onToggleDeploy={handleToggleDeploy}
                deploying={deployingId === bot.id}
                highlighted={focusedBotId === bot.id || editingId === bot.id}
              />
            ))}
          </div>
        </Panel>
        </div>
      ) : null}

      <div ref={formRef}>
        <Panel title={editingId ? 'Edit Custom Bot' : 'Create a Custom Bot'} action={<Hammer className="h-4 w-4 text-sky-300" />}>
          {loading ? (
            <div className="text-sm text-slate-400">Loading your signals...</div>
          ) : (
            <>
            {editingId ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-sm text-sky-100">
                <span>You're editing <span className="font-semibold">{customBots.find((bot) => bot.id === editingId)?.name || 'a custom bot'}</span>. Saving updates it - it won't create a new one.</span>
                <button
                  type="button"
                  onClick={() => buildCustomInSlot(emptySlots[0]?.id || '')}
                  className="rounded-xl border border-sky-300/30 bg-sky-400/15 px-3 py-1.5 text-xs font-semibold text-sky-50 transition hover:bg-sky-400/25"
                >
                  Start a new bot instead
                </button>
              </div>
            ) : null}
            <form onSubmit={(event) => { event.preventDefault(); saveBot(false) }} className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
              <div className="grid content-start gap-5">
                <div>
                  <div className="mb-2 text-xs uppercase tracking-[0.24em] text-slate-500">1. Name your bot</div>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="My Custom Bot"
                    className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm font-semibold text-white outline-none"
                  />
                </div>
                <div>
                  <div className="mb-2 text-xs uppercase tracking-[0.24em] text-slate-500">2. Pick signals (from at least 2 different bots)</div>
                  <SignalPicker listings={catalogListings} selected={selected} onToggle={toggleSignal} onSelectMany={selectMany} />
                </div>
              </div>

              <div className="grid content-start gap-4 self-start rounded-3xl border border-violet-400/20 bg-violet-400/[0.04] p-5 lg:sticky lg:top-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-white">{name.trim() || 'Your bot'}</div>
                  <span className="rounded-full border border-violet-300/25 bg-violet-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-100">
                    {selected.length} signal{selected.length === 1 ? '' : 's'} - {componentModelIds.length} bot{componentModelIds.length === 1 ? '' : 's'}
                  </span>
                </div>

                {selected.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center text-xs text-slate-400">
                    Pick signals on the left - they'll show up here.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {componentModelIds.map((modelId) => (
                      <div key={modelId}>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{getSignalModel(modelId).name}</div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {selected.filter((item) => item.modelId === modelId).map((item) => {
                            const label = catalogListings.find((listing) => listing.id === modelId)?.signals?.find((signal) => signal.key === item.key)?.label || item.key
                            return (
                              <button
                                key={item.key}
                                type="button"
                                onClick={() => toggleSignal(modelId, item.key)}
                                title="Remove"
                                className="inline-flex items-center gap-1 rounded-full border border-violet-300/25 bg-violet-400/10 px-2.5 py-1 text-[11px] text-violet-100 transition hover:bg-violet-400/20"
                              >
                                {label}
                                <X className="h-3 w-3" />
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {componentModelIds.length === 1 ? (
                  <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                    Add at least one signal from a different bot to continue.
                  </div>
                ) : null}

                {componentModelIds.length >= 2 ? (
                  <div className="grid gap-4 border-t border-white/10 pt-4">
                    <div>
                      <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-slate-500">3. When does it trade?</div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setCombinationMode('ALL')}
                          className={`rounded-xl px-3 py-2.5 text-xs font-semibold transition ${combinationMode === 'ALL' ? 'bg-sky-400 text-slate-950' : 'border border-white/10 bg-slate-950/60 text-slate-300'}`}
                        >
                          All must align
                        </button>
                        <button
                          type="button"
                          onClick={() => setCombinationMode('THRESHOLD')}
                          className={`rounded-xl px-3 py-2.5 text-xs font-semibold transition ${combinationMode === 'THRESHOLD' ? 'bg-sky-400 text-slate-950' : 'border border-white/10 bg-slate-950/60 text-slate-300'}`}
                        >
                          N of {selected.length} aligned
                        </button>
                      </div>
                      {combinationMode === 'THRESHOLD' ? (
                        <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                          Minimum aligned
                          <input
                            type="number"
                            min={1}
                            max={selected.length}
                            value={minimumAligned}
                            onChange={(event) => setMinimumAligned(Number(event.target.value) || 1)}
                            className="w-20 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm font-semibold text-white outline-none"
                          />
                          of {selected.length}
                        </div>
                      ) : null}
                    </div>

                    <div>
                      <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-slate-500">4. Risk source (entry / stop / take-profit)</div>
                      <select
                        value={effectiveRiskSourceModelId}
                        onChange={(event) => setRiskSourceModelId(event.target.value)}
                        className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm font-semibold text-white outline-none"
                      >
                        {componentModelIds.map((modelId) => (
                          <option key={modelId} value={modelId} className="bg-slate-900 text-white">{getSignalModel(modelId).name}</option>
                        ))}
                      </select>
                    </div>

                    {!editingId && !isAdmin ? (
                      <div>
                        <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-slate-500">5. Bot slot</div>
                        {emptySlots.length === 0 ? (
                          <div className="text-sm text-amber-200">
                            No empty bot slot - <Link to="/marketplace/bot-slot" className="underline">buy one</Link> to create this bot.
                          </div>
                        ) : (
                          <select
                            value={effectiveSlotId}
                            onChange={(event) => setSlotId(event.target.value)}
                            className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm font-semibold text-white outline-none"
                          >
                            {emptySlots.map((slot) => (
                              <option key={slot.id} value={slot.id} className="bg-slate-900 text-white">
                                Slot {botSlotList.findIndex((item) => item.id === slot.id) + 1}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    ) : null}

                    <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-3 py-2.5 text-xs leading-relaxed text-slate-400">
                      Funding: set how much of your balance this bot may use on{' '}
                      <Link to="/wallets" className="font-semibold text-sky-300 hover:underline">Wallets &gt; Bot allocation</Link>.
                    </div>

                    {formError ? (
                      <div className="rounded-2xl border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{formError}</div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
                      <button
                        type="button"
                        onClick={() => saveBot(true)}
                        disabled={saving}
                        className="inline-flex items-center gap-2 rounded-2xl bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                      >
                        <Rocket className="h-4 w-4" />
                        {saving ? 'Saving...' : editingId ? 'Save & Deploy' : 'Create & Deploy'}
                      </button>
                      <button
                        type="submit"
                        disabled={saving}
                        className="rounded-2xl border border-white/10 bg-slate-950/60 px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {editingId ? 'Save Changes' : 'Save as Draft'}
                      </button>
                      {editingId ? (
                        <button
                          type="button"
                          onClick={resetForm}
                          className="rounded-2xl px-3 py-2.5 text-sm font-semibold text-slate-400 transition hover:text-white"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </form>
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}
