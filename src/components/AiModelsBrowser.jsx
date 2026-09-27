import { Check, Copy, FlaskConical, Loader2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AI_TRADING_AGENTS, AI_TRADING_LLM_AGENT_IDS } from '../lib/aiTrading'
import { Panel } from './Panel'
import { Badge } from './ui/Badge'
import { Modal } from './ui/Modal'
import { StatCard } from './ui/StatCard'

const PAGE_SIZE = 40

const SORTS = [
  { id: 'name', label: 'Name' },
  { id: 'context', label: 'Largest context' },
  { id: 'price', label: 'Cheapest first' },
  { id: 'newest', label: 'Newest' },
]

async function requestJson(url, options) {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
  return payload
}

const formatContext = (tokens) => {
  if (!tokens) return null
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}k`
}

const formatPrice = (value) => (value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2))

function priceLabel(model) {
  if (model.free) return 'Free'
  if (!model.pricePerMillion) return null
  const { input, output } = model.pricePerMillion
  return `$${formatPrice(input ?? 0)} in / $${formatPrice(output ?? 0)} out per 1M`
}

// Lower sorts first; unknown prices last so "cheapest first" never buries real prices under blanks.
const priceRank = (model) => (model.free ? -1 : model.pricePerMillion ? (model.pricePerMillion.input ?? 0) + (model.pricePerMillion.output ?? 0) : Number.POSITIVE_INFINITY)

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  context: (a, b) => (b.contextLength || 0) - (a.contextLength || 0) || a.name.localeCompare(b.name),
  price: (a, b) => priceRank(a) - priceRank(b) || a.name.localeCompare(b.name),
  newest: (a, b) => (b.created || 0) - (a.created || 0) || a.name.localeCompare(b.name),
}

function Toggle({ checked, onChange, children }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-sky-400" />
      {children}
    </label>
  )
}

function TestResult({ result }) {
  if (!result) return null
  if (result.status === 'testing') {
    return <div className="flex items-center gap-1.5 text-[11px] text-sky-300"><Loader2 className="h-3 w-3 animate-spin" />Calling the model…</div>
  }
  return result.ok ? (
    <div className="text-[11px] text-emerald-300">✓ Works with the pipeline — replied with JSON in {(result.ms / 1000).toFixed(1)}s.</div>
  ) : (
    <div className="text-[11px] leading-relaxed text-rose-300">✗ {result.error}</div>
  )
}

function ModelRow({ model, test, copied, onCopy, onTest, onUse }) {
  const price = priceLabel(model)
  const usable = model.connected
  const facts = [
    model.providerLabel,
    formatContext(model.contextLength) ? `${formatContext(model.contextLength)} context` : null,
    price,
    model.source === 'catalog' ? 'suggested' : null,
  ].filter(Boolean)

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-white">{model.name}</span>
            {model.free ? <Badge tone="up">Free</Badge> : null}
            {model.jsonMode === true ? <Badge tone="info">JSON mode</Badge> : null}
            {model.reasoning ? <Badge tone="neutral">Reasoning</Badge> : null}
            {model.vision ? <Badge tone="neutral">Vision</Badge> : null}
            {model.kind === 'other' ? <Badge tone="warn">Not chat</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <button
              type="button"
              onClick={onCopy}
              title="Copy model id"
              className="inline-flex max-w-full items-center gap-1 truncate rounded-md font-mono text-slate-400 transition hover:text-sky-300"
            >
              {copied ? <Check className="h-3 w-3 shrink-0 text-emerald-300" /> : <Copy className="h-3 w-3 shrink-0" />}
              <span className="truncate">{model.id}</span>
            </button>
            {facts.map((fact) => <span key={fact}>· {fact}</span>)}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={!usable || test?.status === 'testing'}
            onClick={onTest}
            title={usable ? 'Send one tiny request through the same caller the agents use' : 'Connect this provider first'}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FlaskConical className="h-3 w-3" />Test
          </button>
          <button
            type="button"
            disabled={!usable}
            onClick={onUse}
            title={usable ? 'Assign to an AI Trading agent' : 'Connect this provider first'}
            className="rounded-full bg-sky-400 px-3 py-1.5 text-xs font-semibold text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            Use for agent
          </button>
        </div>
      </div>
      {model.description ? <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">{model.description}</p> : null}
      {!usable ? (
        <p className="text-[11px] text-amber-200/80">No API key for {model.providerLabel} yet — add one under Providers &amp; Keys to test or use this model.</p>
      ) : null}
      <TestResult result={test} />
    </div>
  )
}

function AssignModal({ model, config, saving, feedback, onClose, onSave }) {
  const [selected, setSelected] = useState([])

  return (
    <Modal
      title={`Use ${model.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose} className="rounded-full border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300">
            {feedback?.ok ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            disabled={saving || !selected.length}
            onClick={() => onSave(selected)}
            className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            {saving ? 'Saving…' : selected.length ? `Assign to ${selected.length} agent${selected.length === 1 ? '' : 's'}` : 'Assign'}
          </button>
        </>
      )}
    >
      <p className="text-xs leading-relaxed text-slate-400">
        Pick which AI Trading agents should answer with <span className="font-mono text-slate-200">{model.id}</span> via {model.providerLabel}.
        Agents you leave unticked keep their current model.
      </p>
      <div className="grid grid-cols-1 gap-2">
        {AI_TRADING_LLM_AGENT_IDS.map((agentId) => {
          const agent = AI_TRADING_AGENTS.find((item) => item.id === agentId)
          const current = config?.agents?.[agentId]
          const already = current?.providerId === model.providerId && current?.model === model.id
          return (
            <label key={agentId} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <input
                type="checkbox"
                checked={selected.includes(agentId)}
                onChange={(event) => setSelected((list) => (event.target.checked ? [...list, agentId] : list.filter((id) => id !== agentId)))}
                className="mt-0.5 h-4 w-4 accent-sky-400"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-200">{agent.name}{already ? ' · already using it' : ''}</span>
                <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                  Now: {current?.providerId || 'unassigned'}{current?.model ? ` · ${current.model}` : ' · provider default'}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      {model.jsonMode === false ? (
        <p className="text-[11px] text-amber-200/80">This model does not advertise JSON mode — agents fall back to a prompt-only JSON reply, which weaker models sometimes get wrong. Use Test first.</p>
      ) : null}
      {feedback ? (
        <div className={`rounded-2xl border px-4 py-3 text-xs ${feedback.ok ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/20 bg-rose-400/10 text-rose-200'}`}>
          {feedback.text}
        </div>
      ) : null}
    </Modal>
  )
}

export function AiModelsBrowser({ settings }) {
  const [providers, setProviders] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [providerId, setProviderId] = useState('all')
  const [freeOnly, setFreeOnly] = useState(false)
  const [jsonOnly, setJsonOnly] = useState(false)
  const [includeNonChat, setIncludeNonChat] = useState(false)
  const [sort, setSort] = useState('name')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [tests, setTests] = useState({})
  const [copiedKey, setCopiedKey] = useState('')
  const [assigning, setAssigning] = useState(null)
  const [config, setConfig] = useState(null)
  const [saving, setSaving] = useState(false)
  const [assignFeedback, setAssignFeedback] = useState(null)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError('')
    try {
      const payload = await requestJson(`/api/ai-models/browse?provider=all${refresh ? '&refresh=1' : ''}`)
      setProviders(payload.providers)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load models.')
    } finally {
      setLoading(false)
    }
  }, [])

  // The provider list depends on which keys are saved, so reload when a key is added/removed elsewhere.
  const credentialFingerprint = JSON.stringify(Object.keys(settings?.aiProviderCredentialStatus || {}))
  useEffect(() => { load() }, [load, credentialFingerprint])
  useEffect(() => {
    requestJson('/api/ai-trading/config').then((payload) => setConfig(payload.config)).catch(() => {})
  }, [])
  useEffect(() => { setVisible(PAGE_SIZE) }, [query, providerId, freeOnly, jsonOnly, includeNonChat, sort])

  const allModels = useMemo(
    () => (providers || []).flatMap((provider) => provider.models.map((model) => ({
      ...model, providerLabel: provider.label, connected: provider.connected, source: provider.source,
    }))),
    [providers],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return allModels
      .filter((model) => (providerId === 'all' || model.providerId === providerId)
        && (!freeOnly || model.free)
        && (!jsonOnly || model.jsonMode === true)
        && (includeNonChat || model.kind === 'chat')
        && (!needle || `${model.id} ${model.name} ${model.providerLabel} ${model.description}`.toLowerCase().includes(needle)))
      .sort(SORTERS[sort])
  }, [allModels, providerId, freeOnly, jsonOnly, includeNonChat, query, sort])

  const providerCounts = useMemo(() => {
    const counts = {}
    for (const model of allModels) if (includeNonChat || model.kind === 'chat') counts[model.providerId] = (counts[model.providerId] || 0) + 1
    return counts
  }, [allModels, includeNonChat])

  const liveCount = (providers || []).filter((provider) => provider.source === 'live').length
  const freeCount = allModels.filter((model) => model.free && model.kind === 'chat').length
  const problems = (providers || []).filter((provider) => provider.error && provider.connected)

  async function runTest(model) {
    const key = `${model.providerId}/${model.id}`
    setTests((current) => ({ ...current, [key]: { status: 'testing' } }))
    try {
      const result = await requestJson('/api/ai-models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: model.providerId, model: model.id }),
      })
      setTests((current) => ({ ...current, [key]: { status: 'done', ...result } }))
    } catch (err) {
      setTests((current) => ({ ...current, [key]: { status: 'done', ok: false, error: err instanceof Error ? err.message : 'Test failed.' } }))
    }
  }

  async function copyId(model) {
    const key = `${model.providerId}/${model.id}`
    try {
      await navigator.clipboard.writeText(model.id)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1500)
    } catch {
      // Clipboard can be blocked (insecure origin / permissions); the id is still visible to select by hand.
    }
  }

  async function assign(agentIds) {
    if (!assigning || !config) return
    setSaving(true)
    setAssignFeedback(null)
    try {
      const agents = { ...config.agents }
      for (const agentId of agentIds) agents[agentId] = { providerId: assigning.providerId, model: assigning.id }
      const payload = await requestJson('/api/ai-trading/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, agents }),
      })
      setConfig(payload.config)
      setAssignFeedback({ ok: true, text: `Saved. ${agentIds.length} agent${agentIds.length === 1 ? ' now uses' : 's now use'} ${assigning.name}; it applies to the next AI Trading run.` })
    } catch (err) {
      setAssignFeedback({ ok: false, text: err instanceof Error ? err.message : 'Unable to save.' })
    } finally {
      setSaving(false)
    }
  }

  const shown = filtered.slice(0, visible)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Models" value={loading && !providers ? '…' : allModels.filter((model) => includeNonChat || model.kind === 'chat').length.toLocaleString()} sublabel={`${providers?.length || 0} providers`} />
        <StatCard label="Live lists" value={liveCount} sublabel="connected providers + OpenRouter" tone="info" />
        <StatCard label="Free models" value={freeCount} sublabel="OpenRouter, for testing" tone="up" />
        <StatCard label="Showing" value={filtered.length.toLocaleString()} sublabel="after filters" />
      </div>

      <Panel
        title="Browse Models"
        action={(
          <button
            type="button"
            disabled={loading}
            onClick={() => load(true)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-white/20 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh
          </button>
        )}
      >
        <div className="grid gap-4">
          <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-xs leading-relaxed text-sky-100">
            Connected providers list every model their key can use; the rest show suggested models. OpenRouter is always listed live, including its free models —
            handy for testing the AI Trading pipeline at no cost (a free OpenRouter account key is still required, and free models are rate-limited). Use <strong>Test</strong> to
            check a model actually replies with JSON before you assign it.
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models, ids, providers…"
                aria-label="Search models"
                className="w-full rounded-full border border-white/10 bg-slate-950/70 py-2.5 pl-10 pr-4 text-sm text-white outline-none placeholder:text-slate-600"
              />
            </div>
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              aria-label="Provider"
              className="rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-white outline-none"
            >
              <option value="all">All providers</option>
              {(providers || []).map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.label} ({providerCounts[provider.providerId] || 0}){provider.source === 'live' ? '' : ' · suggested'}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              aria-label="Sort"
              className="rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-white outline-none"
            >
              {SORTS.map((item) => <option key={item.id} value={item.id}>Sort: {item.label}</option>)}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <button
              type="button"
              onClick={() => { setProviderId('openrouter'); setFreeOnly(true) }}
              className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-200 transition hover:border-emerald-400/50"
            >
              Free models for testing
            </button>
            <Toggle checked={freeOnly} onChange={setFreeOnly}>Free only</Toggle>
            <Toggle checked={jsonOnly} onChange={setJsonOnly}>Advertises JSON mode</Toggle>
            <Toggle checked={includeNonChat} onChange={setIncludeNonChat}>Include embedding / image / audio models</Toggle>
            {(providerId !== 'all' || freeOnly || jsonOnly || query) ? (
              <button type="button" onClick={() => { setProviderId('all'); setFreeOnly(false); setJsonOnly(false); setQuery('') }} className="text-xs text-sky-300 hover:underline">
                Clear filters
              </button>
            ) : null}
          </div>

          {problems.map((provider) => (
            <div key={provider.providerId} className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-200">
              {provider.label}: {provider.error}
            </div>
          ))}
          {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
        </div>
      </Panel>

      {loading && !providers ? (
        <div className="py-10 text-center text-sm text-slate-400">Loading models…</div>
      ) : !filtered.length ? (
        <div className="py-10 text-center text-sm text-slate-400">No models match these filters.</div>
      ) : (
        <div className="grid gap-3">
          {shown.map((model) => {
            const key = `${model.providerId}/${model.id}`
            return (
              <ModelRow
                key={key}
                model={model}
                test={tests[key]}
                copied={copiedKey === key}
                onCopy={() => copyId(model)}
                onTest={() => runTest(model)}
                onUse={() => { setAssignFeedback(null); setAssigning(model) }}
              />
            )
          })}
          {filtered.length > shown.length ? (
            <button
              type="button"
              onClick={() => setVisible((count) => count + PAGE_SIZE)}
              className="mx-auto rounded-full border border-white/10 px-5 py-2 text-sm font-semibold text-slate-200 transition hover:border-white/20"
            >
              Show more ({(filtered.length - shown.length).toLocaleString()} left)
            </button>
          ) : null}
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        Need a key? Add one under <Link to="/ai-models" className="text-sky-300 hover:underline">Providers &amp; Keys</Link>. Assignments made here are the same ones on{' '}
        <Link to="/ai-models/agents" className="text-sky-300 hover:underline">Agent Assignments</Link>.
      </p>

      {assigning ? (
        <AssignModal
          model={assigning}
          config={config}
          saving={saving}
          feedback={assignFeedback}
          onClose={() => setAssigning(null)}
          onSave={assign}
        />
      ) : null}
    </div>
  )
}
