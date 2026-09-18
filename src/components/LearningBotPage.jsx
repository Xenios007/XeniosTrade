import { useEffect, useState } from 'react'
import { BrainCircuit, Cpu, Database, FlaskConical, GitBranch, Scale } from 'lucide-react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import {
  getLearningBotDataset,
  getLearningBotSummary,
  getLearningBotTrainStatus,
  startLearningBotTraining,
} from '../lib/api'
import { AIAdvisoryPanel } from './AIAdvisoryPanel'
import { AIAssistantSidebar } from './AIAssistantSidebar'
import { BacktestHistoryPanel } from './BacktestHistoryPanel'
import { SignalInsightsPanel } from './SignalInsightsPanel'
import { Panel } from './Panel'

const AI_TRAINING_TABS = [
  { to: '/ai-training', label: 'Training', end: true },
  { to: '/ai-training/backtests', label: 'Backtests' },
  { to: '/ai-training/insights', label: 'Signal Insights' },
  { to: '/ai-training/advisory', label: 'AI Advisory' },
  { to: '/ai-training/assistant', label: 'AI Assistant' },
]

function AITrainingTabs() {
  return (
    <nav className="flex flex-wrap gap-2 border-b border-white/10 pb-4">
      {AI_TRAINING_TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
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

const BOT_LABELS = {
  'model-1': 'Bot 1',
  'model-2': 'Bot 2',
  'model-3': 'Bot 3',
  'model-4': 'Bot 4',
  'model-5': 'Bot 5',
  'model-6': 'Bot 6',
  'model-7': 'Bot 7',
  'model-8': 'Bot 8',
  'model-9': 'Bot 9 — Experimental',
  'model-10': 'Bot 10 — Consolidated Knowledge',
}

const DEFAULT_FORM = {
  enabled: false,
  focusSource: 'auto',
  trainingScope: 'per-bot',
  focusSignalModelId: 'all',
  reviewWindowTrades: 0,
  minClosedTradesForInsights: 12,
  requireCandleClose: true,
  blockCounterTrend: true,
  notes: '',
  aiTrainer: {
    enabled: false,
    framework: 'pytorch',
    algorithm: 'dqn',
    runtimeCommand: 'python3',
    devicePreference: 'cpu',
    epochs: 20,
    batchSize: 64,
    learningRate: 0.0005,
    stateWindow: 32,
    rewardMode: 'pnl-risk',
  },
  aiEntryFilter: {
    enabled: false,
    paperOnly: true,
    thresholdScore: 55,
  },
  perBotOverrides: {
    'model-1': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-2': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-3': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-4': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-5': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-6': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-7': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-8': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-9': { enabled: false, paperOnly: true, thresholdScore: 55 },
    'model-10': { enabled: false, paperOnly: true, thresholdScore: 55 },
  },
}

function toFormState(config = {}) {
  return {
    ...DEFAULT_FORM,
    ...(config && typeof config === 'object' ? config : {}),
    aiTrainer: {
      ...DEFAULT_FORM.aiTrainer,
      ...(config?.aiTrainer && typeof config.aiTrainer === 'object' ? config.aiTrainer : {}),
    },
    aiEntryFilter: {
      ...DEFAULT_FORM.aiEntryFilter,
      ...(config?.aiEntryFilter && typeof config.aiEntryFilter === 'object' ? config.aiEntryFilter : {}),
    },
    perBotOverrides: Object.fromEntries(
      Object.keys(BOT_LABELS).map((modelId) => [
        modelId,
        {
          ...DEFAULT_FORM.perBotOverrides[modelId],
          ...(config?.perBotOverrides?.[modelId] && typeof config.perBotOverrides[modelId] === 'object'
            ? config.perBotOverrides[modelId]
            : {}),
        },
      ]),
    ),
  }
}

function toPayload(form) {
  return {
    ...form,
    reviewWindowTrades: Number(form.reviewWindowTrades || 0),
    minClosedTradesForInsights: Number(form.minClosedTradesForInsights || 0),
    aiTrainer: {
      ...form.aiTrainer,
      epochs: Number(form.aiTrainer.epochs || 0),
      batchSize: Number(form.aiTrainer.batchSize || 0),
      learningRate: Number(form.aiTrainer.learningRate || 0),
      stateWindow: Number(form.aiTrainer.stateWindow || 0),
    },
    aiEntryFilter: {
      ...form.aiEntryFilter,
      thresholdScore: Number(form.aiEntryFilter.thresholdScore || 0),
    },
    perBotOverrides: Object.fromEntries(
      Object.keys(BOT_LABELS).map((modelId) => [
        modelId,
        {
          ...form.perBotOverrides[modelId],
          thresholdScore: Number(form.perBotOverrides[modelId]?.thresholdScore || 0),
        },
      ]),
    ),
  }
}

function formatSignedUsdt(value) {
  const amount = Number(value || 0)
  const sign = amount > 0 ? '+' : ''
  return `${sign}${amount.toFixed(2)} USDT`
}

function getLearningBotLoadErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('404')) {
    return 'Learning Bot data is temporarily unavailable from the current backend response.'
  }

  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return 'Learning Bot data is unavailable because the backend server is not reachable on 127.0.0.1:3001. Start `npm.cmd run dev:server` or `npm.cmd run dev:all`.'
  }

  return message
}

