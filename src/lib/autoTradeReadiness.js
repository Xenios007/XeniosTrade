import { getTradeRiskAmount, isTradeClosed } from './accountMetrics.js'
import { getEffectiveSignalModelStrategy, getSignalModel, getSignalModelTrackedSymbols } from './signalModels.js'
import { isHourWithinScheduledSessions } from './tradingSessions.js'

function getManilaDateKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp)

  const lookup = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )

  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

function getManilaHour(timestamp = Date.now()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp))
}

function isAutoTradeSource(source) {
  return String(source || '').startsWith('AUTO')
}

function summarizeToday(trades, dateKey) {
  const today = trades.filter((trade) => trade?.tradeDateKey === dateKey && isAutoTradeSource(trade?.source))
  const closed = today.filter((trade) => isTradeClosed(trade))

  return {
    tradeCount: today.length,
    lossCount: closed.filter((trade) => Number(trade?.pnl || 0) < 0).length,
    pnl: Number(closed.reduce((sum, trade) => sum + Number(trade?.pnl || 0), 0).toFixed(2)),
    realizedLoss: Number(closed.reduce((sum, trade) => sum + Math.max(0, -Number(trade?.pnl || 0)), 0).toFixed(2)),
  }
}

function buildPrimaryBlocker({
  strategy,
  accountSnapshot,
  activeSignalModel,
  today,
  reservedOpenRisk,
  withinSchedule,
  manilaHour,
  trackedSymbols,
}) {
  if (activeSignalModel.status === 'blank') {
    return {
      headline: 'Auto-trade is blocked by the active model.',
      reason: `${activeSignalModel.name} has no live rules yet.`,
      detail: 'Switch to a ready model before expecting the scheduler to place new trades.',
    }
  }

  if (!strategy?.autoTradingEnabled) {
    return {
      headline: 'Automatic daily trading is turned off.',
      reason: 'Scheduled runs are disabled in the current settings.',
      detail: 'Enable automatic trading to let the scheduler keep scanning for the next setup.',
    }
  }

  if (strategy?.sessionScheduleEnabled && !withinSchedule) {
    return {
      headline: 'Auto-trade is waiting for the next Manila session.',
      reason: `The current Manila hour (${String(manilaHour).padStart(2, '0')}:00) is outside the saved schedule.`,
      detail: 'Disable the schedule for continuous testing or wait for the next saved trading window.',
    }
  }

  if (today.realizedLoss >= Number(strategy?.maxLossPerDay || 0)) {
    return {
      headline: 'The daily USDT loss budget is already reached.',
      reason: `${today.realizedLoss.toFixed(2)} / ${Number(strategy?.maxLossPerDay || 0).toFixed(2)} USDT realized loss is booked for today.`,
      detail: 'The auto-trader will not continue until the Manila trading day resets.',
    }
  }

  if (today.realizedLoss + reservedOpenRisk >= Number(strategy?.maxLossPerDay || 0)) {
    return {
      headline: 'Open-position risk already uses the daily USDT loss budget.',
      reason: `${(today.realizedLoss + reservedOpenRisk).toFixed(2)} / ${Number(strategy?.maxLossPerDay || 0).toFixed(2)} USDT is already consumed or reserved.`,
      detail: 'Close risk exposure or wait for trades to resolve before opening another auto trade.',
    }
  }

  if (accountSnapshot.marginPerTrade > 0 && accountSnapshot.availableBalance < accountSnapshot.marginPerTrade) {
    return {
      headline: 'There is not enough free balance for the next trade.',
      reason: `${accountSnapshot.availableBalance.toFixed(2)} / ${accountSnapshot.marginPerTrade.toFixed(2)} USDT is available for the next margin allocation.`,
      detail: 'Reduce margin per trade, free reserved margin, or grow the running balance before the next auto entry.',
    }
  }

  if (accountSnapshot.effectiveMaxOpenPositions > 0 && accountSnapshot.openTradeCount >= accountSnapshot.effectiveMaxOpenPositions) {
    return {
      headline: 'The live open-position cap has been reached.',
      reason: `${accountSnapshot.openTradeCount} / ${accountSnapshot.effectiveMaxOpenPositions} funded slots are already in use.`,
      detail: 'The bot cannot add another position until one closes or the balance supports a higher live cap.',
    }
  }

  if (accountSnapshot.remainingOpenSlots <= 0) {
    return {
      headline: 'No free position slots remain for a new trade.',
      reason: 'Balance and margin checks leave zero remaining slots for the next position.',
      detail: 'This usually means the requested cap is higher than the wallet can currently fund.',
    }
  }

  if (today.lossCount >= Number(strategy?.maxLossesPerDay || 0)) {
    return {
      headline: 'The daily losing-trade limit has been reached.',
      reason: `${today.lossCount} / ${Math.max(Number(strategy?.maxLossesPerDay || 0), 0)} losing closed auto trades are already recorded today.`,
      detail: 'The bot pauses new entries for the rest of the Manila trading day after this threshold.',
    }
  }

  if (today.pnl >= Number(strategy?.dailyProfitTarget || 0)) {
    return {
      headline: 'The daily profit target is already hit.',
      reason: `${today.pnl.toFixed(2)} / ${Number(strategy?.dailyProfitTarget || 0).toFixed(2)} USDT realized profit is already booked today.`,
      detail: 'The scheduler stops opening fresh positions once the daily target is reached.',
    }
  }

  if (today.tradeCount >= Number(strategy?.maxTradesPerDay || 0)) {
    return {
      headline: 'The daily trade limit has been reached.',
      reason: `${today.tradeCount} / ${Math.max(Number(strategy?.maxTradesPerDay || 0), 0)} auto trades are already logged for today.`,
      detail: 'Wait for the next Manila trading day or raise the daily trade cap if that is intentional.',
    }
  }

  if (trackedSymbols.length === 0) {
    return {
      headline: 'There are no preferred symbols to scan.',
      reason: 'The auto-trade universe is empty right now.',
      detail: 'The volatility scanner needs at least one tracked symbol before the bot can evaluate a setup.',
    }
  }

  return null
}

