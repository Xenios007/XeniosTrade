import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { visibleSignalModels } from '../lib/signalModels'
import { Panel } from './Panel'
import { PageHeader } from './ui/PageHeader'

const SIGNAL_MODELS_LIST = visibleSignalModels()

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }
  return payload
}

function SignalChips({ ownedSignals, onToggle, disabled }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SIGNAL_MODELS_LIST.map((model) => {
        const owned = ownedSignals.includes(model.id)
        return (
          <button
            key={model.id}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(model.id)}
            title={model.tag}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              owned
                ? 'border-emerald-400/30 bg-emerald-400/15 text-emerald-100'
                : 'border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200'
            }`}
          >
            {model.name}
          </button>
        )
      })}
    </div>
  )
}

function UserRow({ user, onGrant, saving }) {
  const [botSlots, setBotSlots] = useState(String(user.plan?.botSlots ?? 0))
  const [signals, setSignals] = useState(user.plan?.signals || [])
  const dirty = String(user.plan?.botSlots ?? 0) !== botSlots.trim()
    || JSON.stringify([...(user.plan?.signals || [])].sort()) !== JSON.stringify([...signals].sort())

  useEffect(() => {
    setBotSlots(String(user.plan?.botSlots ?? 0))
    setSignals(user.plan?.signals || [])
  }, [user.plan?.botSlots, user.plan?.signals])

  function toggleSignal(signalId) {
    setSignals((current) => (
      current.includes(signalId) ? current.filter((id) => id !== signalId) : [...current, signalId]
    ))
  }

  if (user.role === 'admin') {
    return (
      <tr className="border-b border-white/5 last:border-0">
        <td className="py-3 pr-4">
          <div className="font-medium text-white">{user.email}</div>
          <div className="text-xs text-slate-500">{new Date(user.createdAt).toLocaleString()}</div>
        </td>
        <td className="py-3 pr-4">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-100">
            <ShieldCheck className="h-3.5 w-3.5" />
            admin
          </span>
        </td>
        <td className="py-3 pr-4" colSpan={2}>
          <span className="text-sm text-emerald-300">Unlimited - every signal, every slot</span>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b border-white/5 last:border-0 align-top">
      <td className="py-3 pr-4">
        <div className="font-medium text-white">{user.email}</div>
        <div className="text-xs text-slate-500">{new Date(user.createdAt).toLocaleString()}</div>
      </td>
      <td className="py-3 pr-4">
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">
          user
        </span>
      </td>
      <td className="py-3 pr-4">
        <input
          type="number"
          min="0"
          step="1"
          value={botSlots}
          onChange={(event) => setBotSlots(event.target.value)}
          className="w-20 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-sky-400/40"
        />
      </td>
      <td className="py-3 pr-4">
        <SignalChips ownedSignals={signals} onToggle={toggleSignal} disabled={saving} />
      </td>
      <td className="py-3">
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => onGrant(user.id, Number(botSlots), signals)}
          className="rounded-xl bg-sky-400/15 px-3 py-2 text-sm font-semibold text-sky-100 ring-1 ring-sky-400/30 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </td>
    </tr>
  )
}

function PendingSignalRequests({ requests, onGrant, granting }) {
  if (requests.length === 0) {
    return null
  }

  return (
    <Panel title="Pending Signal Requests">
      <div className="grid gap-2">
        {requests.map((request) => (
          <div
            key={request.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">{request.email}</div>
              <div className="text-xs text-amber-200/80">
                wants {request.signalName} - requested {new Date(request.requestedAt).toLocaleString()}
              </div>
            </div>
            <button
              type="button"
              disabled={granting === request.id}
              onClick={() => onGrant(request)}
              className="rounded-xl bg-emerald-400/15 px-3 py-2 text-sm font-semibold text-emerald-100 ring-1 ring-emerald-400/30 transition hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {granting === request.id ? 'Granting…' : 'Grant'}
            </button>
          </div>
        ))}
      </div>
    </Panel>
  )
}

export function AdminUsersPage({ isAdmin }) {
  const [users, setUsers] = useState([])
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingUserId, setSavingUserId] = useState('')
  const [grantingRequestId, setGrantingRequestId] = useState('')

  async function refresh() {
    const [usersPayload, requestsPayload] = await Promise.all([
      fetchJson('/api/admin/users'),
      fetchJson('/api/admin/signal-requests'),
    ])
    setUsers(usersPayload.users || [])
    setRequests(requestsPayload.requests || [])
  }

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }

    let ignore = false
    refresh()
      .catch((fetchError) => {
        if (!ignore) {
          setError(fetchError instanceof Error ? fetchError.message : 'Unable to load admin data.')
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
  }, [isAdmin])

  async function handleGrant(userId, botSlots, signals) {
    setSavingUserId(userId)
    setError('')

    try {
      const payload = await fetchJson(`/api/admin/users/${userId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botSlots, signals }),
      })
      setUsers((current) => current.map((user) => (user.id === userId ? payload.user : user)))
      setRequests((current) => current.filter((request) => !(request.userId === userId && signals.includes(request.signalId))))
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : 'Unable to update the plan.')
    } finally {
      setSavingUserId('')
    }
  }

  async function handleGrantRequest(request) {
    setGrantingRequestId(request.id)
    setError('')

    try {
      const target = users.find((user) => user.id === request.userId)
      const nextSignals = [...new Set([...(target?.plan?.signals || []), request.signalId])]
      const payload = await fetchJson(`/api/admin/users/${request.userId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signals: nextSignals }),
      })
      setUsers((current) => current.map((user) => (user.id === request.userId ? payload.user : user)))
      setRequests((current) => current.filter((item) => item.id !== request.id))
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : 'Unable to grant this request.')
    } finally {
      setGrantingRequestId('')
    }
  }

  if (!isAdmin) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Admin" description="Bot-slot and signal entitlements for SaaS accounts." />
        <Panel title="Admin Only">
          <div className="flex items-center gap-3 text-amber-200">
            <ShieldAlert className="h-5 w-5" />
            <span>This page is only available to the workspace admin.</span>
          </div>
        </Panel>
      </div>
    )
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Admin"
        description="Grant or revoke bot slots and specific signals per account - the whole entitlement surface for the test phase (no payment gateway yet). Bot slots unlock the first N bots in order; a granted signal unlocks that one bot regardless of position."
      />

      {error ? (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      {!loading ? (
        <PendingSignalRequests requests={requests} onGrant={handleGrantRequest} granting={grantingRequestId} />
      ) : null}

      <Panel title="Accounts">
        {loading ? (
          <div className="text-sm text-slate-400">Loading accounts...</div>
        ) : users.length === 0 ? (
          <div className="text-sm text-slate-400">No accounts have signed in yet.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                <th className="pb-3 pr-4 font-medium">Account</th>
                <th className="pb-3 pr-4 font-medium">Role</th>
                <th className="pb-3 pr-4 font-medium">Bot Slots (of 9)</th>
                <th className="pb-3 pr-4 font-medium">Signals</th>
                <th className="pb-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  onGrant={handleGrant}
                  saving={savingUserId === user.id}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
