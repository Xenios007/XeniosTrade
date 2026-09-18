import { useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { AI_PROVIDERS } from '../lib/aiProviders'
import { getSignalModel } from '../lib/signalModels'
import { Panel } from './Panel'
import { Modal } from './ui/Modal'
import { PageHeader } from './ui/PageHeader'

const AI_MODELS_TABS = [
  { to: '/ai-models', label: 'Providers & Keys' },
  { to: '/ai-models/bots', label: 'Bot Assignments' },
]

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

function ProviderCard({ provider, entry, status, onEdit, onRemove }) {
  const connected = Boolean(status?.present) || (provider.keyless && Boolean(entry?.baseUrl))

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{provider.label}</div>
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
          {connected ? 'Connected' : 'Not Connected'}
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
        {connected ? (
          <>
            {status?.present ? `Key stored server-side · fingerprint ${status.fingerprint || 'n/a'} · ${status.length} chars` : 'Local endpoint, no key required'}
            {entry?.baseUrl ? <div className="mt-1 truncate">Base URL: {entry.baseUrl}</div> : null}
            {entry?.model ? <div className="mt-1 truncate">Model: {entry.model}</div> : null}
          </>
        ) : (
          provider.keyless ? 'Local — no API key required.' : `Needs an API key (${provider.keyHint || 'provider key'}).`
        )}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-white/20"
        >
          {connected ? 'Update' : 'Connect'}
        </button>
        {connected ? (
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
  const [form, setForm] = useState({ apiKey: '', baseUrl: '', model: '' })
  const [feedback, setFeedback] = useState('')

  function startEdit(provider) {
    const entry = credentials[provider.id] || {}
    setEditing(provider)
    setForm({ apiKey: '', baseUrl: entry.baseUrl || '', model: entry.model || '' })
    setFeedback('')
  }

  async function save() {
    if (!editing) return
    const result = await onSave({
      aiProviderCredentials: {
        [editing.id]: { apiKey: form.apiKey, baseUrl: form.baseUrl, model: form.model },
      },
    })
    if (result?.ok) {
      setEditing(null)
      setForm({ apiKey: '', baseUrl: '', model: '' })
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
            {AI_PROVIDERS.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                entry={credentials[provider.id]}
                status={credentialStatus[provider.id]}
                onEdit={() => startEdit(provider)}
                onRemove={() => remove(provider)}
              />
            ))}
          </div>
        )}
      </Panel>

      {editing ? (
        <Modal
          title={`Connect ${editing.label}`}
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
              This provider runs locally — no API key required.
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

export function AiModelsPage({ settings, onSave, saving, ready }) {
  return (
    <div className="grid gap-6">
      <PageHeader
        title="AI Models"
        description="Connect any AI provider's API key — five already power a live trading bot, the rest are ready for one added later."
      />
      <AiModelsTabs />
      <Routes>
        <Route path="/" element={<ProvidersAndKeys settings={settings} onSave={onSave} saving={saving} ready={ready} />} />
        <Route path="bots" element={<BotAssignments settings={settings} />} />
      </Routes>
    </div>
  )
}