export function evaluateAutoTradeReadiness({
  strategy = {},
  trades = [],
  accountSnapshot,
  timestamp = Date.now(),
  signalModelId = null,
} = {}) {
  const resolvedSignalModelId = signalModelId || strategy?.activeSignalModelId
  const activeSignalModel = getSignalModel(resolvedSignalModelId)
  const effectiveStrategy = getEffectiveSignalModelStrategy(strategy, resolvedSignalModelId, {
    runningBalance: accountSnapshot?.runningBalance,
  })
  const trackedSymbols = getSignalModelTrackedSymbols(
    resolvedSignalModelId,
    Array.isArray(strategy?.preferredSymbols) ? strategy.preferredSymbols : [],
  )
  const today = summarizeToday(trades, getManilaDateKey(timestamp))
  const openAutoTrades = trades.filter((trade) => trade?.status === 'OPEN' && isAutoTradeSource(trade?.source))
  const reservedOpenRisk = Number(openAutoTrades.reduce((sum, trade) => sum + getTradeRiskAmount(trade, effectiveStrategy), 0).toFixed(2))
  const manilaHour = getManilaHour(timestamp)
  const withinSchedule = !effectiveStrategy?.sessionScheduleEnabled
    || isHourWithinScheduledSessions(manilaHour, effectiveStrategy?.scheduledSessions)
  const blocker = buildPrimaryBlocker({
    strategy: effectiveStrategy,
    accountSnapshot,
    activeSignalModel,
    today,
    reservedOpenRisk,
    withinSchedule,
    manilaHour,
    trackedSymbols,
  })
  const remainingRiskBudget = Number(Math.max(
    Number(effectiveStrategy?.maxLossPerDay || 0) - today.realizedLoss - reservedOpenRisk,
    0,
  ).toFixed(2))

  return {
    status: blocker ? 'blocked' : 'ready',
    headline: blocker ? blocker.headline : 'Next auto-trade scan is allowed.',
    reason: blocker ? blocker.reason : 'All current pre-trade guardrails pass.',
    detail: blocker
      ? blocker.detail
      : `${activeSignalModel.name} can keep scanning ${trackedSymbols.length} tracked symbol${trackedSymbols.length === 1 ? '' : 's'}. A new trade still depends on finding a qualifying setup.`,
    activeSignalModel,
    trackedSymbols,
    today,
    reservedOpenRisk,
    remainingRiskBudget,
    schedule: {
      enabled: Boolean(strategy?.sessionScheduleEnabled),
      withinSchedule,
      manilaHour,
      label: strategy?.sessionScheduleEnabled
        ? withinSchedule
          ? 'Inside saved Manila session'
          : 'Outside saved Manila session'
        : 'Continuous testing mode',
    },
  }
}
