import { Activity, BarChart3, Bot, CandlestickChart, ChevronDown, CircleHelp, Clock3, ShieldAlert, Target, WalletCards } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import {
  getStrategyDerivedMaxLossPerTrade,
  getStrategyDerivedTakeProfitPerTrade,
  getStrategyPositionNotional,
  summarizeAccount,
} from '../lib/accountMetrics'
import { getMarginModeLabel, MARGIN_MODE_OPTIONS } from '../lib/marginModes'
import {
  applyTradeStylePreset,
  getTradeStylePreset,
  MANUAL_TRADE_STYLE_PRESET_ID,
  resolveTradeStylePresetId,
  TRADE_STYLE_PRESET_SETTING_KEYS,
  TRADE_STYLE_PRESETS,
} from '../lib/strategyPresets'
import {
  BOT3_RISK_PRESETS,
  getEffectiveSignalModelStrategy,
  getBot3RiskPreset,
  getSignalModel,
  normalizeSignalModelStrategies,
  resolveBot3RiskPresetId,
  SIGNAL_MODELS,
} from '../lib/signalModels'
import { VOLATILE_MARKET_SYMBOL_LIMIT } from '../lib/tradingConfig'
import { formatAutoTradeSessionRange } from '../lib/tradingSessions'
import { usePersistentBoolean } from '../lib/usePersistentBoolean'
import { getWalletEffectiveStartingBalance, normalizeWallets } from '../lib/wallets'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { PageHeader } from './ui/PageHeader'

const SETTINGS_TABS = [
  { to: '/settings/automation', label: 'Automation' },
  { to: '/settings/strategy', label: 'Bot Strategy' },
  { to: '/settings/credentials', label: 'API Credentials' },
]

