import { ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { APP_MODE_BOT, getModeUrl } from '../../lib/appMode'
import { AI_SCAN_INTERVAL_MS, AI_TRADING_EXECUTION_LIMITS, AI_TRADING_SYMBOLS } from '../../lib/aiTrading'
import { formatDateTime } from '../../lib/formatters'
import { MODE_LABEL, requestJson, useAiLedger } from '../../lib/aiTradingApi'
import { AgentAssignmentStrip } from '../AiTradingPage'
import { AI_CONFIG_CHANGED_EVENT } from './AiModeBadge'
import { Panel } from '../Panel'
import { Badge } from '../ui/Badge'
import { ScanStatusList } from './ScanStatusList'
import { Modal } from '../ui/Modal'
import { PageHeader } from '../ui/PageHeader'

const ARM_PHRASE = 'ARM REAL MONEY'

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${checked ? 'bg-sky-400' : 'bg-slate-700'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  )
}

function ModeCard({ mode, active, title, body, onSelect, busy }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onSelect(mode)}
      className={`rounded-2xl border p-4 text-left transition disabled:opacity-60 ${
        active
          ? (mode === 'real' ? 'border-amber-300/50 bg-amber-400/10' : 'border-sky-300/50 bg-sky-400/10')
          : 'border-white/10 bg-slate-950/50 hover:border-white/25'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-white">{title}</span>
        {active ? <Badge tone={mode === 'real' ? 'warn' : 'info'}>Active</Badge> : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">{body}</p>
    </button>
  )
}

// The editable number fields of the execution settings, as strings for the inputs.
const draftFromExecution = (execution) => ({
  testnetStartingBalance: String(execution.testnetStartingBalance),
  realMaxMarginUsdt: String(execution.realMaxMarginUsdt),
  dailyProfitTargetUsdt: String(execution.dailyProfitTargetUsdt ?? 0),
  dailyMaxLossUsdt: String(execution.dailyMaxLossUsdt ?? 0),
  dailyMaxTrades: String(execution.dailyMaxTrades ?? 0),
})

export function AiSettingsPage({ settings }) {
  const [config, setConfig] = useState(null)
  const [scanStatus, setScanStatus] = useState(null)
  const [localLogins, setLocalLogins] = useState(null)
  const [draft, setDraft] = useState({ testnetStartingBalance: '', realMaxMarginUsdt: '', dailyProfitTargetUsdt: '', dailyMaxLossUsdt: '', dailyMaxTrades: '' })
  const [daily, setDaily] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [arming, setArming] = useState(false)
  const [typed, setTyped] = useState('')
  const { ledger } = useAiLedger({ pollMs: 20_000 })

  const load = useCallback(async () => {
    const payload = await requestJson('/api/ai-trading/config')
    setConfig(payload.config)
    setScanStatus(payload.scanStatus || null)
    setLocalLogins({ codex: payload.codex || null, claude: payload.claude || null, fingpt: payload.fingpt || null })
    setDaily(payload.daily || null)
    setDraft(draftFromExecution(payload.config.execution))
  }, [])

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : 'Could not load AI settings.'))
  }, [load])

  // While auto-scan is on, keep its status fresh without touching the form fields the user may be editing.
  const scanEnabled = Boolean(config?.scan?.enabled)
  useEffect(() => {
    if (!scanEnabled) return undefined
    const timer = setInterval(() => {
      requestJson('/api/ai-trading/config').then((payload) => setScanStatus(payload.scanStatus || null)).catch(() => {})
    }, 30_000)
    return () => clearInterval(timer)
  }, [scanEnabled])

  async function saveScan(patch, message) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = await requestJson('/api/ai-trading/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, scan: { ...config.scan, ...patch } }),
      })
      setConfig(payload.config)
      setNotice(message)
      window.dispatchEvent(new Event(AI_CONFIG_CHANGED_EVENT))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  async function saveExecution(patch, message) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = await requestJson('/api/ai-trading/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, execution: { ...config.execution, ...patch } }),
      })
      setConfig(payload.config)
      setDraft(draftFromExecution(payload.config.execution))
      requestJson('/api/ai-trading/config').then((fresh) => setDaily(fresh.daily || null)).catch(() => {})
      setNotice(message)
      window.dispatchEvent(new Event(AI_CONFIG_CHANGED_EVENT))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!config) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Settings" />
        {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : <Panel title="Settings"><div className="py-8 text-center text-sm text-slate-400">Loading…</div></Panel>}
      </div>
    )
  }

  const execution = config.execution
  const limits = AI_TRADING_EXECUTION_LIMITS
  const botCredentialsUrl = getModeUrl(APP_MODE_BOT, '/settings/credentials')
  const realWallet = ledger?.wallets.find((wallet) => wallet.mode === 'real')

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Settings"
        description="Choose where approved AI decisions trade, arm real money, and check the model API and exchange keys the pipeline depends on."
      />
      {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      {notice ? <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-xs text-emerald-200">{notice}</div> : null}

      <Panel title="Trading mode">
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <ModeCard
              mode="testnet"
              active={execution.mode === 'testnet'}
              title="Testnet"
              body="Approved decisions trade on the Binance Futures testnet (or as local paper trades if no testnet keys are saved). Fake money — the safe place to see if the pipeline makes money."
              busy={busy}
              onSelect={(mode) => saveExecution({ mode, realArmed: false }, 'Switched to testnet mode.')}
            />
            <ModeCard
              mode="real"
              active={execution.mode === 'real'}
              title="Real money"
              body="Approved decisions can be sent to your live Binance Futures account, one at a time, by your explicit confirmation. Switching here does not arm it — arming is a separate step below."
              busy={busy}
              onSelect={(mode) => saveExecution({ mode, realArmed: false }, 'Switched to real money mode. Real money is still disarmed.')}
            />
          </div>
        </div>
      </Panel>

      <Panel title="Auto-scan" action={<Badge tone={config.scan.enabled ? 'up' : 'neutral'}>{config.scan.enabled ? 'On' : 'Off'}</Badge>}>
        <div className="grid gap-4">
          <label className="flex items-center justify-between gap-4 text-sm text-slate-200">
            <span>
              Look for trades automatically every {Math.round(AI_SCAN_INTERVAL_MS / 60_000)} minutes
              <span className="mt-0.5 block text-xs text-slate-500">
                Runs the pipeline for each symbol below, one after another, with no click. In testnet mode an approved trade opens by itself (if auto-execute is on).
                Real money is only opened by itself when it is armed and its own auto-execute switch (Real money wallet, below) is on. Each run spends model calls, so keep the list short.
              </span>
            </span>
            <Toggle
              checked={config.scan.enabled}
              disabled={busy}
              label="Auto-scan"
              onChange={(value) => saveScan({ enabled: value }, value ? 'Auto-scan is on. The first scan runs within 5 minutes.' : 'Auto-scan is off.')}
            />
          </label>
          {(
            <label className="flex items-center justify-between gap-4 text-sm text-slate-200">
              <span>
                Test mode <Badge tone={config.execution.mode === 'real' ? 'down' : 'warn'}>{config.execution.mode === 'real' ? 'REAL MONEY' : 'Testnet'}</Badge>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Pipeline check: the Market Analyst stops defaulting to HOLD and takes the direction the data leans toward, and the Critic and Risk Manager only stop a clearly bad trade (a weak
                  edge means a small size, not a veto). Flow, the code gates and the fixed risk ceilings are unchanged and can still block it. Switches itself off after the first trade opens.
                  {config.execution.mode === 'real' ? (
                    <span className="mt-1 block text-amber-200">
                      Real money: this relaxes the AI vetting for a LIVE order (the margin cap, one-position limit, plan-age and drift checks still apply, and the 10x leverage floor stays testnet-only).
                      It is switched off again when you change mode.
                    </span>
                  ) : null}
                </span>
              </span>
              <Toggle
                checked={Boolean(config.scan.testMode)}
                disabled={busy}
                label="Test mode"
                onChange={(value) => saveScan({ testMode: value }, value ? `Test mode is on${config.execution.mode === 'real' ? ' (REAL MONEY)' : ''}: the Analyst will now lean toward a direction. It turns off after the first trade opens.` : 'Test mode is off.')}
              />
            </label>
          )}
          <label className="flex items-center justify-between gap-4 text-sm text-slate-200">
            <span>
              Active profile <Badge tone={config.execution.mode === 'real' ? 'down' : 'info'}>{config.execution.mode === 'real' ? 'REAL MONEY' : 'Testnet'}</Badge>
              <span className="mt-0.5 block text-xs text-slate-500">
                Stays on (unlike test mode): the Analyst takes the direction the data leans toward instead of defaulting to HOLD, Market Flow needs two independent adverse
                signals before it blocks (a lopsided long/short ratio alone no longer does), and the Risk Manager reduces the size of an extended-but-valid entry instead of vetoing it.
                Every code gate, the risk ceilings, the margin cap and the daily limits still apply. It finds more trades, not better ones: judge it in Run History, Shadow outcomes.
              </span>
            </span>
            <Toggle
              checked={Boolean(config.scan.activeMode)}
              disabled={busy}
              label="Active profile"
              onChange={(value) => saveScan({ activeMode: value }, value ? 'Active profile is on: the pipeline will look for tradable setups more readily.' : 'Active profile is off.')}
            />
          </label>
          <div>
            <div className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-500">Symbols to scan</div>
            <div className="flex flex-wrap gap-2">
              {AI_TRADING_SYMBOLS.map((symbol) => {
                const active = config.scan.symbols.includes(symbol)
                const onlyOne = active && config.scan.symbols.length === 1
                return (
                  <button
                    key={symbol}
                    type="button"
                    disabled={busy || onlyOne}
                    title={onlyOne ? 'At least one symbol is needed' : undefined}
                    onClick={() => saveScan({ symbols: active ? config.scan.symbols.filter((item) => item !== symbol) : [...config.scan.symbols, symbol] }, `Scanning ${active ? 'stopped for' : 'now includes'} ${symbol}.`)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-sky-300/50 bg-sky-400/15 text-sky-100' : 'border-white/10 bg-slate-950/50 text-slate-400 hover:border-white/25'}`}
                  >
                    {symbol.replace('USDT', '')}
                  </button>
                )
              })}
            </div>
          </div>
          <ScanStatusList scanStatus={scanStatus} enabled={config.scan.enabled} />
        </div>
      </Panel>

      <Panel title={`${MODE_LABEL.testnet} wallet`} action={<Badge tone="info">Fake money</Badge>}>
        <div className="grid gap-4">
          <label className="flex items-center justify-between gap-4 text-sm text-slate-200">
            <span>
              Open approved decisions automatically
              <span className="mt-0.5 block text-xs text-slate-500">Runs that pass every gate open a testnet trade without a click. Only applies in testnet mode.</span>
            </span>
            <Toggle
              checked={execution.autoExecuteTestnet}
              disabled={busy}
              label="Auto-execute on testnet"
              onChange={(value) => saveExecution({ autoExecuteTestnet: value }, value ? 'Testnet auto-execute is on.' : 'Testnet auto-execute is off.')}
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-slate-400">
              {limits.testnetStartingBalance.label}
              <input
                type="number"
                min={limits.testnetStartingBalance.min}
                max={limits.testnetStartingBalance.max}
                step={limits.testnetStartingBalance.step}
                value={draft.testnetStartingBalance}
                onChange={(event) => setDraft((current) => ({ ...current, testnetStartingBalance: event.target.value }))}
                className="w-44 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => saveExecution({ testnetStartingBalance: Number(draft.testnetStartingBalance) }, 'Testnet starting balance saved.')}
              className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
            >
              Save
            </button>
            <span className="text-xs text-slate-500">Baseline for the AI ledger. Position size, leverage and stops are decided by the Risk Manager model.</span>
          </div>
        </div>
      </Panel>

      <Panel title={`${MODE_LABEL.real} wallet`} action={<Badge tone={execution.realArmed ? 'down' : 'warn'}>{execution.realArmed ? 'Armed' : 'Disarmed'}</Badge>}>
        <div className="grid gap-4">
          <div className="flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {execution.autoExecuteReal
                ? 'Auto-execute is ON: an approved run opens a live order by itself, with no click and no confirmation.'
                : 'Auto-execute is off: even when armed, every live order needs you to press Execute on an approved run and type the symbol.'}
              {' '}The size is scaled down to the margin cap below and your available balance, stops and targets are placed on the exchange,
              and the plan is refused if it is older than 10 minutes or the price has moved more than 0.5%. Only one real position can be open at a time.
              The system's own readiness review still says it is not ready for real money — treat this as a small live experiment.
            </p>
          </div>

          <label className="flex items-center justify-between gap-4 text-sm text-slate-200">
            <span>
              Open approved decisions automatically (real money)
              <span className="mt-0.5 block text-xs text-slate-500">
                Like testnet: a run that passes every gate opens a live order with no click and no typed confirmation. Only works while real money is armed;
                disarming or switching mode turns it off again. The margin cap, one-position limit, 10-minute plan age and 0.5% price-drift checks still apply.
              </span>
            </span>
            <Toggle
              checked={Boolean(execution.autoExecuteReal)}
              disabled={busy || !execution.realArmed}
              label="Auto-execute on real money"
              onChange={(value) => saveExecution({ autoExecuteReal: value }, value ? 'Real money auto-execute is ON: approved runs now open live orders by themselves.' : 'Real money auto-execute is off.')}
            />
          </label>

          <div className="grid gap-3 rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3">
            <div className="text-sm text-slate-200">
              Daily limits on automatic real-money trades
              <span className="mt-0.5 block text-xs text-slate-500">
                Once today&apos;s realized result (after an estimated 0.1% fee per trade) reaches the profit target or the loss stop, or that many trades were opened,
                no new automatic real trade opens until tomorrow (Manila time). Open positions keep being managed, and you can still execute a run by hand. 0 = off.
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {[
                ['dailyProfitTargetUsdt', 'Profit target (USDT)'],
                ['dailyMaxLossUsdt', 'Loss stop (USDT)'],
                ['dailyMaxTrades', 'Max trades'],
              ].map(([key, label]) => (
                <label key={key} className="grid gap-1 text-xs text-slate-400">
                  {label}
                  <input
                    type="number"
                    min={0}
                    step={key === 'dailyMaxTrades' ? 1 : 0.5}
                    value={draft[key]}
                    onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                    className="w-32 rounded-2xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none"
                  />
                </label>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => saveExecution({
                  dailyProfitTargetUsdt: Number(draft.dailyProfitTargetUsdt) || 0,
                  dailyMaxLossUsdt: Number(draft.dailyMaxLossUsdt) || 0,
                  dailyMaxTrades: Number(draft.dailyMaxTrades) || 0,
                }, 'Daily limits saved.')}
                className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
              >
                Save limits
              </button>
            </div>
            {daily ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>Today ({daily.dateKey}, {daily.mode}): realized {daily.realizedUsdt >= 0 ? '+' : ''}{Number(daily.realizedUsdt).toFixed(2)} USDT · {daily.tradesOpened} opened · {daily.wins} won / {daily.losses} lost</span>
                {daily.blocked ? <Badge tone="warn">{daily.blocked.code === 'profit' ? 'Profit target reached' : daily.blocked.code === 'loss' ? 'Loss stop hit' : 'Trade cap reached'}</Badge> : <Badge tone="up">Trading allowed</Badge>}
              </div>
            ) : null}
          </div>

          <label className="flex items-center justify-between gap-4 text-sm text-slate-200">
            <span>
              Position Manager acts on real-money positions
              <span className="mt-0.5 block text-xs text-slate-500">
                The Position Manager always reviews open real-money trades, but by default it only advises. Switched on, it may move the stop toward profit, take a partial,
                change the target, or close the position on the live account by itself. It can never add risk. Off by default.
              </span>
            </span>
            <Toggle
              checked={Boolean(execution.positionManagerActsOnReal)}
              disabled={busy}
              label="Position Manager acts on real money"
              onChange={(value) => saveExecution({ positionManagerActsOnReal: value }, value ? 'The Position Manager may now act on real-money positions.' : 'The Position Manager only advises on real-money positions.')}
            />
          </label>

          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-slate-400">
              {limits.realMaxMarginUsdt.label}
              <input
                type="number"
                min={limits.realMaxMarginUsdt.min}
                max={limits.realMaxMarginUsdt.max}
                step={limits.realMaxMarginUsdt.step}
                value={draft.realMaxMarginUsdt}
                onChange={(event) => setDraft((current) => ({ ...current, realMaxMarginUsdt: event.target.value }))}
                className="w-44 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => saveExecution({ realMaxMarginUsdt: Number(draft.realMaxMarginUsdt) }, 'Real money margin cap saved.')}
              className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
            >
              Save
            </button>
            {realWallet?.exchange?.walletBalance != null ? (
              <span className="text-xs text-slate-500">Live account balance {Number(realWallet.exchange.walletBalance).toFixed(2)} USDT</span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {execution.realArmed ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => saveExecution({ realArmed: false }, 'Real money disarmed.')}
                className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
              >
                Disarm real money
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || execution.mode !== 'real' || !ledger?.credentials.real}
                onClick={() => { setTyped(''); setArming(true) }}
                className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Arm real money…
              </button>
            )}
            <span className="text-xs text-slate-500">
              {execution.mode !== 'real'
                ? 'Switch to real money mode first.'
                : !ledger?.credentials.real
                  ? 'Live Binance API keys are not saved.'
                  : execution.realArmed
                    ? (execution.autoExecuteReal ? 'Armed with auto-execute: approved runs open live orders by themselves.' : 'Armed: approved runs can be executed live, one confirmation each.')
                    : 'Disarmed: no live order can be placed.'}
            </span>
          </div>
        </div>
      </Panel>

      <Panel
        title="AI model API"
        action={<Link to="/ai-models" className="text-xs text-sky-300 hover:underline">Providers &amp; Keys</Link>}
      >
        <div className="grid gap-4">
          <AgentAssignmentStrip config={config} settings={settings} localLogins={localLogins} />
          <p className="text-xs leading-relaxed text-slate-500">
            Each agent calls the provider and model assigned to it. Save provider API keys on{' '}
            <Link to="/ai-models" className="text-sky-300 hover:underline">Providers &amp; Keys</Link>, pick what each agent uses on{' '}
            <Link to="/ai-models/agents" className="text-sky-300 hover:underline">Agent Assignments</Link>, and find or test models on{' '}
            <Link to="/ai-models/browse" className="text-sky-300 hover:underline">Browse Models</Link>. Keys stay on the server and are never sent to this page.
          </p>
        </div>
      </Panel>

      <Panel title="Exchange API keys &amp; risk">
        <div className="grid gap-3 text-xs text-slate-300">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-40 text-slate-500">Binance testnet keys</span>
            <Badge tone={ledger?.credentials.testnet ? 'up' : 'warn'}>{ledger ? (ledger.credentials.testnet ? 'Saved' : 'Not saved') : '…'}</Badge>
            <span className="w-40 text-slate-500 sm:ml-6">Binance live keys</span>
            <Badge tone={ledger?.credentials.real ? 'up' : 'warn'}>{ledger ? (ledger.credentials.real ? 'Saved' : 'Not saved') : '…'}</Badge>
          </div>
          <p className="leading-relaxed text-slate-500">
            Exchange keys are shared with the bot workspace and edited there
            {botCredentialsUrl ? <> (<a href={botCredentialsUrl} className="text-sky-300 hover:underline">API Credentials</a>)</> : ' (Settings → API Credentials)'}.
            Position size, leverage and stops are decided by the Risk Manager model (see <Link to="/ai-models/agents" className="text-sky-300 hover:underline">AI Models</Link>).
          </p>
        </div>
      </Panel>

      {arming ? (
        <Modal
          title="Arm real money trading"
          onClose={() => { if (!busy) setArming(false) }}
          footer={(
            <>
              <button type="button" disabled={busy} onClick={() => setArming(false)} className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-300">Cancel</button>
              <button
                type="button"
                disabled={busy || typed.trim().toUpperCase() !== ARM_PHRASE}
                onClick={async () => { if (await saveExecution({ realArmed: true }, 'Real money is armed. Nothing trades until you execute an approved run (or switch on real-money auto-execute).')) setArming(false) }}
                className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Arm
              </button>
            </>
          )}
        >
          <p className="text-sm leading-relaxed text-amber-100">
            Armed, an approved AI run can be executed on your live Binance account (max {execution.realMaxMarginUsdt} USDT margin, one position at a time).
            Every order needs your confirmation unless you also switch on real-money auto-execute. Switching back to testnet mode disarms it (and turns auto-execute off) automatically.
          </p>
          <label className="grid gap-1 text-xs text-slate-400">
            Type <code className="text-amber-200">{ARM_PHRASE}</code> to continue
            <input
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none"
              placeholder={ARM_PHRASE}
            />
          </label>
        </Modal>
      ) : null}
    </div>
  )
}