function Stat({ label, value, detail }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">{label}</div>
      <div className="mt-2 text-lg font-semibold text-white">{value}</div>
      <div className="mt-1 text-sm text-slate-400">{detail}</div>
    </div>
  )
}

function formatLearningTimestamp(value, fallback = 'Never') {
  const timestamp = Number(value || 0)

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return fallback
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

function formatLearningRelativeTime(value) {
  const timestamp = Number(value || 0)

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'No timestamp recorded yet.'
  }

  const diffMs = timestamp - Date.now()
  const absDiffMs = Math.abs(diffMs)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  if (absDiffMs < 60_000) {
    return rtf.format(Math.round(diffMs / 1000), 'second')
  }

  if (absDiffMs < 3_600_000) {
    return rtf.format(Math.round(diffMs / 60_000), 'minute')
  }

  if (absDiffMs < 86_400_000) {
    return rtf.format(Math.round(diffMs / 3_600_000), 'hour')
  }

  return rtf.format(Math.round(diffMs / 86_400_000), 'day')
}

function getLatestLearningArtifactTimestamp(trainStatus) {
  const artifactGeneratedAt = Number(trainStatus?.artifactGeneratedAt || 0)
  if (Number.isFinite(artifactGeneratedAt) && artifactGeneratedAt > 0) {
    return artifactGeneratedAt
  }

  const lastSuccessfulCompletedAt = Number(trainStatus?.lastSuccessfulCompletedAt || 0)
  if (Number.isFinite(lastSuccessfulCompletedAt) && lastSuccessfulCompletedAt > 0) {
    return lastSuccessfulCompletedAt
  }

  const lastCompletedAt = Number(trainStatus?.lastCompletedAt || 0)
  if (Number.isFinite(lastCompletedAt) && lastCompletedAt > 0 && Number(trainStatus?.lastExitCode) === 0) {
    return lastCompletedAt
  }

  return null
}

function buildPerBotAiStatuses(trainStatus) {
  const bySignalModel = trainStatus?.metrics?.policy?.bySignalModel || {}

  return Object.entries(BOT_LABELS).map(([modelId, label]) => {
    const setupFamilyScores = bySignalModel?.[modelId]?.setupFamilyScores || {}
    const families = Object.entries(setupFamilyScores)
    const count = families.reduce((sum, [, item]) => sum + Number(item?.count || 0), 0)
    const weightedReward = families.reduce((sum, [, item]) => sum + (Number(item?.avgReward || 0) * Number(item?.count || 0)), 0)
    const weightedWinRate = families.reduce((sum, [, item]) => sum + (Number(item?.winRate || 0) * Number(item?.count || 0)), 0)
    const topFamily = families
      .sort((left, right) => Number(right[1]?.count || 0) - Number(left[1]?.count || 0))[0] || null

    return {
      modelId,
      label,
      ready: count > 0,
      sampleCount: count,
      avgReward: count > 0 ? weightedReward / count : 0,
      avgWinRate: count > 0 ? weightedWinRate / count : 0,
      topFamily: topFamily ? topFamily[0] : 'No policy yet',
    }
  })
}