function SettingsTabs() {
  return (
    <nav className="flex flex-wrap gap-2 border-b border-white/10 pb-4">
      {SETTINGS_TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
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

const STRATEGY_FIELD_META = {
  preferredSymbols: {
    label: 'Preferred Symbols',
    description: `Auto-managed top ${VOLATILE_MARKET_SYMBOL_LIMIT} symbols ranked by Score = Volume x Volatility, so the system prefers pairs that are liquid, moving, and tradable.`,
    Icon: CandlestickChart,
  },
  autoTradingEnabled: {
    label: 'Enable automatic daily trade',
    description: 'Turns the automatic trader on or off entirely across the configured wallets.',
    Icon: Bot,
  },
  sessionScheduleEnabled: {
    label: 'Trading session schedule',
    description: 'When enabled, scheduled auto trades are allowed only during the saved Manila session windows.',
    Icon: Clock3,
  },
  marginPerTrade: {
    label: 'Margin Per Trade',
    description: 'Base USDT margin reserved for each new position before leverage is applied.',
    Icon: WalletCards,
  },
  leverage: {
    label: 'Leverage',
    description: 'Multiplier applied to margin to determine the total notional size of each position.',
    Icon: Activity,
  },
  maxOpenPositions: {
    label: 'Max Open Positions',
    description: 'Per-wallet ceiling. Each wallet still has to fund the slot from its own balance.',
    Icon: BarChart3,
  },
  marginMode: {
    label: 'Margin Mode',
    description: 'Controls whether new Binance Futures validations use isolated margin per symbol or crossed margin shared across the wallet.',
    Icon: WalletCards,
  },
  stopLossPercent: {
    label: 'Stop Loss %',
    description: 'Price distance from entry. Max loss per trade is derived automatically from margin x leverage x stop-loss percent.',
    Icon: ShieldAlert,
  },
  takeProfitPercent: {
    label: 'Take Profit %',
    description: 'Profit target distance from entry in percent where winning trades are closed.',
    Icon: Target,
  },
  maxTradesPerDay: {
    label: 'Max Trades Per Day',
    description: 'Maximum number of auto trades a single wallet is allowed to open in one Manila trading day.',
    Icon: Clock3,
  },
  maxLossesPerDay: {
    label: 'Max Losing Trades / Day',
    description: 'Count limit. Stops a wallet from opening new auto trades after this many losing closed trades are recorded in one Manila day.',
    Icon: BarChart3,
  },
  maxLossPerDay: {
    label: 'Max Daily Loss (USDT)',
    description: 'Money limit in USDT. Stops new auto trades once this wallet-level daily loss budget is consumed.',
    Icon: WalletCards,
  },
  dailyProfitTarget: {
    label: 'Daily Profit Target',
    description: 'Once realized profit reaches this USDT target, the wallet stops opening new trades for the day.',
    Icon: Target,
  },
}

const NUMERIC_STRATEGY_FIELD_KEYS = [
  'marginPerTrade',
  'leverage',
  'maxOpenPositions',
  'stopLossPercent',
  'takeProfitPercent',
  'maxTradesPerDay',
  'maxLossesPerDay',
  'maxLossPerDay',
  'dailyProfitTarget',
]

const USDT_FIELD_KEYS = new Set(['marginPerTrade', 'maxLossPerDay', 'dailyProfitTarget'])
const PERCENT_FIELD_KEYS = new Set(['stopLossPercent', 'takeProfitPercent'])
const COUNT_FIELD_KEYS = new Set(['maxOpenPositions', 'maxTradesPerDay', 'maxLossesPerDay'])
const TRADE_STYLE_PRESET_SETTING_KEY_SET = new Set(TRADE_STYLE_PRESET_SETTING_KEYS)

function formatUsdt(value, withSign = false) {
  const number = Number(value || 0)
  const sign = withSign && number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function formatFieldValue(fieldKey, value) {
  if (fieldKey === 'marginMode') {
    return getMarginModeLabel(value)
  }

  if (USDT_FIELD_KEYS.has(fieldKey)) {
    return formatUsdt(value)
  }

  if (PERCENT_FIELD_KEYS.has(fieldKey)) {
    return `${Number(value || 0).toFixed(2)}%`
  }

  if (fieldKey === 'leverage') {
    return `${Number(value || 0)}x`
  }

  return `${Number(value || 0)}`
}

function getFieldStep(fieldKey) {
  if (COUNT_FIELD_KEYS.has(fieldKey) || fieldKey === 'leverage') {
    return 1
  }

  return 0.01
}

function getBotStrategyTone(modelId) {
  if (modelId === 'model-2') {
    return {
      frame: 'border-emerald-400/20 bg-emerald-400/[0.06]',
      badge: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
      kicker: 'text-emerald-200/75',
      button: 'border-emerald-300/20 bg-slate-950/35 text-emerald-100 hover:border-emerald-300/40 hover:bg-slate-950/50',
      accent: 'text-emerald-300',
    }
  }

  if (modelId === 'model-3') {
    return {
      frame: 'border-amber-400/20 bg-amber-400/[0.06]',
      badge: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      kicker: 'text-amber-200/75',
      button: 'border-amber-300/20 bg-slate-950/35 text-amber-100 hover:border-amber-300/40 hover:bg-slate-950/50',
      accent: 'text-amber-300',
    }
  }

  if (modelId === 'model-4') {
    return {
      frame: 'border-rose-400/20 bg-rose-400/[0.06]',
      badge: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      kicker: 'text-rose-200/75',
      button: 'border-rose-300/20 bg-slate-950/35 text-rose-100 hover:border-rose-300/40 hover:bg-slate-950/50',
      accent: 'text-rose-300',
    }
  }

  return {
    frame: 'border-sky-400/20 bg-sky-400/[0.06]',
    badge: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    kicker: 'text-sky-200/75',
    button: 'border-sky-300/20 bg-slate-950/35 text-sky-100 hover:border-sky-300/40 hover:bg-slate-950/50',
    accent: 'text-sky-300',
  }
}

function areSettingsValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function getCredentialState(settings, key) {
  return settings?.credentials?.[key] || {
    present: Boolean(settings?.[key]),
    length: typeof settings?.[key] === 'string' ? settings[key].length : 0,
    fingerprint: null,
  }
}

function buildSettingsFormState(settings = {}) {
  return {
    ...settings,
    apiKey: '',
    secretKey: '',
    liveApiKey: '',
    liveSecretKey: '',
  }
}

function buildSettingsPatch(currentSettings, nextSettings) {
  const patch = {}
  const currentStrategy = currentSettings?.strategy || {}
  const nextStrategy = nextSettings?.strategy || {}

  if (typeof nextSettings.apiKey === 'string' && nextSettings.apiKey.trim()) {
    patch.apiKey = nextSettings.apiKey
  }

  if (typeof nextSettings.secretKey === 'string' && nextSettings.secretKey.trim()) {
    patch.secretKey = nextSettings.secretKey
  }

  if (typeof nextSettings.liveApiKey === 'string' && nextSettings.liveApiKey.trim()) {
    patch.liveApiKey = nextSettings.liveApiKey
  }

  if (typeof nextSettings.liveSecretKey === 'string' && nextSettings.liveSecretKey.trim()) {
    patch.liveSecretKey = nextSettings.liveSecretKey
  }

  const strategyPatch = {}

  for (const [key, value] of Object.entries(nextStrategy)) {
    if (key === 'signalModelStrategies') {
      const currentSignalModelStrategies = normalizeSignalModelStrategies(
        currentStrategy.signalModelStrategies,
        currentStrategy,
      )
      const nextSignalModelStrategies = normalizeSignalModelStrategies(value, nextStrategy)
      const changedSignalModelStrategies = Object.fromEntries(
        Object.entries(nextSignalModelStrategies).filter(([modelId, strategyValue]) => (
          !areSettingsValuesEqual(strategyValue, currentSignalModelStrategies[modelId])
        )),
      )

      if (Object.keys(changedSignalModelStrategies).length > 0) {
        strategyPatch.signalModelStrategies = changedSignalModelStrategies
      }

      continue
    }

    if (!areSettingsValuesEqual(value, currentStrategy[key])) {
      strategyPatch[key] = value
    }
  }

  if (Object.keys(strategyPatch).length > 0) {
    patch.strategy = strategyPatch
  }

  return patch
}

function getResolvedTradeStylePreset(strategy = {}) {
  return getTradeStylePreset(resolveTradeStylePresetId(strategy, strategy?.tradeStylePresetId))
}

function InfoPopover({ content, align = 'right', buttonClassName = '' }) {
  const alignClassName = align === 'left' ? 'left-0' : 'right-0'

  return (
    <span className="group relative inline-flex items-center">
      <span
        tabIndex={0}
        aria-label="Show instruction"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        className={`flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-slate-400 transition hover:border-sky-400/30 hover:text-sky-200 focus:border-sky-400/30 focus:text-sky-200 focus:outline-none ${buttonClassName}`}
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </span>
      <span className={`pointer-events-none absolute ${alignClassName} top-full z-10 mt-2 w-72 rounded-2xl border border-sky-400/20 bg-slate-950/95 px-3 py-2 text-[11px] leading-relaxed text-slate-200 opacity-0 shadow-2xl transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100`}>
        {content}
      </span>
    </span>
  )
}

function StrategyFieldLabel({ fieldKey }) {
  const meta = STRATEGY_FIELD_META[fieldKey]
  const { Icon, label, description } = meta

  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-400/20 bg-sky-400/10 text-sky-200">
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-xs uppercase tracking-[0.24em] text-slate-500">{label}</span>
      <span className="ml-auto">
        <InfoPopover content={description} />
      </span>
    </div>
  )
}

function MetricChip({ label, value, tone = 'text-white' }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  )
}

function DerivedAmountField({ label, value }) {
  return (
    <div className="block">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</span>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-300">
          USDT
        </span>
      </div>
      <input
        type="text"
        value={value}
        readOnly
        tabIndex={-1}
        className="w-full rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm font-semibold text-slate-100 outline-none"
      />
    </div>
  )
}

function EditableField({
  fieldKey,
  value,
  onChange,
  helperText = null,
  derivedAmountLabel = null,
  derivedAmountValue = null,
}) {
  return (
    <div className="block">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{STRATEGY_FIELD_META[fieldKey].label}</span>
        <InfoPopover content={STRATEGY_FIELD_META[fieldKey].description} align="left" />
      </div>
      <div className={derivedAmountLabel ? 'grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]' : 'block'}>
        <input
          type="number"
          step={getFieldStep(fieldKey)}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
        />
        {derivedAmountLabel ? (
          <DerivedAmountField label={derivedAmountLabel} value={derivedAmountValue} />
        ) : null}
      </div>
      {helperText ? <div className="mt-2 text-xs leading-relaxed text-slate-400">{helperText}</div> : null}
    </div>
  )
}

function ReadonlyField({
  fieldKey,
  value,
  helperText = null,
  derivedAmountLabel = null,
  derivedAmountValue = null,
}) {
  return (
    <div className="block">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{STRATEGY_FIELD_META[fieldKey].label}</span>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-300">
          Live
        </span>
      </div>
      <div className={derivedAmountLabel ? 'grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]' : 'block'}>
        <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm font-semibold text-white">
          {formatFieldValue(fieldKey, value)}
        </div>
        {derivedAmountLabel ? (
          <DerivedAmountField label={derivedAmountLabel} value={derivedAmountValue} />
        ) : null}
      </div>
      {helperText ? <div className="mt-2 text-xs leading-relaxed text-slate-400">{helperText}</div> : null}
    </div>
  )
}

function MarginModeControl({ value, editable, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {MARGIN_MODE_OPTIONS.map((option) => {
        const isActive = value === option.value

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange?.(option.value)}
            disabled={!editable}
            className={`rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
              isActive
                ? 'border-sky-300/40 bg-sky-400/10 text-sky-100'
                : 'border-white/10 bg-white/[0.03] text-slate-300'
            } ${editable ? 'hover:border-sky-300/20 hover:bg-white/[0.05]' : 'cursor-default opacity-85'}`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function StrategyCard({
  model,
  wallet,
  editableStrategy,
  effectiveStrategy,
  accountSnapshot,
  onUpdateStrategy,
  onApplyPreset,
  onApplyBot3Preset,
}) {
  const tone = getBotStrategyTone(model.id)
  const isBot3 = model.id === 'model-3'
  const isBot4 = model.id === 'model-4'
  const isEditable = !isBot3 && !isBot4
  const strategyForDisplay = isEditable ? editableStrategy : effectiveStrategy
  const activeTradePreset = getResolvedTradeStylePreset(strategyForDisplay)
  const activeBot3Preset = isBot3 ? getBot3RiskPreset(effectiveStrategy.bot3RiskPresetId) : null
  const activePresetLabel = isBot3
    ? `${activeBot3Preset.name} Preset`
    : isBot4
      ? 'Live Rules'
    : `${activeTradePreset.name} Preset`
  const derivedMaxLossPerTrade = Number(
    effectiveStrategy.maxLossPerTrade ?? getStrategyDerivedMaxLossPerTrade(effectiveStrategy),
  )
  const positionNotional = getStrategyPositionNotional(effectiveStrategy)
  const displayStopLossAmount = getStrategyDerivedMaxLossPerTrade(strategyForDisplay)
  const displayTakeProfitAmount = getStrategyDerivedTakeProfitPerTrade(strategyForDisplay)
  const stopLossHelper = isEditable
    ? `At ${strategyForDisplay.leverage}x leverage with ${formatUsdt(strategyForDisplay.marginPerTrade)} margin, this stop equals ${formatUsdt(getStrategyDerivedMaxLossPerTrade(strategyForDisplay))} max loss per trade.`
    : `Live max loss per trade is currently ${formatUsdt(derivedMaxLossPerTrade)}.`

  return (
    <div className={`rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.18)] ${tone.frame}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-[11px] uppercase tracking-[0.24em] ${tone.kicker}`}>{model.name}</div>
          <div className="mt-1 text-lg font-semibold text-white">{model.tag}</div>
          <div className="mt-2 text-sm leading-relaxed text-slate-300">{model.description}</div>
        </div>
        <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
          isEditable ? 'border-white/10 bg-white/[0.04] text-slate-100' : tone.badge
        }`}>
          {activePresetLabel}
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricChip label="Wallet" value={wallet?.name || 'Unassigned'} tone={tone.accent} />
        <MetricChip
          label="Running Balance"
          value={wallet ? formatUsdt(accountSnapshot.runningBalance) : 'No wallet'}
          tone="text-slate-100"
        />
        <MetricChip label="Position Notional" value={formatUsdt(positionNotional)} tone="text-slate-100" />
        <MetricChip label="Max Loss / Trade" value={formatUsdt(derivedMaxLossPerTrade)} tone="text-rose-200" />
      </div>

      <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
        {isEditable ? (
          <div>
            <div className="text-sm leading-relaxed text-slate-200">
              This preset applies to {model.name} only. Editing the preset-managed risk fields below will switch this card back to Manual unless the values still match a saved preset.
            </div>
          </div>
        ) : isBot3 ? (
          <div>
            <div className="text-sm leading-relaxed text-slate-200">
              {effectiveStrategy.riskProfile?.summary || 'This bot is automatic and read-only.'}
            </div>
            <div className="mt-2 text-xs leading-relaxed text-slate-400">
              The preset below changes Bot 3&apos;s balance-based risk sizing only. Entries and exits still come from the live trend pullback and retest engine.
            </div>
          </div>
        ) : (
          <div>
            <div className="text-sm leading-relaxed text-slate-200">
              This bot is automatic and read-only.
            </div>
            <div className="mt-2 text-xs leading-relaxed text-slate-400">
              Bot 4 runs a simple 15M EMA20/EMA50 + 5M RSI14 directional bias across the full preferred-symbols universe, then the AI entry score alone decides each entry (hard block). Until it has a self-trained policy it runs in bootstrap mode and takes every biased setup so the AI can learn from the results. Fixed 10 USDT margin at 50x, a hard -1 USDT loss cut per trade with the take-profit left to run, capped at 40 trades per day.
            </div>
          </div>
        )}
      </div>

      {isEditable || isBot3 ? (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
              {isBot3 ? 'Bot 3 Profit Preset' : 'Trade Style Preset'}
            </span>
            <InfoPopover
              content={isBot3
                ? 'Changes Bot 3 risk sizing only. Entry logic remains automatic.'
                : 'Applies the selected preset to this bot only.'}
              align="left"
            />
          </div>
          <select
            value={isBot3 ? activeBot3Preset.id : activeTradePreset.id}
            onChange={(event) => {
              if (isBot3) {
                onApplyBot3Preset(event.target.value)
                return
              }

              onApplyPreset(model.id, event.target.value)
            }}
            className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
          >
            {(isBot3 ? BOT3_RISK_PRESETS : TRADE_STYLE_PRESETS).map((preset) => (
              <option key={`${model.id}-${preset.id}`} value={preset.id}>
                {preset.name} - {preset.tag}
              </option>
            ))}
          </select>
          <div className="mt-2 text-xs leading-relaxed text-slate-400">
            {isBot3 ? activeBot3Preset.description : activeTradePreset.description}
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Margin Mode</span>
          {isEditable ? <InfoPopover content={STRATEGY_FIELD_META.marginMode.description} align="left" /> : null}
        </div>
        <MarginModeControl
          value={strategyForDisplay.marginMode}
          editable={isEditable}
          onChange={(nextValue) => onUpdateStrategy?.(model.id, 'marginMode', nextValue)}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {NUMERIC_STRATEGY_FIELD_KEYS.map((fieldKey) => {
          const hasDerivedAmount = fieldKey === 'stopLossPercent' || fieldKey === 'takeProfitPercent'
          const derivedAmountLabel = fieldKey === 'stopLossPercent'
            ? 'Loss @ Stop'
            : fieldKey === 'takeProfitPercent'
              ? 'Profit @ TP'
              : null
          const derivedAmountValue = fieldKey === 'stopLossPercent'
            ? formatUsdt(displayStopLossAmount)
            : fieldKey === 'takeProfitPercent'
              ? formatUsdt(displayTakeProfitAmount)
              : null

          return (
            <div key={`${model.id}-${fieldKey}`} className={hasDerivedAmount ? 'lg:col-span-2' : ''}>
              {isEditable ? (
                <EditableField
                  fieldKey={fieldKey}
                  value={strategyForDisplay[fieldKey]}
                  onChange={(nextValue) => onUpdateStrategy(model.id, fieldKey, nextValue)}
                  helperText={fieldKey === 'stopLossPercent' ? stopLossHelper : null}
                  derivedAmountLabel={derivedAmountLabel}
                  derivedAmountValue={derivedAmountValue}
                />
              ) : (
                <ReadonlyField
                  fieldKey={fieldKey}
                  value={effectiveStrategy[fieldKey]}
                  helperText={fieldKey === 'stopLossPercent' ? stopLossHelper : null}
                  derivedAmountLabel={derivedAmountLabel}
                  derivedAmountValue={derivedAmountValue}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ToggleCard({
  title,
  description,
  enabled,
  enabledLabel,
  disabledLabel,
  onToggle,
  disabled = false,
  children = null,
}) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-slate-950/65 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{title}</div>
          <div className="mt-2 text-sm leading-relaxed text-slate-300">{description}</div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
            enabled
              ? 'bg-emerald-400/15 text-emerald-100 ring-1 ring-emerald-400/30'
              : 'bg-white/[0.04] text-slate-200 ring-1 ring-white/10 hover:bg-white/[0.06]'
          } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          {enabled ? enabledLabel : disabledLabel}
        </button>
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  )
}

export function SettingsPage({
  settings,
  tradeHistory = [],
  livePrices = {},
  onSave,
  saving,
  aiTrainingStatus = { running: false },
  ready = true,
}) {
  const [form, setForm] = useState(() => buildSettingsFormState(settings))
  const [showPreferredSymbols, setShowPreferredSymbols] = usePersistentBoolean('settings:preferred-symbols:expanded', false)
  const [comparisonModelId, setComparisonModelId] = useState(
    () => getSignalModel(settings?.strategy?.activeSignalModelId).id,
  )
  const controlsDisabled = saving || !ready || Boolean(aiTrainingStatus?.running)

  useEffect(() => {
    setForm(buildSettingsFormState(settings))
  }, [settings])

  const wallets = useMemo(
    () => normalizeWallets(form.wallets),
    [form.wallets],
  )
  const signalModelStrategies = useMemo(
    () => normalizeSignalModelStrategies(form.strategy.signalModelStrategies, form.strategy),
    [form.strategy],
  )

  const comparisonModels = useMemo(() => (
    SIGNAL_MODELS.map((signalModel) => {
      const modelId = signalModel.id
      const model = getSignalModel(modelId)
      const wallet = wallets.find((item) => item.assignedSignalModelId === modelId) || null
      const walletTrades = wallet
        ? tradeHistory.filter((trade) => trade.walletId === wallet.id)
        : tradeHistory.filter((trade) => trade.signalModelId === modelId)
      const startingBalance = wallet ? getWalletEffectiveStartingBalance(wallet) : 0
      const baseAccountSnapshot = summarizeAccount({
        trades: walletTrades,
        livePrices,
        strategy: form.strategy,
        startingBalance,
      })
      const effectiveStrategy = getEffectiveSignalModelStrategy(form.strategy, modelId, {
        runningBalance: wallet ? baseAccountSnapshot.runningBalance : null,
      })
      const accountSnapshot = summarizeAccount({
        trades: walletTrades,
        livePrices,
        strategy: effectiveStrategy,
        startingBalance,
      })

      return {
        model,
        wallet,
        editableStrategy: modelId === 'model-3' || modelId === 'model-4' ? null : signalModelStrategies[modelId],
        effectiveStrategy,
        accountSnapshot,
      }
    })
  ), [form.strategy, livePrices, signalModelStrategies, tradeHistory, wallets])

  const selectedComparison = comparisonModels.find((item) => item.model.id === comparisonModelId)
    || comparisonModels[0]

  function getPreparedSettings(nextForm) {
    const nextSignalModelStrategies = normalizeSignalModelStrategies(
      nextForm.strategy.signalModelStrategies,
      nextForm.strategy,
    )
    const nextStrategy = {
      ...nextForm.strategy,
      signalModelStrategies: nextSignalModelStrategies,
    }

    return {
      ...nextForm,
      strategy: {
        ...nextStrategy,
        maxLossPerTrade: getStrategyDerivedMaxLossPerTrade(nextStrategy),
      },
    }
  }

  async function persistStrategyToggle(key) {
    if (controlsDisabled) {
      return
    }

    const nextForm = {
      ...form,
      strategy: {
        ...form.strategy,
        [key]: !form.strategy[key],
      },
    }
    const preparedSettings = getPreparedSettings(nextForm)

    setForm(preparedSettings)
    const patch = buildSettingsPatch(settings, preparedSettings)
    const result = Object.keys(patch).length > 0
      ? await onSave(patch)
      : { ok: true }

    if (!result?.ok) {
      setForm(settings)
    }
  }

  function updateSignalModelStrategy(modelId, key, value) {
    setForm((current) => {
      const currentSignalModelStrategies = normalizeSignalModelStrategies(current.strategy.signalModelStrategies, current.strategy)
      const nextModelStrategy = {
        ...currentSignalModelStrategies[modelId],
        [key]: value,
      }

      if (TRADE_STYLE_PRESET_SETTING_KEY_SET.has(key)) {
        nextModelStrategy.tradeStylePresetId = resolveTradeStylePresetId(nextModelStrategy, MANUAL_TRADE_STYLE_PRESET_ID)
      }

      const nextSignalModelStrategies = normalizeSignalModelStrategies({
        ...currentSignalModelStrategies,
        [modelId]: nextModelStrategy,
      }, current.strategy)

      return {
        ...current,
        strategy: {
          ...current.strategy,
          signalModelStrategies: nextSignalModelStrategies,
        },
      }
    })
  }

  function applySignalModelTradeStylePreset(modelId, presetId) {
    setForm((current) => {
      const currentSignalModelStrategies = normalizeSignalModelStrategies(current.strategy.signalModelStrategies, current.strategy)
      const nextStrategy = applyTradeStylePreset(currentSignalModelStrategies[modelId], presetId)
      const nextSignalModelStrategies = normalizeSignalModelStrategies({
        ...currentSignalModelStrategies,
        [modelId]: nextStrategy,
      }, current.strategy)

      return {
        ...current,
        strategy: {
          ...current.strategy,
          signalModelStrategies: nextSignalModelStrategies,
        },
      }
    })
  }

  function applyBot3RiskPreset(presetId) {
    setForm((current) => ({
      ...current,
      strategy: {
        ...current.strategy,
        bot3RiskPresetId: resolveBot3RiskPresetId(presetId),
      },
    }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (controlsDisabled) {
      return
    }

    const preparedSettings = getPreparedSettings({
      ...form,
      strategy: {
        ...form.strategy,
        signalModelStrategies,
      },
    })
    const patch = buildSettingsPatch(settings, preparedSettings)

    if (Object.keys(patch).length === 0) {
      return
    }

    await onSave(patch)
  }

  return (
    <form className="grid gap-6" onSubmit={handleSubmit}>
      <PageHeader
        title="Settings"
        description="Automation, per-bot strategy, and exchange credentials. Changes are saved with the button at the bottom of each tab."
      />
      <SettingsTabs />

      {!ready ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
          Waiting for the saved settings to load from the backend. Saving is disabled until the current settings snapshot is available.
        </div>
      ) : null}
      {aiTrainingStatus?.running ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
          AI training is running, so bot strategy settings are temporarily read-only to keep the training environment stable.
        </div>
      ) : null}

      <fieldset disabled={controlsDisabled} className="contents">
      <Routes>
      <Route index element={<Navigate to="/settings/automation" replace />} />
      <Route path="automation" element={(
      <Panel title="Automation">
        <div className="grid gap-4">
          <ToggleCard
            title={STRATEGY_FIELD_META.autoTradingEnabled.label}
            description="Global on/off switch for the automatic trader across every configured wallet."
            enabled={form.strategy.autoTradingEnabled}
            enabledLabel="Automation On"
            disabledLabel="Automation Off"
            onToggle={() => persistStrategyToggle('autoTradingEnabled')}
            disabled={controlsDisabled}
          />

          <ToggleCard
            title={STRATEGY_FIELD_META.sessionScheduleEnabled.label}
            description="Keeps the scheduler inside the saved Manila windows when enabled, or scans continuously during testing when disabled."
            enabled={form.strategy.sessionScheduleEnabled}
            enabledLabel="Scheduled"
            disabledLabel="Continuous"
            onToggle={() => persistStrategyToggle('sessionScheduleEnabled')}
            disabled={controlsDisabled}
          >
            <div className="flex flex-wrap gap-2">
              {(form.strategy.scheduledSessions || []).map((session) => (
                <span
                  key={session.id}
                  className="inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-200"
                >
                  <span>{session.label}</span>
                  <span className="text-sky-100/70">{formatAutoTradeSessionRange(session)}</span>
                </span>
              ))}
            </div>
          </ToggleCard>

          <div className="rounded-[28px] border border-white/10 bg-slate-950/65 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">{STRATEGY_FIELD_META.preferredSymbols.label}</div>
                <div className="mt-2 text-sm leading-relaxed text-slate-300">
                  Auto-managed universe from the live top {VOLATILE_MARKET_SYMBOL_LIMIT} symbols by volume x volatility.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPreferredSymbols((current) => !current)}
                className="rounded-2xl border border-sky-300/20 bg-slate-950/35 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-sky-100 transition hover:border-sky-300/40 hover:bg-slate-950/50"
              >
                {showPreferredSymbols ? 'Hide Coins' : `View ${form.strategy.preferredSymbols?.length || 0}`}
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Tracked Universe</div>
              <div className="mt-1 text-sm font-semibold text-white">{(form.strategy.preferredSymbols || []).length} pairs</div>
            </div>

            {showPreferredSymbols ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {(form.strategy.preferredSymbols || []).map((symbol) => (
                  <span
                    key={symbol}
                    className="inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-200"
                  >
                    <CoinAvatar symbol={symbol} size="xs" />
                    {symbol}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </Panel>
      )} />
      <Route path="strategy" element={(
      <Panel title="Bot Strategy Comparison">
        <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-4 text-sm text-sky-100">
          Pick a bot from the dropdown below to view or edit its strategy. Bot 1 and Bot 2 are editable; Bot 3 and Bot 4 are automatic and read-only, showing the live resolved settings from their assigned wallet.
        </div>

        <div className="mt-5 max-w-md">
          <label
            htmlFor="comparison-model-picker"
            className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500"
          >
            Choose bot to configure
          </label>
          <div className="relative mt-2">
            <select
              id="comparison-model-picker"
              value={selectedComparison?.model.id || ''}
              onChange={(event) => setComparisonModelId(event.target.value)}
              className="w-full appearance-none rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 pr-11 text-sm font-semibold text-white outline-none transition focus:border-sky-400/40"
            >
              {comparisonModels.map((item) => (
                <option key={item.model.id} value={item.model.id} className="bg-slate-900 text-white">
                  {item.model.name} — {item.model.tag}
                  {item.editableStrategy ? '' : ' (read-only)'}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          </div>
        </div>

        {selectedComparison ? (
          <div className="mt-5 w-full">
            <StrategyCard
              key={selectedComparison.model.id}
              model={selectedComparison.model}
              wallet={selectedComparison.wallet}
              editableStrategy={selectedComparison.editableStrategy}
              effectiveStrategy={selectedComparison.effectiveStrategy}
              accountSnapshot={selectedComparison.accountSnapshot}
              onUpdateStrategy={updateSignalModelStrategy}
              onApplyPreset={applySignalModelTradeStylePreset}
              onApplyBot3Preset={applyBot3RiskPreset}
            />
          </div>
        ) : null}
      </Panel>
      )} />
      <Route path="credentials" element={(
      <>
      <Panel title="API Credentials">
        <div className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            {[
              {
                key: 'apiKey',
                label: 'API Key',
              },
              {
                key: 'secretKey',
                label: 'Secret Key',
              },
            ].map((item) => {
              const credential = getCredentialState(settings, item.key)

              return (
                <div
                  key={item.key}
                  className={`rounded-2xl border px-4 py-4 text-sm ${
                    credential.present
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                      : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
                  }`}
                >
                  <div className="text-[11px] uppercase tracking-[0.18em] opacity-75">{item.label} Status</div>
                  <div className="mt-2 text-sm font-semibold">
                    {credential.present ? 'Stored on server' : 'Missing'}
                  </div>
                  <div className="mt-2 text-xs leading-relaxed opacity-80">
                    {credential.present
                      ? `Protected server-side only. Fingerprint ${credential.fingerprint || 'n/a'} • ${credential.length} characters.`
                      : 'This credential is not configured yet.'}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-4 text-sm text-sky-100">
            Credentials are now hidden from the browser. Leave both fields blank to keep the current server-side keys, or paste a new pair to rotate them.
          </div>
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Replace Binance Futures Testnet API Key</span>
            <input
              value={form.apiKey}
              onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
              type="password"
              autoComplete="new-password"
              placeholder={getCredentialState(settings, 'apiKey').present ? 'Leave blank to keep the current API key' : 'Paste API key'}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Replace Binance Futures Testnet Secret Key</span>
            <input
              value={form.secretKey}
              onChange={(event) => setForm((current) => ({ ...current, secretKey: event.target.value }))}
              type="password"
              autoComplete="new-password"
              placeholder={getCredentialState(settings, 'secretKey').present ? 'Leave blank to keep the current secret key' : 'Paste secret key'}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
            />
          </label>
        </div>
      </Panel>
      <Panel title="Real Money — Binance Futures Live API">
        <div className="grid gap-4">
          <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-4 text-sm text-red-100">
            These are LIVE Binance Futures keys tied to real funds — separate from the testnet pair above. Saving them here
            only stores the keys and lets Wallets → Real Money verify the account balance. Nothing in the auto-trading
            system routes an order through these keys yet; that requires a separate, deliberate go-live step. See
            GO_LIVE_READINESS.md for the checklist.
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              {
                key: 'liveApiKey',
                label: 'Live API Key',
              },
              {
                key: 'liveSecretKey',
                label: 'Live Secret Key',
              },
            ].map((item) => {
              const credential = getCredentialState(settings, item.key)

              return (
                <div
                  key={item.key}
                  className={`rounded-2xl border px-4 py-4 text-sm ${
                    credential.present
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                      : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
                  }`}
                >
                  <div className="text-[11px] uppercase tracking-[0.18em] opacity-75">{item.label} Status</div>
                  <div className="mt-2 text-sm font-semibold">
                    {credential.present ? 'Stored on server' : 'Missing'}
                  </div>
                  <div className="mt-2 text-xs leading-relaxed opacity-80">
                    {credential.present
                      ? `Protected server-side only. Fingerprint ${credential.fingerprint || 'n/a'} • ${credential.length} characters.`
                      : 'This credential is not configured yet.'}
                  </div>
                </div>
              )
            })}
          </div>
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Replace Binance Futures Live API Key</span>
            <input
              value={form.liveApiKey}
              onChange={(event) => setForm((current) => ({ ...current, liveApiKey: event.target.value }))}
              type="password"
              autoComplete="new-password"
              placeholder={getCredentialState(settings, 'liveApiKey').present ? 'Leave blank to keep the current live API key' : 'Paste live API key'}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Replace Binance Futures Live Secret Key</span>
            <input
              value={form.liveSecretKey}
              onChange={(event) => setForm((current) => ({ ...current, liveSecretKey: event.target.value }))}
              type="password"
              autoComplete="new-password"
              placeholder={getCredentialState(settings, 'liveSecretKey').present ? 'Leave blank to keep the current live secret key' : 'Paste live secret key'}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
            />
          </label>
        </div>
      </Panel>
      </>
      )} />
      <Route path="*" element={<Navigate to="/settings/automation" replace />} />
      </Routes>

      <div>
        <button
          type="submit"
          disabled={controlsDisabled}
          className="rounded-2xl bg-sky-400 px-5 py-3 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
        >
          {saving ? 'Saving...' : !ready ? 'Waiting for Settings...' : 'Save Settings'}
        </button>
      </div>
      </fieldset>
    </form>
  )
}
