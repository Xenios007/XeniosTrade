import { useEffect, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { AI_PROVIDERS, getAiProvider, isLocalLoginReady, isProviderConnected, isProviderListed, providerDisplayName } from '../lib/aiProviders'
import { AI_TRADING_AGENTS, AI_TRADING_LLM_AGENT_IDS } from '../lib/aiTrading'
import { APP_MODE, APP_MODE_AI, APP_MODE_BOT, isAiModelsTabVisible } from '../lib/appMode'
import { AiModelsBrowser } from './AiModelsBrowser'
import { getSignalModel } from '../lib/signalModels'
import { Panel } from './Panel'
import { Badge } from './ui/Badge'
import { Modal } from './ui/Modal'
import { PageHeader } from './ui/PageHeader'

// The apex workspace shows every tab; ai.* and bot.* only show their own.
const AI_MODELS_TABS = [
  { to: '/ai-models', label: 'Providers & Keys' },
  { to: '/ai-models/browse', label: 'Browse Models' },
  { to: '/ai-models/bots', label: 'Bot Assignments' },
  { to: '/ai-models/agents', label: 'Agent Assignments' },
].filter((tab) => isAiModelsTabVisible(APP_MODE, tab.to))

const AI_MODELS_DESCRIPTION = {
  [APP_MODE_AI]: "Connect any AI provider's API key and choose which model runs each AI Trading agent.",
  [APP_MODE_BOT]: "Connect any AI provider's API key — five power a live trading bot, the rest are ready for later.",
}

// The five bots that actually call a provider today (see docs/LLM_TRADING_BOTS.md).
// Every other AI_PROVIDERS entry can still hold a key here for a future bot.
const WIRED_BOTS = [
  { providerId: 'anthropic', signalModelId: 'model-11', walletLabel: 'Wallet 11' },
  { providerId: 'openai', signalModelId: 'model-12', walletLabel: 'Wallet 12' },
  { providerId: 'google', signalModelId: 'model-13', walletLabel: 'Wallet 13' },
  { providerId: 'xai', signalModelId: 'model-14', walletLabel: 'Wallet 14' },
  { providerId: 'openrouter', signalModelId: 'model-15', walletLabel: 'Wallet 15' },
]

function AiModelsTabs() {
  return (
    <nav className="flex flex-wrap gap-2 border-b border-white/10 pb-4">
      {AI_MODELS_TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/ai-models'}
          className={({ isActive }) =>
            `rounded-full px-4 py-2 text-sm font-medium transition ${
              isActive
                ? 'bg-sky-400 text-slate-950'
                : 'border border-white/10 bg-slate-950/60 text-slate-300 hover:border-white/20'
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}

function ProviderCard({ provider, entry, status, liveStatus, onEdit, onRemove }) {
  // A built-in local model (FinGPT) is "connected" while its server answers, not because a URL was saved.
  const connected = provider.localServer
    ? Boolean(liveStatus?.loggedIn)
    : isProviderConnected(provider, entry, Boolean(status?.present))

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{providerDisplayName(provider, { [provider.id]: entry })}</div>
          <div className="mt-0.5 truncate text-[11px] uppercase tracking-[0.14em] text-slate-500">
            {provider.id}
            {provider.advanced ? ' · advanced' : ''}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            connected
              ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
              : 'border-amber-400/20 bg-amber-400/10 text-amber-200'
          }`}
        >
          {connected ? (provider.localServer ? 'Running' : 'Connected') : (provider.localServer ? (liveStatus?.available ? 'Loading' : 'Offline') : 'Not Connected')}
        </span>
      </div>

      <div className="text-xs leading-relaxed text-slate-400">
        {provider.wiredBot ? (
          <span className="text-sky-300">{provider.wiredBot}</span>
        ) : (
          <span>Not wired to a bot yet — saved for future use.</span>
        )}
      </div>

      <div className="text-xs leading-relaxed text-slate-400">
        {provider.localServer ? (
          <>
            {connected ? 'Local model server is running.' : 'Local model server is not reachable — start it with npm run fingpt (or check the tunnel).'}
            {status?.present ? <div className="mt-1">Access token stored server-side.</div> : null}
            <div className="mt-1 truncate">Base URL: {entry?.baseUrl || provider.baseUrl}</div>
            {entry?.model ? <div className="mt-1 truncate">Model: {entry.model}</div> : null}
          </>
        ) : connected ? (
          <>
            {status?.present ? `Key stored server-side · fingerprint ${status.fingerprint || 'n/a'} · ${status.length} chars` : (provider.customSlot ? 'No API key saved (optional).' : 'Local endpoint, no key required')}
            {entry?.baseUrl ? <div className="mt-1 truncate">Base URL: {entry.baseUrl}</div> : null}
            {entry?.model ? <div className="mt-1 truncate">Model: {entry.model}</div> : null}
          </>
        ) : (
          provider.customSlot ? 'Add the base URL of any OpenAI-compatible server — API key optional.'
            : provider.keyless ? 'Local — no API key required.' : `Needs an API key (${provider.keyHint || 'provider key'}).`
        )}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-white/20"
        >
          {connected || provider.localServer ? (provider.localServer ? 'Configure' : 'Update') : 'Connect'}
        </button>
        {(provider.localServer ? Boolean(entry?.baseUrl || entry?.model) : connected) ? (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-full border border-rose-400/20 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:border-rose-400/30"
          >
            Remove
          </button>
        ) : null}
        {provider.docs ? (
          <a
            href={provider.docs}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-400 transition hover:text-slate-200"
          >
            Docs ↗
          </a>
        ) : null}
      </div>
    </div>
  )
}

function ProvidersAndKeys({ settings, onSave, saving, ready }) {
  const credentials = settings?.aiProviderCredentials || {}
  const credentialStatus = settings?.aiProviderCredentialStatus || {}
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ apiKey: '', baseUrl: '', model: '', label: '' })
  const [feedback, setFeedback] = useState('')
  const [liveStatus, setLiveStatus] = useState(null)

  // Built-in local models report their own readiness on the AI Trading config payload.
  useEffect(() => {
    let cancelled = false
    fetch('/api/ai-trading/config')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => { if (!cancelled && payload) setLiveStatus({ fingpt: payload.fingpt || null }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  function startEdit(provider) {
    const entry = credentials[provider.id] || {}
    setEditing(provider)
    setForm({ apiKey: '', baseUrl: entry.baseUrl || '', model: entry.model || '', label: entry.label || '' })
    setFeedback('')
  }

  async function save() {
    if (!editing) return
    const result = await onSave({
      aiProviderCredentials: {
        [editing.id]: { apiKey: form.apiKey, baseUrl: form.baseUrl, model: form.model, label: form.label },
      },
    })
    if (result?.ok) {
      setEditing(null)
      setForm({ apiKey: '', baseUrl: '', model: '', label: '' })
    } else {
      setFeedback(result?.error || 'Unable to save this provider.')
    }
  }

  async function remove(provider) {
    await onSave({ aiProviderCredentials: { [provider.id]: null } })
  }

  return (
    <>
      <Panel title="AI Providers">
        <div className="mb-4 rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-xs leading-relaxed text-sky-100">
          Keys are stored server-side only and never sent back to the browser — leave the key field blank when
          updating base URL or model to keep the existing key. Five providers (marked with their bot) already
          drive a live trading bot; the rest are ready to save a key for a bot added later.
        </div>
        {!ready ? (
          <div className="py-8 text-center text-sm text-slate-400">Loading…</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {AI_PROVIDERS.filter((provider) => !provider.agentOnly && isProviderListed(provider, credentials)).map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                entry={credentials[provider.id]}
                status={credentialStatus[provider.id]}
                liveStatus={liveStatus?.[provider.id]}
                onEdit={() => startEdit(provider)}
                onRemove={() => remove(provider)}
              />
            ))}
          </div>
        )}
      </Panel>

      {editing ? (
        <Modal
          title={`Connect ${providerDisplayName(editing, credentials)}`}
          onClose={() => setEditing(null)}
          footer={(
            <>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-full border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        >
          {feedback ? (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{feedback}</div>
          ) : null}
          {editing.customSlot ? (
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Display name (optional)</span>
              <input
                value={form.label}
                maxLength={40}
                onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                placeholder="e.g. My vLLM · Qwen 2.5 7B"
                className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
              />
            </label>
          ) : null}
          {!editing.keyless ? (
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">
                API Key {editing.keyHint ? `(${editing.keyHint})` : ''}
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={form.apiKey}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={credentialStatus[editing.id]?.present ? 'Leave blank to keep the current key' : 'Paste API key'}
                className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
              />
            </label>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-slate-400">
              {editing.localServer
                ? 'Built-in local model (FinGPT). Leave the Base URL empty to use it, or set it to any other OpenAI-compatible server (llama.cpp, vLLM, LM Studio…, or FinGPT behind a tunnel such as https://llm.projxenios.trade/v1). The API key is only needed for a tunnel / remote URL.'
                : 'This provider runs locally — no API key required.'}
            </div>
          )}
          {(editing.baseUrlEditable || editing.baseUrlRequired) ? (
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">
                Base URL{editing.baseUrlRequired ? '' : ' (optional)'}
              </span>
              <input
                value={form.baseUrl}
                onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder={editing.baseUrlHint || editing.baseUrl || 'https://…/v1'}
                className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
              />
            </label>
          ) : null}
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Model id (optional)</span>
            <input
              value={form.model}
              onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
              placeholder={editing.suggested?.[0] || 'model id'}
              list={`ai-model-suggestions-${editing.id}`}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
            />
            {editing.suggested?.length ? (
              <datalist id={`ai-model-suggestions-${editing.id}`}>
                {editing.suggested.map((modelId) => <option key={modelId} value={modelId} />)}
              </datalist>
            ) : null}
            {editing.suggested?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {editing.suggested.map((modelId) => (
                  <button
                    key={modelId}
                    type="button"
                    onClick={() => setForm((current) => ({ ...current, model: modelId }))}
                    className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-slate-400 transition hover:border-white/20 hover:text-slate-200"
                  >
                    {modelId}
                  </button>
                ))}
              </div>
            ) : null}
          </label>
        </Modal>
      ) : null}
    </>
  )
}

function BotAssignments({ settings }) {
  const credentials = settings?.aiProviderCredentials || {}
  const credentialStatus = settings?.aiProviderCredentialStatus || {}

  return (
    <Panel title="LLM Trading Bots">
      <div className="mb-4 text-xs leading-relaxed text-slate-400">
        Every bot below shares the same fixed BTC/ETH/SOL/BNB scan universe, schedule, confidence floor, and risk
        budget — the only difference is which model answers. Configure a provider's key and model in
        &nbsp;<span className="text-sky-300">Providers &amp; Keys</span>; it takes effect on the next scan cycle.
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {WIRED_BOTS.map(({ providerId, signalModelId, walletLabel }) => {
          const provider = AI_PROVIDERS.find((item) => item.id === providerId)
          const signalModel = getSignalModel(signalModelId)
          const entry = credentials[providerId]
          const status = credentialStatus[providerId]
          const connected = Boolean(status?.present)

          return (
            <div key={signalModelId} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-white">{signalModel.name}</div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{walletLabel} · {provider?.label}</div>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                    connected
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                      : 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                  }`}
                >
                  {connected ? 'Live' : 'Watching'}
                </span>
              </div>
              <div className="mt-2 text-xs leading-relaxed text-slate-400">
                {connected
                  ? `Trading with ${entry?.model || 'its default model'}.`
                  : 'No API key configured — stays in "watching" state and never trades.'}
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// Which provider/model answers each AI Trading agent (the Analyst, Critic and
// Position Manager). Stored server-side in server/data/ai-trading/config.json,
// not in settings.json — see server/ai-trading/store.js.
function AgentAssignments({ settings }) {
  const credentials = settings?.aiProviderCredentials || {}
  const credentialStatus = settings?.aiProviderCredentialStatus || {}
  const [config, setConfig] = useState(null)
  const [localLogins, setLocalLogins] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/ai-trading/config')
      .then((response) => response.json().then((payload) => ({ response, payload })))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
        if (!cancelled) {
          setConfig(payload.config)
          setLocalLogins({ codex: payload.codex || null, claude: payload.claude || null, fingpt: payload.fingpt || null })
          setDraft(payload.config.agents)
        }
      })
      .catch((error) => { if (!cancelled) setFeedback({ ok: false, text: error.message }) })
    return () => { cancelled = true }
  }, [])

  const dirty = Boolean(config && draft) && JSON.stringify(config.agents) !== JSON.stringify(draft)

  function update(agentId, patch) {
    setDraft((current) => ({ ...current, [agentId]: { ...current[agentId], ...patch } }))
    setFeedback(null)
  }

  async function save() {
    setSaving(true)
    setFeedback(null)
    try {
      const response = await fetch('/api/ai-trading/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, agents: draft }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`)
      setConfig(payload.config)
      setDraft(payload.config.agents)
      setFeedback({ ok: true, text: 'Saved. Applies to the next AI Trading run.' })
    } catch (error) {
      setFeedback({ ok: false, text: error instanceof Error ? error.message : 'Unable to save.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="AI Trading Agents"
      action={(
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
    >
      <div className="mb-4 text-xs leading-relaxed text-slate-400">
        The <Link to="/ai-trading" className="text-sky-300 hover:underline">AI Trading</Link> pipeline has five AI agents and every one calls a model —
        four decide the entry (Analyst, Flow, Critic, Risk Manager) and the Position Manager manages the open trade. Pick which provider answers each. The Risk Manager model decides stop, size and leverage; fixed ceilings in code only cap its answer, so it can be stricter
        but never looser. Keys live on <span className="text-sky-300">Providers &amp; Keys</span> (Codex and Claude need none — they use the server's own login); using a different model for the Critic than for the Analyst
        makes for a better second opinion.
      </div>
      {!draft ? (
        <div className="py-8 text-center text-sm text-slate-400">{feedback && !feedback.ok ? feedback.text : 'Loading…'}</div>
      ) : (
        <div className="grid gap-3">
          {AI_TRADING_AGENTS.map((agent) => {
            if (!AI_TRADING_LLM_AGENT_IDS.includes(agent.id)) {
              return (
                <div key={agent.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{agent.name}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{agent.role}</div>
                  </div>
                  <Badge tone={agent.kind === 'code' ? 'warn' : 'neutral'}>Statistics · no AI</Badge>
                </div>
              )
            }

            const assignment = draft[agent.id]
            const provider = getAiProvider(assignment.providerId)
            // Codex / Claude have no saved key: they work when the server has the SDK and a `codex login` / `claude login`.
            const loginStatus = localLogins?.[provider?.id]
            const loginName = provider?.label?.split(' ')[0]
            const connected = provider
              ? (provider.localLogin
                ? isLocalLoginReady(localLogins, provider.id)
                : isProviderConnected(provider, credentials[provider.id], Boolean(credentialStatus[provider.id]?.present)))
              : false
            const effectiveModel = assignment.model || (provider?.localLogin && !provider?.localServer ? '' : credentials[provider?.id]?.model || provider?.suggested?.[0] || '')
            const notConnectedLabel = provider?.localServer
              ? (loginStatus?.available ? 'Model still loading' : 'Local server offline')
              : provider?.localLogin
              ? (loginStatus && !loginStatus.available ? `${loginName} SDK missing` : 'Not logged in')
              : 'No key saved'

            return (
              <div key={agent.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{agent.name}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{agent.role}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {agent.guardrail ? <Badge tone="warn">{agent.guardrail}</Badge> : null}
                    <Badge tone={connected ? 'up' : 'warn'}>{connected ? 'Connected' : provider ? notConnectedLabel : 'Unassigned'}</Badge>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Provider</span>
                    <select
                      value={assignment.providerId}
                      onChange={(event) => update(agent.id, { providerId: event.target.value, model: '' })}
                      className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
                    >
                      <option value="">Unassigned (agent will not run)</option>
                      {AI_PROVIDERS.filter((item) => isProviderListed(item, credentials) || item.id === assignment.providerId).map((item) => (
                        <option key={item.id} value={item.id}>{providerDisplayName(item, credentials)}{(item.localLogin ? isLocalLoginReady(localLogins, item.id) : isProviderConnected(item, credentials[item.id], Boolean(credentialStatus[item.id]?.present))) ? ' ✓' : ''}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Model id (optional)</span>
                    <input
                      value={assignment.model}
                      disabled={!provider}
                      onChange={(event) => update(agent.id, { model: event.target.value })}
                      placeholder={effectiveModel || (provider?.localLogin && !provider?.localServer ? `${loginName} default model` : 'model id')}
                      list={`agent-model-suggestions-${agent.id}`}
                      className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none disabled:opacity-40"
                    />
                    {provider?.suggested?.length ? (
                      <datalist id={`agent-model-suggestions-${agent.id}`}>
                        {provider.suggested.map((modelId) => <option key={modelId} value={modelId} />)}
                      </datalist>
                    ) : null}
                  </label>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  {provider?.localServer
                    ? 'Runs on this machine: FinGPT (Llama 3 8B + LoRA, 4-bit NF4) via server/local-llm — no API key, no per-token cost. Start it with npm run fingpt. Calls are slow (partly offloaded to RAM).'
                    : provider?.localLogin
                    ? `Runs through this server's ${loginName} login${assignment.model ? ` with ${assignment.model}` : ' with its default model'} — no API key, counted against that ${loginName} account. Each call can take a minute or more.`
                    : provider ? `Will call ${effectiveModel || 'a model you still need to name'}${assignment.model ? '' : ' (provider default)'}.` : 'Nothing is called until a provider is chosen.'}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {feedback && draft ? (
        <div className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${feedback.ok ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/20 bg-rose-400/10 text-rose-200'}`}>
          {feedback.text}
        </div>
      ) : null}
    </Panel>
  )
}

export function AiModelsPage({ settings, onSave, saving, ready }) {
  return (
    <div className="grid gap-6">
      <PageHeader
        title="AI Models"
        description={AI_MODELS_DESCRIPTION[APP_MODE] || "Connect any AI provider's API key — five power a live trading bot, five power AI Trading agents, the rest are ready for later."}
      />
      <AiModelsTabs />
      <Routes>
        <Route path="/" element={<ProvidersAndKeys settings={settings} onSave={onSave} saving={saving} ready={ready} />} />
        {isAiModelsTabVisible(APP_MODE, '/ai-models/browse') ? <Route path="browse" element={<AiModelsBrowser settings={settings} />} /> : null}
        {isAiModelsTabVisible(APP_MODE, '/ai-models/bots') ? <Route path="bots" element={<BotAssignments settings={settings} />} /> : null}
        {isAiModelsTabVisible(APP_MODE, '/ai-models/agents') ? <Route path="agents" element={<AgentAssignments settings={settings} />} /> : null}
        <Route path="*" element={<Navigate to="/ai-models" replace />} />
      </Routes>
    </div>
  )
}