function getAiGateModeLabel({ enabled, paperOnly }) {
  if (!enabled) {
    return 'Disabled'
  }

  return paperOnly ? 'Paper Only' : 'Hard Block'
}

export function LearningBotPage({
  settings,
  onSave,
  saving = false,
  ready = false,
  runtimeProfile = 'workstation',
  analysis = null,
  activeSignalModelId = null,
  activeModelRiskSummary = '',
  modelChecklistAnalysis = null,
}) {
  const [form, setForm] = useState(() => toFormState(settings?.learningBot))
  const [summary, setSummary] = useState(null)
  const [dataset, setDataset] = useState(null)
  const [trainStatus, setTrainStatus] = useState(null)
  const [error, setError] = useState('')
  const [saveFeedback, setSaveFeedback] = useState('')
  const [trainingFeedback, setTrainingFeedback] = useState('')
  const [startingTraining, setStartingTraining] = useState(false)
  const controlsDisabled = false

  useEffect(() => {
    setForm(toFormState(settings?.learningBot))
  }, [settings?.learningBot])

  useEffect(() => {
    let ignore = false

    async function loadData() {
      const [summaryResult, datasetResult, statusResult] = await Promise.allSettled([
          getLearningBotSummary(),
          getLearningBotDataset(),
          getLearningBotTrainStatus(),
        ])

      if (ignore) {
        return
      }

      if (summaryResult.status === 'fulfilled') {
        setSummary(summaryResult.value)
      }

      if (datasetResult.status === 'fulfilled') {
        setDataset(datasetResult.value)
      }

      if (statusResult.status === 'fulfilled') {
        setTrainStatus(statusResult.value.status || null)
      }

      const firstError = [summaryResult, datasetResult, statusResult].find((result) => result.status === 'rejected')

      if (firstError && firstError.status === 'rejected') {
        setError(getLearningBotLoadErrorMessage(firstError.reason))
      } else {
        setError('')
      }
    }

    loadData()
    const timer = window.setInterval(loadData, 20_000)

    return () => {
      ignore = true
      window.clearInterval(timer)
    }
  }, [settings?.settingsRevision])

  async function handleSave() {
    setSaveFeedback('')
    const result = await onSave({
      learningBot: toPayload(form),
    })
    setSaveFeedback(result?.ok ? 'Learning Bot settings saved.' : result?.error || 'Unable to save settings.')
  }

  async function handleStartTraining() {
    setStartingTraining(true)
    setTrainingFeedback('')
    try {
      const payload = await startLearningBotTraining()
      setTrainingFeedback(payload.command ? `Training started: ${payload.command}` : 'Training started.')
      const statusPayload = await getLearningBotTrainStatus()
      setTrainStatus(statusPayload.status || null)
    } catch (trainError) {
      setTrainingFeedback(trainError instanceof Error ? trainError.message : 'Unable to start training.')
    } finally {
      setStartingTraining(false)
    }
  }

  async function handleRefreshStatus() {
    try {
      const statusPayload = await getLearningBotTrainStatus()
      setTrainStatus(statusPayload.status || null)
    } catch (statusError) {
      setTrainingFeedback(statusError instanceof Error ? statusError.message : 'Unable to refresh training status.')
    }
  }

  const overview = summary?.overview || {}
  const patterns = summary?.patterns || []
  const datasetPreview = summary?.datasetPreview || []
  const rows = dataset?.rows || []
  const metrics = trainStatus?.metrics || null
  const perBotAiStatuses = buildPerBotAiStatuses(trainStatus)
  const latestLearningUpdatedAt = getLatestLearningArtifactTimestamp(trainStatus)
  const latestTrainingRunAt = Number(trainStatus?.lastRunAt || 0) || null
  const currentDatasetRows = Number(trainStatus?.currentDatasetRows ?? rows.length ?? 0)
  const eligibleClosedTradeCount = Number(trainStatus?.eligibleClosedTradeCount ?? overview.eligibleClosedTradeCount ?? currentDatasetRows)
  const realMoneyTradeTarget = Number(trainStatus?.realMoneyTradeTarget ?? overview.realMoneyTradeTarget ?? 1000)
  const realMoneyTradesRemaining = Math.max(realMoneyTradeTarget - eligibleClosedTradeCount, 0)
  const realMoneyTradeReady = Boolean(trainStatus?.realMoneyTradeReady ?? overview.realMoneyTradeReady ?? eligibleClosedTradeCount >= realMoneyTradeTarget)
  const liveAiModeLabel = getAiGateModeLabel(form.aiEntryFilter)
  const liveAiPolicySummary = latestLearningUpdatedAt
    ? `${metrics?.framework || 'Model'} on ${metrics?.deviceUsed || 'n/a'} with ${metrics?.rows || 0} learned rows.`
    : 'No trained policy has been recorded yet.'
  const reviewWindowValue = Number(form.reviewWindowTrades || 0)
  const reviewWindowLabel = reviewWindowValue > 0 ? `${reviewWindowValue} trade` : 'all trades'
  const liveAiReviewWindow = `${reviewWindowLabel} review window • ${form.trainingScope === 'shared' ? 'shared policy' : 'per-bot policy'}`
  const trainingStatusLabel = trainStatus?.running
    ? 'Training now'
    : latestLearningUpdatedAt
      ? 'Model ready'
      : 'No AI update yet'
  const trainingStatusDetail = trainStatus?.running
    ? 'A fresh AI model is currently being trained on this server.'
    : latestLearningUpdatedAt
      ? `Last successful training finished ${formatLearningRelativeTime(latestLearningUpdatedAt)}.`
      : 'The page has not recorded a successful learned model update yet.'

  const trainingMain = (
    <div className="grid gap-6">
      <section className="rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.18),transparent_24%),rgba(15,23,42,0.9)] p-6 shadow-glow backdrop-blur-xl">
        <div className="inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-sky-100">
          <BrainCircuit className="h-4 w-4" />
          Real AI Learning Lane
        </div>
        <h1 className="mt-4 text-3xl font-semibold text-white">PyTorch training for the Learning Bot</h1>
        <p className="mt-4 max-w-4xl text-sm leading-7 text-slate-300">
          The policy is trained on two sources: every closed live/paper trade, and the historical
          <span className="text-white"> backtest runs flagged for training</span> on the Backtests tab.
          {form.aiTrainer.enabled
            ? ' This deployment retrains on-box after each new closed trade.'
            : ' Training is disabled on this deployment — the live filter applies the most recently uploaded policy (trained off-box on the workstation GPU). No training runs on this server.'}
        </p>
        <div className="mt-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-100">
          The trained artifact drives the live AI entry filter — per bot it scores each candidate against the
          historical expectancy of that setup family and can hard-block weak entries (see Live AI Gate below).
          Real-money trading stays locked until {realMoneyTradeTarget} reviewed trades.
        </div>
        <div className={`mt-4 rounded-2xl border px-4 py-4 text-sm ${form.aiTrainer.enabled ? 'border-sky-400/20 bg-sky-400/10 text-sky-100' : 'border-amber-400/20 bg-amber-400/10 text-amber-100'}`}>
          <div className="font-medium">
            {form.aiTrainer.enabled ? 'On-box training: ENABLED' : 'On-box training: DISABLED — policy trained locally and uploaded'}
          </div>
          <div className="mt-1 text-[13px] leading-6 opacity-90">
            Policy basis: <span className="font-semibold">{Number(metrics?.rows || 0).toLocaleString()} backtest/trade rows</span>
            {' • '}{metrics?.framework || 'model'} on {metrics?.deviceUsed || 'n/a'}
            {' • '}last built {latestLearningUpdatedAt ? formatLearningRelativeTime(latestLearningUpdatedAt) : 'never'}.
            {!form.aiTrainer.enabled && ' Re-enable aiTrainer in settings to let this server retrain; leave off to keep the uploaded policy frozen.'}
          </div>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Reviewed Trades" value={String(eligibleClosedTradeCount || 0)} detail={`${realMoneyTradesRemaining} until ${realMoneyTradeTarget} real-money signal`} />
          <Stat label="Dataset Rows" value={String(currentDatasetRows)} detail={reviewWindowValue > 0 ? `Training window ${currentDatasetRows} / ${reviewWindowValue} rows` : `Training on all ${currentDatasetRows} eligible trades`} />
          <Stat
            label="Real Money Gate"
            value={realMoneyTradeReady ? 'Ready' : `${eligibleClosedTradeCount} / ${realMoneyTradeTarget}`}
            detail={realMoneyTradeReady
              ? '1000-trade signal reached'
              : `${realMoneyTradesRemaining} more closed trades needed`}
          />
          <Stat
            label="AI Model Updated"
            value={formatLearningTimestamp(latestLearningUpdatedAt)}
            detail={latestLearningUpdatedAt
              ? `${formatLearningRelativeTime(latestLearningUpdatedAt)} • ${metrics?.rows || 0} rows • ${metrics?.framework || 'Model ready'}`
              : 'No successful learned model has been recorded yet'}
          />
          <Stat
            label="Latest Training Run"
            value={formatLearningTimestamp(latestTrainingRunAt)}
            detail={latestTrainingRunAt
              ? `Last training run started ${formatLearningRelativeTime(latestTrainingRunAt)}`
              : 'No training timestamp recorded yet'}
          />
          <Stat label="Training Status" value={trainingStatusLabel} detail={trainingStatusDetail} />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Panel title="Learning Controls" action={<Cpu className="h-4 w-4 text-sky-300" />}>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-white">Enable Learning Bot</span>
                <input disabled={controlsDisabled} type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} className="h-4 w-4 accent-sky-400 disabled:cursor-not-allowed" />
              </div>
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-white">Enable AI Trainer</span>
                <input disabled={controlsDisabled} type="checkbox" checked={form.aiTrainer.enabled} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, enabled: event.target.checked } }))} className="h-4 w-4 accent-sky-400 disabled:cursor-not-allowed" />
              </div>
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Focus Source</div>
              <select disabled={controlsDisabled} value={form.focusSource} onChange={(event) => setForm((current) => ({ ...current, focusSource: event.target.value }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60">
                <option value="auto">AUTO bot trades</option>
                <option value="all">All closed trades</option>
              </select>
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Training Scope</div>
              <select disabled={controlsDisabled} value={form.trainingScope} onChange={(event) => setForm((current) => ({ ...current, trainingScope: event.target.value }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60">
                <option value="per-bot">Per bot</option>
                <option value="shared">Shared across bots</option>
              </select>
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Focus Bot</div>
              <select disabled={controlsDisabled} value={form.focusSignalModelId} onChange={(event) => setForm((current) => ({ ...current, focusSignalModelId: event.target.value }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60">
                <option value="all">All bots</option>
                {Object.entries(BOT_LABELS).map(([modelId, label]) => (
                  <option key={modelId} value={modelId}>{label}</option>
                ))}
              </select>
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Review Window</div>
              <input disabled={controlsDisabled} type="number" min="0" max="100000" value={form.reviewWindowTrades} onChange={(event) => setForm((current) => ({ ...current, reviewWindowTrades: event.target.value }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
              <div className="mt-2 text-[11px] leading-relaxed text-slate-500">0 = no limit: train on every eligible closed trade. The AI retrains after each new closed trade.</div>
            </label>
          </div>
          <div className="mt-4">
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300 block">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Notes</div>
              <textarea disabled={controlsDisabled} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} rows={4} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" disabled={controlsDisabled} onClick={handleSave} className="rounded-2xl bg-sky-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">
              {saving ? 'Saving...' : 'Save Learning Settings'}
            </button>
            {saveFeedback ? <div className="text-sm text-slate-300">{saveFeedback}</div> : null}
          </div>
        </Panel>

        <Panel title="AI Trainer" action={<FlaskConical className="h-4 w-4 text-sky-300" />}>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Algorithm</div>
              <select disabled={controlsDisabled} value={form.aiTrainer.algorithm} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, algorithm: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60">
                <option value="dqn">DQN</option>
                <option value="ppo">PPO</option>
              </select>
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Device Preference</div>
              <select disabled={controlsDisabled} value={form.aiTrainer.devicePreference} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, devicePreference: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60">
                <option value="cuda">CUDA / GPU</option>
                <option value="cpu">CPU</option>
              </select>
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Runtime Command</div>
              <input disabled={controlsDisabled} type="text" value={form.aiTrainer.runtimeCommand} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, runtimeCommand: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Reward Mode</div>
              <select disabled={controlsDisabled} value={form.aiTrainer.rewardMode} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, rewardMode: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60">
                <option value="pnl-risk">PnL - risk + quality</option>
                <option value="pnl-only">PnL only</option>
              </select>
            </label>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Epochs</div>
              <input disabled={controlsDisabled} type="number" min="1" max="500" value={form.aiTrainer.epochs} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, epochs: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Batch Size</div>
              <input disabled={controlsDisabled} type="number" min="8" max="2048" value={form.aiTrainer.batchSize} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, batchSize: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Learning Rate</div>
              <input disabled={controlsDisabled} type="number" min="0.000001" step="0.0001" value={form.aiTrainer.learningRate} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, learningRate: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
            </label>
            <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">State Window</div>
              <input disabled={controlsDisabled} type="number" min="4" max="256" value={form.aiTrainer.stateWindow} onChange={(event) => setForm((current) => ({ ...current, aiTrainer: { ...current.aiTrainer, stateWindow: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" disabled={startingTraining || controlsDisabled} onClick={handleStartTraining} className="rounded-2xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">
              {startingTraining ? 'Starting...' : 'Start AI Training'}
            </button>
            <button type="button" onClick={handleRefreshStatus} className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-white/20">
              Refresh Status
            </button>
          </div>
          {trainingFeedback ? <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">{trainingFeedback}</div> : null}
          {trainStatus ? (
            <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
              <div>Last started: {formatLearningTimestamp(trainStatus.lastRunAt)}</div>
              <div>Last completed: {formatLearningTimestamp(trainStatus.lastCompletedAt)}</div>
              <div>Model last updated: {formatLearningTimestamp(latestLearningUpdatedAt)}</div>
              <div>Last dataset trained: {formatLearningTimestamp(latestLearningUpdatedAt)}</div>
              <div>Exit code: {trainStatus.lastExitCode == null ? 'N/A' : trainStatus.lastExitCode}</div>
              <div>Last error: {trainStatus.lastError || 'None'}</div>
              <div>Framework: {metrics?.framework || 'Pending'}</div>
              <div>Device: {metrics?.deviceUsed || 'n/a'}</div>
              <div>Rows learned: {metrics?.rows ?? 'Pending'}</div>
              {metrics?.fallbackReason ? <div>Fallback reason: {metrics.fallbackReason}</div> : null}
              {metrics?.note ? <div>Trainer note: {metrics.note}</div> : null}
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel title="Live AI Gate" action={<BrainCircuit className="h-4 w-4 text-sky-300" />}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Gate Mode"
            value={liveAiModeLabel}
            detail={form.aiEntryFilter.enabled
              ? (form.aiEntryFilter.paperOnly
                ? 'AI scores candidates live, but only logs paper warnings instead of blocking exchange-routed entries.'
                : 'AI scores candidates live and can hard-block weak entries before execution.')
              : 'The bots are trading without AI entry gating right now.'}
          />
          <Stat
            label="Global Threshold"
            value={`${Number(form.aiEntryFilter.thresholdScore || 0)}/100`}
            detail="Candidates below this score are treated as weak by the global AI gate."
          />
          <Stat
            label="Policy Runtime"
            value={latestLearningUpdatedAt ? 'Ready' : 'Collecting'}
            detail={liveAiPolicySummary}
          />
          <Stat
            label="Review Scope"
            value={form.focusSignalModelId === 'all' ? 'All bots' : BOT_LABELS[form.focusSignalModelId] || 'Custom'}
            detail={liveAiReviewWindow}
          />
        </div>
      </Panel>

      <Panel title="AI Entry Filter" action={<BrainCircuit className="h-4 w-4 text-sky-300" />}>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-white">Enable AI Filter</span>
              <input disabled={controlsDisabled} type="checkbox" checked={form.aiEntryFilter.enabled} onChange={(event) => setForm((current) => ({ ...current, aiEntryFilter: { ...current.aiEntryFilter, enabled: event.target.checked } }))} className="h-4 w-4 accent-sky-400 disabled:cursor-not-allowed" />
            </div>
            <div className="mt-2 text-slate-400">Uses the trained artifact to score candidate trades before entry.</div>
          </label>
          <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-white">Paper Only</span>
              <input disabled={controlsDisabled} type="checkbox" checked={form.aiEntryFilter.paperOnly} onChange={(event) => setForm((current) => ({ ...current, aiEntryFilter: { ...current.aiEntryFilter, paperOnly: event.target.checked } }))} className="h-4 w-4 accent-sky-400 disabled:cursor-not-allowed" />
            </div>
            <div className="mt-2 text-slate-400">When on, Binance-routed trades only log the AI decision and do not get blocked.</div>
          </label>
          <label className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Threshold Score</div>
            <input disabled={controlsDisabled} type="number" min="0" max="100" value={form.aiEntryFilter.thresholdScore} onChange={(event) => setForm((current) => ({ ...current, aiEntryFilter: { ...current.aiEntryFilter, thresholdScore: event.target.value } }))} className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60" />
            <div className="mt-2 text-slate-400">Candidates scoring below this level are skipped in paper mode.</div>
          </label>
        </div>
      </Panel>

      <Panel title="Architecture" action={<GitBranch className="h-4 w-4 text-sky-300" />}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5 text-sm text-slate-300">Live closed trades plus flagged backtest runs become one AI dataset with state, reward, and setup-family labels.</div>
          <div className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5 text-sm text-slate-300">PyTorch training stays separate from live bot execution and saves its own status/artifacts.</div>
          <div className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5 text-sm text-slate-300">The trained policy runs live as the AI entry filter — scoring candidates and, per bot, hard-blocking weak setups.</div>
        </div>
      </Panel>

      <Panel title="Per-Bot AI Status" action={<BrainCircuit className="h-4 w-4 text-sky-300" />}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {perBotAiStatuses.map((item) => (
            <article key={item.modelId} className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-lg font-semibold text-white">{item.label}</div>
                <span className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                  item.ready
                    ? 'bg-emerald-400/12 text-emerald-200'
                    : 'bg-slate-800 text-slate-300'
                }`}>
                  {item.ready ? 'AI Ready' : 'Collecting'}
                </span>
              </div>
              <div className="mt-4 space-y-2 text-sm text-slate-300">
                <div>Samples: {item.sampleCount}</div>
                <div>Avg reward: {item.avgReward.toFixed(2)}</div>
                <div>Avg win rate: {item.avgWinRate.toFixed(1)}%</div>
                <div>Top setup family: {item.topFamily}</div>
                <div>Gate mode: {getAiGateModeLabel(form.perBotOverrides[item.modelId])}</div>
                <div>Threshold: {Number(form.perBotOverrides[item.modelId]?.thresholdScore || 0)}/100</div>
              </div>
            </article>
          ))}
        </div>
        <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
          Base bot settings should stay for now. The AI currently acts as a scoring and filtering layer on top of each bot, not a full replacement for position sizing, risk, or execution rules.
        </div>
      </Panel>

      <Panel title="Per-Bot AI Overrides" action={<Cpu className="h-4 w-4 text-sky-300" />}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Object.entries(BOT_LABELS).map(([modelId, label]) => {
            const override = form.perBotOverrides[modelId]

            return (
              <article key={modelId} className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5">
                <div className="text-lg font-semibold text-white">{label}</div>
                <div className="mt-4 space-y-4">
                  <label className="block text-sm text-slate-300">
                    <div className="flex items-center justify-between gap-3">
                      <span>AI enabled</span>
                      <input
                        disabled={controlsDisabled}
                        type="checkbox"
                        checked={override.enabled}
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          perBotOverrides: {
                            ...current.perBotOverrides,
                            [modelId]: {
                              ...current.perBotOverrides[modelId],
                              enabled: event.target.checked,
                            },
                          },
                        }))}
                        className="h-4 w-4 accent-sky-400 disabled:cursor-not-allowed"
                      />
                    </div>
                  </label>
                  <label className="block text-sm text-slate-300">
                    <div className="flex items-center justify-between gap-3">
                      <span>Paper-only mode</span>
                      <input
                        disabled={controlsDisabled}
                        type="checkbox"
                        checked={override.paperOnly}
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          perBotOverrides: {
                            ...current.perBotOverrides,
                            [modelId]: {
                              ...current.perBotOverrides[modelId],
                              paperOnly: event.target.checked,
                            },
                          },
                        }))}
                        className="h-4 w-4 accent-sky-400 disabled:cursor-not-allowed"
                      />
                    </div>
                  </label>
                  <label className="block text-sm text-slate-300">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Threshold score</div>
                    <input
                      disabled={controlsDisabled}
                      type="number"
                      min="0"
                      max="100"
                      value={override.thresholdScore}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        perBotOverrides: {
                          ...current.perBotOverrides,
                          [modelId]: {
                            ...current.perBotOverrides[modelId],
                            thresholdScore: event.target.value,
                          },
                        },
                      }))}
                      className="mt-3 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                </div>
              </article>
            )
          })}
        </div>
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
        <Panel title="Pattern Review" action={<BrainCircuit className="h-4 w-4 text-sky-300" />}>
          <div className="space-y-3">
            {patterns.map((pattern) => (
              <div key={pattern.key} className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
                <div className="font-semibold text-white">{pattern.setupFamily}</div>
                <div className="mt-1">{pattern.trades} trades | {pattern.winRate.toFixed(1)}% win rate | {formatSignedUsdt(pattern.totalPnl)}</div>
                <div className="mt-2">{pattern.recommendation}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Learning Loop" action={<Scale className="h-4 w-4 text-sky-300" />}>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">1. Merge live closed trades + flagged backtest runs into one structured AI dataset.</div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">2. Retrain the PyTorch policy (reward = pnl − risk + entry quality) after each new closed trade.</div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">3. The policy scores live entries; per-bot gates hard-block families with losing historical expectancy.</div>
          </div>
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <Panel title="Dataset Preview" action={<Database className="h-4 w-4 text-sky-300" />}>
          <div className="space-y-3">
            {datasetPreview.map((item) => (
              <div key={item.id} className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
                <div className="font-semibold text-white">{item.symbol} {item.side}</div>
                <div className="mt-1">{item.setupFamily} | quality {item.entryQualityScore}/100 | {formatSignedUsdt(item.pnl)}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Roadmap" action={<FlaskConical className="h-4 w-4 text-sky-300" />}>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">Now: iterate signals, backtest each, feed the good runs into training.</div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">Next: a setup family clears the "works" bar in Signal Insights on both live and backtest data.</div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">Then: {realMoneyTradeTarget} reviewed trades reached → real-money gate opens for review.</div>
          </div>
        </Panel>
      </div>

      {error ? <div className="rounded-3xl border border-rose-400/20 bg-rose-400/10 px-5 py-4 text-sm text-rose-200">{error}</div> : null}
    </div>
  )

  return (
    <div className="grid gap-6">
      <AITrainingTabs />
      <Routes>
        <Route index element={trainingMain} />
        <Route path="backtests" element={<BacktestHistoryPanel />} />
        <Route path="insights" element={<SignalInsightsPanel />} />
        <Route path="advisory" element={<AIAdvisoryPanel analysis={analysis} />} />
        <Route
          path="assistant"
          element={(
            <AIAssistantSidebar
              analysis={analysis}
              activeSignalModelId={activeSignalModelId}
              activeModelRiskSummary={activeModelRiskSummary}
              modelChecklistAnalysis={modelChecklistAnalysis}
            />
          )}
        />
        <Route path="*" element={<Navigate to="/ai-training" replace />} />
      </Routes>
    </div>
  )
}
