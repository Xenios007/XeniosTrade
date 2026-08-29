import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Lock, Radar, TrendingDown, TrendingUp } from 'lucide-react'
import { formatPrice } from '../lib/formatters'
import { calculateEMA, calculateSMA, calculateVWAP } from '../lib/indicators'
import { SIGNAL_MODELS, getSignalModel } from '../lib/signalModels'
import { Panel } from './Panel'

const intervals = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']
const indicatorItems = [
  { key: 'ema', label: 'EMA 12' },
  { key: 'ma', label: 'MA 20' },
  { key: 'bb', label: 'BB 20,2' },
  { key: 'rsi', label: 'RSI 14' },
]
const EMPTY_MODEL_STATS = {
  tradeCount: 0,
  closedTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  pnl: 0,
}
const CHART_SCENARIO_RIGHT_OFFSET = 14

function formatWinRate(winRate, closedTrades) {
  if (!closedTrades) {
    return 'No closed trades'
  }

  return `${(Number(winRate || 0) * 100).toFixed(0)}% win`
}

function formatSignedUsdt(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function isFinitePrice(value) {
  return Number.isFinite(Number(value))
}

function getAiStatusMeta(aiAdvisory = null) {
  if (!aiAdvisory) {
    return {
      label: 'AI Offline',
      tone: 'border-white/10 bg-white/[0.03] text-slate-300',
      score: 'N/A',
      detail: 'AI advisory is still loading for this bot.',
    }
  }

  if (aiAdvisory.status === 'accept') {
    return {
      label: 'AI Accept',
      tone: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
      score: `${aiAdvisory.finalScore}/${aiAdvisory.thresholdScore}`,
      detail: aiAdvisory.detail,
    }
  }

  if (aiAdvisory.status === 'caution') {
    return {
      label: 'AI Skip',
      tone: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      score: `${aiAdvisory.finalScore}/${aiAdvisory.thresholdScore}`,
      detail: aiAdvisory.detail,
    }
  }

  if (aiAdvisory.status === 'waiting') {
    return {
      label: 'AI Waiting',
      tone: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      score: 'Standby',
      detail: aiAdvisory.detail,
    }
  }

  return {
    label: 'AI Training',
    tone: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    score: 'Needs data',
    detail: aiAdvisory.detail || 'AI is still preparing its advisory policy.',
  }
}

function getModelDirectionMeta(model, analysis) {
  if (model.status === 'blank') {
    return {
      label: 'Blank Slot',
      Icon: Lock,
    }
  }

  if (analysis?.ready) {
    return analysis.checklistSide === 'SHORT'
      ? { label: 'Short Ready', Icon: TrendingDown }
      : { label: 'Long Ready', Icon: TrendingUp }
  }

  if (analysis?.checklistSide === 'SHORT') {
    return {
      label: 'Short Bias',
      Icon: TrendingDown,
    }
  }

  if (analysis?.checklistSide === 'LONG') {
    return {
      label: 'Long Bias',
      Icon: TrendingUp,
    }
  }

  return {
    label: 'Watching',
    Icon: Radar,
  }
}

function getModelTone(model, analysis, isActive) {
  if (model.status === 'blank') {
    return {
      card: `border-white/10 bg-slate-950/88 ${isActive ? 'shadow-[0_0_0_1px_rgba(148,163,184,0.18)]' : ''}`,
      badge: 'border-white/10 bg-white/[0.04] text-slate-400',
      fill: 'bg-slate-500/70',
      signalOn: 'bg-slate-400/80',
      signalOff: 'bg-white/10',
    }
  }

  if (analysis?.checklistSide === 'SHORT') {
    return {
      card: `${isActive ? 'border-rose-300/40 bg-rose-400/12 shadow-[0_0_0_1px_rgba(251,113,133,0.18)]' : 'border-rose-400/20 bg-slate-950/86'}`,
      badge: analysis?.ready
        ? 'border-rose-300/30 bg-rose-400/15 text-rose-200'
        : 'border-rose-400/20 bg-rose-400/10 text-rose-200',
      fill: analysis?.ready ? 'bg-rose-300' : 'bg-rose-400/85',
      signalOn: analysis?.ready ? 'bg-rose-300' : 'bg-rose-400/80',
      signalOff: 'bg-white/10',
    }
  }

  if (analysis?.checklistSide === 'LONG') {
    return {
      card: `${isActive ? 'border-emerald-300/40 bg-emerald-400/12 shadow-[0_0_0_1px_rgba(110,231,183,0.18)]' : 'border-emerald-400/20 bg-slate-950/86'}`,
      badge: analysis?.ready
        ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-200'
        : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
      fill: analysis?.ready ? 'bg-emerald-300' : 'bg-emerald-400/85',
      signalOn: analysis?.ready ? 'bg-emerald-300' : 'bg-emerald-400/80',
      signalOff: 'bg-white/10',
    }
  }

  return {
    card: `${isActive ? 'border-sky-300/40 bg-sky-400/12 shadow-[0_0_0_1px_rgba(125,211,252,0.18)]' : 'border-sky-400/20 bg-slate-950/86'}`,
    badge: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
    fill: 'bg-sky-400/85',
    signalOn: 'bg-sky-400/80',
    signalOff: 'bg-white/10',
  }
}

function getSignalSlots(model, analysis) {
  if (Array.isArray(analysis?.checklist) && analysis.checklist.length > 0) {
    return analysis.checklist.map((signal) => ({
      key: signal.key,
      passed: Boolean(signal.passed),
    }))
  }

  const fallbackCount = Math.max(model.totalSignals || 0, model.status === 'blank' ? 3 : 4)
  return Array.from({ length: fallbackCount }, (_, index) => ({
    key: `${model.id}-placeholder-${index}`,
    passed: false,
  }))
}

function getModelStatusLine(model, analysis) {
  if (model.status === 'blank') {
    return 'No live rules yet.'
  }

  if (!analysis) {
    return 'Loading live scan...'
  }

  if (analysis.ready) {
    return `${analysis.checklistSide} entry conditions aligned.`
  }

  const firstMissingSignal = analysis.checklist?.find((signal) => !signal.passed)
  if (firstMissingSignal) {
    return `Next: ${firstMissingSignal.label}`
  }

  return `${analysis.score}/${analysis.maxScore} signals active.`
}

function getChecklistSignal(analysis, ...keys) {
  for (const key of keys) {
    const match = analysis?.checklist?.find((signal) => signal.key === key)
    if (match) {
      return match
    }
  }

  return null
}

function buildActiveSignalMarkers(data, analysis) {
  if (!analysis || data.length === 0) {
    return []
  }

  const latestCandle = data[data.length - 1]
  const setupCandle = data[data.length - 2] || latestCandle
  const isShortBias = analysis.checklistSide === 'SHORT'
  const hasDirectionalBias = analysis.checklistSide === 'LONG' || analysis.checklistSide === 'SHORT'
  const markerPosition = isShortBias ? 'aboveBar' : 'belowBar'
  const readyColor = isShortBias ? '#fb7185' : '#34d399'
  const biasColor = hasDirectionalBias
    ? isShortBias
      ? '#fb7185'
      : '#38bdf8'
    : '#94a3b8'
  const setupRangeEdgePassed = Boolean(getChecklistSignal(analysis, 'setup-zone-context', 'setup-range-edge')?.passed)
  const setupSweepPassed = Boolean(getChecklistSignal(analysis, 'setup-price-action-pattern', 'setup-liquidity-sweep')?.passed)
  const setupAbsorptionPassed = Boolean(getChecklistSignal(analysis, 'setup-volume-confirmation', 'setup-volume-absorption')?.passed)
  const confirmationPassed = Boolean(getChecklistSignal(analysis, 'entry-confirmation', 'entry-confirmation-close')?.passed)
  const progressText = analysis.maxScore > 0 ? `${analysis.score}/${analysis.maxScore}` : '0/0'
  const markers = []

  if (analysis.signalModelId === 'model-4') {
    const contextPassed = Boolean(getChecklistSignal(analysis, 'trend-filter-15m')?.passed)
    const pullbackPassed = Boolean(getChecklistSignal(analysis, 'setup-ema20-pullback-5m', 'setup-rsi14-5m')?.passed)
    const triggerPassed = Boolean(getChecklistSignal(analysis, 'entry-1m-confirmation', 'entry-1m-engulfing', 'entry-1m-break-previous-candle')?.passed)

    if (contextPassed || pullbackPassed) {
      markers.push({
        time: setupCandle.time,
        position: markerPosition,
        shape: pullbackPassed ? 'circle' : 'square',
        color: pullbackPassed ? biasColor : '#94a3b8',
        text: pullbackPassed ? 'EMA Pullback' : 'Trend',
        size: 0.9,
        id: 'setup-signal',
      })
    }

    if (analysis.ready) {
      markers.push({
        time: latestCandle.time,
        position: markerPosition,
        shape: isShortBias ? 'arrowDown' : 'arrowUp',
        color: readyColor,
        text: 'Continuation Ready',
        size: 1.25,
        id: 'current-signal',
      })

      return markers
    }

    if (triggerPassed) {
      markers.push({
        time: latestCandle.time,
        position: markerPosition,
        shape: 'circle',
        color: biasColor,
        text: `Confirm ${progressText}`,
        size: 0.95,
        id: 'current-signal',
      })

      return markers
    }

    markers.push({
      time: latestCandle.time,
      position: markerPosition,
      shape: analysis.score > 0 ? 'circle' : 'square',
      color: analysis.score > 0 ? biasColor : '#94a3b8',
      text: analysis.score > 0 ? `Watch ${progressText}` : 'No Entry',
      size: analysis.score > 0 ? 0.9 : 0.8,
      id: 'current-signal',
    })

    return markers
  }

  if (analysis.signalModelId === 'model-3') {
    const structurePassed = Boolean(getChecklistSignal(analysis, 'bias-market-structure')?.passed)
    const vwapBiasPassed = Boolean(getChecklistSignal(analysis, 'setup-vwap-bias')?.passed)
    const emaPullbackPassed = Boolean(getChecklistSignal(analysis, 'setup-pullback-into-ema')?.passed)
    const vwapStretchPassed = Boolean(getChecklistSignal(analysis, 'setup-vwap-stretch-limit')?.passed)
    const structureHoldPassed = Boolean(getChecklistSignal(analysis, 'entry-structure-hold')?.passed)
    const triggerPassed = Boolean(getChecklistSignal(analysis, 'entry-price-action-trigger')?.passed)

    if (emaPullbackPassed || vwapBiasPassed || structurePassed || vwapStretchPassed) {
      markers.push({
        time: setupCandle.time,
        position: markerPosition,
        shape: emaPullbackPassed ? 'circle' : 'square',
        color: emaPullbackPassed
          ? biasColor
          : vwapBiasPassed
            ? '#f59e0b'
            : '#94a3b8',
        text: emaPullbackPassed ? 'EMA Pullback' : vwapBiasPassed ? 'VWAP' : structurePassed ? 'Trend' : 'Stretch OK',
        size: emaPullbackPassed ? 0.95 : 0.85,
        id: 'setup-signal',
      })
    }

    if (analysis.ready) {
      markers.push({
        time: latestCandle.time,
        position: markerPosition,
        shape: isShortBias ? 'arrowDown' : 'arrowUp',
        color: readyColor,
        text: 'Entry Ready',
        size: 1.25,
        id: 'current-signal',
      })

      return markers
    }

    if (triggerPassed) {
      markers.push({
        time: latestCandle.time,
        position: markerPosition,
        shape: 'circle',
        color: biasColor,
        text: `Reclaim ${progressText}`,
        size: 0.95,
        id: 'current-signal',
      })

      return markers
    }

    if (structureHoldPassed) {
      markers.push({
        time: latestCandle.time,
        position: markerPosition,
        shape: 'circle',
        color: biasColor,
        text: `Hold ${progressText}`,
        size: 0.9,
        id: 'current-signal',
      })

      return markers
    }

    markers.push({
      time: latestCandle.time,
      position: markerPosition,
      shape: analysis.score > 0 ? 'circle' : 'square',
      color: analysis.score > 0 ? biasColor : '#94a3b8',
      text: analysis.score > 0 ? `Watch ${progressText}` : 'No Entry',
      size: analysis.score > 0 ? 0.9 : 0.8,
      id: 'current-signal',
    })

    return markers
  }

  if (setupSweepPassed || setupRangeEdgePassed || setupAbsorptionPassed) {
    markers.push({
      time: setupCandle.time,
      position: markerPosition,
      shape: setupSweepPassed
        ? isShortBias
          ? 'arrowDown'
          : 'arrowUp'
        : 'circle',
      color: setupSweepPassed
        ? biasColor
        : setupAbsorptionPassed
          ? '#f59e0b'
          : '#94a3b8',
        text: setupSweepPassed ? 'Setup' : setupAbsorptionPassed ? 'Volume' : 'Zone',
      size: setupSweepPassed ? 1 : 0.85,
      id: 'setup-signal',
    })
  }

  if (analysis.ready) {
    markers.push({
      time: latestCandle.time,
      position: markerPosition,
      shape: isShortBias ? 'arrowDown' : 'arrowUp',
      color: readyColor,
      text: 'Entry Ready',
      size: 1.25,
      id: 'current-signal',
    })

    return markers
  }

  if (confirmationPassed) {
    markers.push({
      time: latestCandle.time,
      position: markerPosition,
      shape: 'circle',
      color: biasColor,
      text: `Confirm ${progressText}`,
      size: 0.95,
      id: 'current-signal',
    })

    return markers
  }

  markers.push({
    time: latestCandle.time,
    position: markerPosition,
    shape: analysis.score > 0 ? 'circle' : 'square',
    color: analysis.score > 0 ? biasColor : '#94a3b8',
    text: analysis.score > 0 ? `Watch ${progressText}` : 'No Entry',
    size: analysis.score > 0 ? 0.9 : 0.8,
    id: 'current-signal',
  })

  return markers
}

function getCurrentCandleSignalState(model, analysis) {
  if (model.status === 'blank') {
    return {
      badge: 'No Rules',
      title: 'No entry logic is active for the latest confirmed setup.',
      detail: `${model.name} is still an empty slot with no live signals to evaluate.`,
      panelTone: 'border-white/10 bg-slate-950/60 text-slate-300',
      badgeTone: 'border-white/10 bg-white/[0.04] text-slate-300',
    }
  }

  if (!analysis) {
    return {
      badge: 'Scanning',
      title: 'Latest confirmed setup is still loading.',
      detail: 'Waiting for the active bot checklist to finish evaluating the newest closed-candle setup.',
      panelTone: 'border-white/10 bg-slate-950/60 text-slate-300',
      badgeTone: 'border-white/10 bg-white/[0.04] text-slate-300',
    }
  }

  const nextMissingSignal = analysis.checklist?.find((signal) => !signal.passed) || null
  const progressText = analysis.maxScore > 0 ? `${analysis.score}/${analysis.maxScore}` : '0/0'
  const setupSide = analysis.checklistSide === 'SHORT'
    ? 'short'
    : analysis.checklistSide === 'LONG'
      ? 'long'
      : 'neutral'

  if (analysis.ready) {
    const isShortBias = analysis.checklistSide === 'SHORT'
    const entryLabel = isFinitePrice(analysis.entryPrice)
      ? formatPrice(analysis.entryPrice, 5)
      : 'the current market price'
    return {
      badge: 'Entry Ready',
      title: `Possible ${setupSide} entry on the latest confirmed setup.`,
      detail: `${model.name} is entry-ready near ${entryLabel} with ${progressText} signals aligned.`,
      panelTone: isShortBias
        ? 'border-rose-400/20 bg-rose-400/10 text-rose-100'
        : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
      badgeTone: isShortBias
        ? 'border-rose-300/30 bg-rose-400/15 text-rose-200'
        : 'border-emerald-300/30 bg-emerald-400/15 text-emerald-200',
    }
  }

  return {
    badge: 'No Entry',
    title: `${setupSide === 'neutral' ? 'Setup is still forming' : `${setupSide[0].toUpperCase()}${setupSide.slice(1)} setup is building`} on the latest confirmed setup.`,
    detail: nextMissingSignal
      ? `${progressText} signals are active. Still waiting for ${nextMissingSignal.label.toLowerCase()} before entry.`
      : `${progressText} signals are active, but the latest confirmed setup still does not qualify for entry.`,
    panelTone: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    badgeTone: 'border-sky-400/20 bg-sky-400/12 text-sky-200',
  }
}

function getActiveBotVisualSpec(model, data, analysis) {
  if (!model) {
    return {
      title: 'Chart visual mode is waiting for a bot selection.',
      detail: 'Pick a bot to let the chart switch into that bot’s visual logic.',
      panelTone: 'border-white/10 bg-slate-950/60 text-slate-300',
      badgeTone: 'border-white/10 bg-white/[0.04] text-slate-300',
      badge: 'No Bot',
      legend: [],
      series: [],
    }
  }

  if (model.id === 'model-3') {
    return {
      title: `${model.name} visuals are active on the chart.`,
      detail: analysis
        ? 'The graph is now reading Bot 3 through EMA 9, VWAP, trend structure, support/resistance zones, and retest-style entry markers.'
        : 'Loading Bot 3 EMA 9, VWAP, structure, and retest visuals.',
      panelTone: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      badgeTone: 'border-amber-400/20 bg-amber-400/12 text-amber-200',
      badge: 'Trend + Retest',
      legend: [
        { key: 'ema-9', label: 'EMA 9', chipClass: 'bg-amber-300' },
        { key: 'vwap', label: 'VWAP', chipClass: 'bg-cyan-300' },
        { key: 'structure', label: 'Structure Levels', chipClass: 'bg-sky-300' },
        { key: 'trigger', label: 'Pullback / Retest', chipClass: 'bg-emerald-300' },
      ],
      series: [
        {
          key: `${model.id}-ema-9`,
          data: calculateEMA(data, 9),
          options: {
            color: '#f59e0b',
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
        {
          key: `${model.id}-vwap`,
          data: calculateVWAP(data),
          options: {
            color: '#22d3ee',
            lineWidth: 2,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
      ],
    }
  }

  if (model.id === 'model-4') {
    return {
      title: `${model.name} visuals are active on the chart.`,
      detail: analysis
        ? 'The graph is now reading Bot 4 through 15M EMA20/EMA50 trend, 5M EMA20 pullbacks, RSI14, 1M confirmation triggers, and continuation markers.'
        : 'Loading Bot 4 momentum-pullback continuation visuals.',
      panelTone: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      badgeTone: 'border-rose-400/20 bg-rose-400/12 text-rose-200',
      badge: 'Momentum Pullback AI',
      legend: [
        { key: 'ema-20', label: 'EMA 20', chipClass: 'bg-rose-300' },
        { key: 'vwap', label: 'VWAP', chipClass: 'bg-cyan-300' },
        { key: 'zones', label: 'EMA Pullback', chipClass: 'bg-sky-300' },
        { key: 'trigger', label: '1M Confirmation', chipClass: 'bg-emerald-300' },
      ],
      series: [
        {
          key: `${model.id}-ema-20`,
          data: calculateEMA(data, 20),
          options: {
            color: '#fb7185',
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
        {
          key: `${model.id}-vwap`,
          data: calculateVWAP(data),
          options: {
            color: '#22d3ee',
            lineWidth: 2,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
      ],
    }
  }

  if (model.id === 'model-2') {
    return {
      title: `${model.name} visuals are active on the chart.`,
      detail: analysis
        ? 'The graph is now using Bot 2’s zone-confirmation structure, support/resistance, and closed-candle retest markers. Professional filters still affect readiness in the score.'
        : 'Loading Bot 2 zone-confirmation visuals.',
      panelTone: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      badgeTone: 'border-rose-400/20 bg-rose-400/12 text-rose-200',
      badge: 'Zone + Pro Filters',
      legend: [
        { key: 'support', label: 'Support', chipClass: 'bg-sky-300' },
        { key: 'resistance', label: 'Resistance', chipClass: 'bg-amber-300' },
        { key: 'signal', label: 'Setup / Confirm', chipClass: 'bg-rose-300' },
      ],
      series: [],
    }
  }

  return {
    title: `${model.name} visuals are active on the chart.`,
    detail: analysis
      ? 'The graph is now using Bot 1’s support/resistance zones, setup-proof markers, and confirmed entry levels.'
      : 'Loading Bot 1 zone-confirmation visuals.',
    panelTone: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    badgeTone: 'border-sky-400/20 bg-sky-400/12 text-sky-200',
    badge: 'Zone Confirmation',
    legend: [
      { key: 'support', label: 'Support', chipClass: 'bg-sky-300' },
      { key: 'resistance', label: 'Resistance', chipClass: 'bg-amber-300' },
      { key: 'signal', label: 'Setup / Confirm', chipClass: 'bg-emerald-300' },
    ],
    series: [],
  }
}

function getResolvedActiveBotVisualSpec(model, data, analysis) {
  if (!model) {
    return {
      title: 'Chart visual mode is waiting for a bot selection.',
      detail: "Pick a bot to let the chart switch into that bot's visual logic.",
      panelTone: 'border-white/10 bg-slate-950/60 text-slate-300',
      badgeTone: 'border-white/10 bg-white/[0.04] text-slate-300',
      badge: 'No Bot',
      legend: [],
      series: [],
    }
  }

  if (model.id === 'model-3') {
    return {
      title: `${model.name} visuals are active on the chart.`,
      detail: analysis
        ? 'The graph is now reading Bot 3 through EMA 9, VWAP, trend structure, support/resistance zones, and retest-style entry markers.'
        : 'Loading Bot 3 EMA 9, VWAP, structure, and retest visuals.',
      panelTone: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      badgeTone: 'border-amber-400/20 bg-amber-400/12 text-amber-200',
      badge: 'Trend + Retest',
      legend: [
        { key: 'ema-9', label: 'EMA 9', chipClass: 'bg-amber-300' },
        { key: 'vwap', label: 'VWAP', chipClass: 'bg-cyan-300' },
        { key: 'structure', label: 'Structure Levels', chipClass: 'bg-sky-300' },
        { key: 'trigger', label: 'Pullback / Retest', chipClass: 'bg-emerald-300' },
      ],
      series: [
        {
          key: `${model.id}-ema-9`,
          data: calculateEMA(data, 9),
          options: {
            color: '#f59e0b',
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
        {
          key: `${model.id}-vwap`,
          data: calculateVWAP(data),
          options: {
            color: '#22d3ee',
            lineWidth: 2,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
      ],
    }
  }

  if (model.id === 'model-4') {
    return {
      title: `${model.name} visuals are active on the chart.`,
      detail: analysis
        ? 'The graph is now reading Bot 4 through 15M EMA20/EMA50 trend, 5M EMA20 pullbacks, RSI14, 1M confirmation triggers, and continuation markers.'
        : 'Loading Bot 4 momentum-pullback continuation visuals.',
      panelTone: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      badgeTone: 'border-rose-400/20 bg-rose-400/12 text-rose-200',
      badge: 'Momentum Pullback AI',
      legend: [
        { key: 'ema-20', label: 'EMA 20', chipClass: 'bg-rose-300' },
        { key: 'vwap', label: 'VWAP', chipClass: 'bg-cyan-300' },
        { key: 'zones', label: 'EMA Pullback', chipClass: 'bg-sky-300' },
        { key: 'trigger', label: '1M Confirmation', chipClass: 'bg-emerald-300' },
      ],
      series: [
        {
          key: `${model.id}-ema-20`,
          data: calculateEMA(data, 20),
          options: {
            color: '#fb7185',
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
        {
          key: `${model.id}-vwap`,
          data: calculateVWAP(data),
          options: {
            color: '#22d3ee',
            lineWidth: 2,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          },
        },
      ],
    }
  }

  if (model.id === 'model-2') {
    return {
      title: `${model.name} visuals are active on the chart.`,
      detail: analysis
        ? "The graph is now using Bot 2's zone-confirmation structure, support/resistance, and closed-candle retest markers. Professional filters still affect readiness in the score."
        : 'Loading Bot 2 zone-confirmation visuals.',
      panelTone: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      badgeTone: 'border-rose-400/20 bg-rose-400/12 text-rose-200',
      badge: 'Zone + Pro Filters',
      legend: [
        { key: 'support', label: 'Support', chipClass: 'bg-sky-300' },
        { key: 'resistance', label: 'Resistance', chipClass: 'bg-amber-300' },
        { key: 'signal', label: 'Setup / Confirm', chipClass: 'bg-rose-300' },
      ],
      series: [],
    }
  }

  return {
    title: `${model.name} visuals are active on the chart.`,
    detail: analysis
      ? "The graph is now using Bot 1's support/resistance zones, setup-proof markers, and confirmed entry levels."
      : 'Loading Bot 1 zone-confirmation visuals.',
    panelTone: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    badgeTone: 'border-sky-400/20 bg-sky-400/12 text-sky-200',
    badge: 'Zone Confirmation',
    legend: [
      { key: 'support', label: 'Support', chipClass: 'bg-sky-300' },
      { key: 'resistance', label: 'Resistance', chipClass: 'bg-amber-300' },
      { key: 'signal', label: 'Setup / Confirm', chipClass: 'bg-emerald-300' },
    ],
    series: [],
  }
}

export function CandlestickChart({
  data,
  indicators,
  indicatorVisibility,
  symbol,
  interval,
  activeSignalModelId,
  modelAnalyses = {},
  signalModelPerformance = {},
  loading = false,
  onChangeInterval,
  onToggleIndicator,
  footerContent = null,
}) {
  const chartContainerRef = useRef(null)
  const chartApiRef = useRef(null)
  const chartRuntimeRef = useRef(null)
  const visibleLogicalRangeRef = useRef(null)
  const lastChartViewKeyRef = useRef('')
  const [chartEngineReady, setChartEngineReady] = useState(false)
  const [chartEngineError, setChartEngineError] = useState('')
  const activeModel = useMemo(() => getSignalModel(activeSignalModelId), [activeSignalModelId])
  const activeModelAnalysis = modelAnalyses[activeSignalModelId] || null
  const activeSignalMarkers = useMemo(
    () => buildActiveSignalMarkers(data, activeModelAnalysis),
    [data, activeModelAnalysis],
  )
  const activeBotVisualSpec = useMemo(
    () => getResolvedActiveBotVisualSpec(activeModel, data, activeModelAnalysis),
    [activeModel, data, activeModelAnalysis],
  )
  const currentCandleSignalState = useMemo(
    () => getCurrentCandleSignalState(activeModel, activeModelAnalysis),
    [activeModel, activeModelAnalysis],
  )
  const chartViewKey = `${symbol}:${interval}`

  function resetChartView() {
    const chart = chartApiRef.current

    if (!chart) {
      return
    }

    visibleLogicalRangeRef.current = null
    chart.timeScale().fitContent()
  }

  useEffect(() => {
    if (!chartContainerRef.current || data.length === 0) {
      return undefined
    }

    let disposed = false
    let cleanup = () => {}

    async function renderChart() {
      try {
        setChartEngineError('')

        if (!chartRuntimeRef.current) {
          setChartEngineReady(false)
          chartRuntimeRef.current = await import('lightweight-charts')
        }

        if (disposed || !chartContainerRef.current) {
          return
        }

        const {
          CandlestickSeries,
          CrosshairMode,
          LineSeries,
          createChart,
          createSeriesMarkers,
        } = chartRuntimeRef.current

        const chart = createChart(chartContainerRef.current, {
          autoSize: true,
          layout: {
            background: { color: 'transparent' },
            textColor: '#94a3b8',
            panes: {
              separatorColor: 'rgba(148, 163, 184, 0.14)',
              separatorHoverColor: 'rgba(56, 189, 248, 0.35)',
            },
          },
          grid: {
            vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
            horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
          },
          crosshair: {
            mode: CrosshairMode.Normal,
          },
          handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: true,
          },
          handleScale: {
            mouseWheel: true,
            pinch: true,
            axisPressedMouseMove: {
              time: true,
              price: true,
            },
            axisDoubleClickReset: {
              time: false,
              price: true,
            },
          },
          rightPriceScale: {
            borderColor: 'rgba(148, 163, 184, 0.18)',
            scaleMargins: {
              top: 0.08,
              bottom: 0.08,
            },
          },
          timeScale: {
            borderColor: 'rgba(148, 163, 184, 0.18)',
            timeVisible: true,
            rightOffset: CHART_SCENARIO_RIGHT_OFFSET,
            rightBarStaysOnScroll: true,
            fixRightEdge: false,
          },
        })
        chartApiRef.current = chart
        const timeScale = chart.timeScale()
        const visibleRangeChangeHandler = (range) => {
          visibleLogicalRangeRef.current = range || null
        }

        timeScale.subscribeVisibleLogicalRangeChange(visibleRangeChangeHandler)

        const candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#22c55e',
          downColor: '#f43f5e',
          borderVisible: false,
          wickUpColor: '#22c55e',
          wickDownColor: '#f43f5e',
        })

        const emaSeries = chart.addSeries(LineSeries, {
          color: '#38bdf8',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        })

        const maSeries = chart.addSeries(LineSeries, {
          color: '#f59e0b',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        })

        const bbUpperSeries = chart.addSeries(LineSeries, {
          color: 'rgba(148, 163, 184, 0.7)',
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        })

        const bbBasisSeries = chart.addSeries(LineSeries, {
          color: 'rgba(244, 114, 182, 0.9)',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        })

        const bbLowerSeries = chart.addSeries(LineSeries, {
          color: 'rgba(148, 163, 184, 0.7)',
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        })

        const rsiSeries = chart.addSeries(LineSeries, {
          color: '#a78bfa',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        }, 1)
        activeBotVisualSpec.series.forEach((seriesSpec) => {
          const series = chart.addSeries(LineSeries, seriesSpec.options)
          series.setData(seriesSpec.data)
        })

        candleSeries.setData(data)
        emaSeries.setData(indicatorVisibility.ema ? indicators.ema : [])
        maSeries.setData(indicatorVisibility.ma ? indicators.ma : [])
        bbUpperSeries.setData(indicatorVisibility.bb ? indicators.bollinger.upper : [])
        bbBasisSeries.setData(indicatorVisibility.bb ? indicators.bollinger.basis : [])
        bbLowerSeries.setData(indicatorVisibility.bb ? indicators.bollinger.lower : [])
        rsiSeries.setData(indicatorVisibility.rsi ? indicators.rsi : [])

        createSeriesMarkers(candleSeries, activeSignalMarkers, {
          autoScale: true,
          zOrder: 'aboveSeries',
        })

        if (indicatorVisibility.rsi) {
          rsiSeries.createPriceLine({
            price: 70,
            color: 'rgba(244, 63, 94, 0.45)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: 'RSI 70',
          })

          rsiSeries.createPriceLine({
            price: 30,
            color: 'rgba(34, 197, 94, 0.45)',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: 'RSI 30',
          })
        }

        if (activeModelAnalysis) {
          if (isFinitePrice(activeModelAnalysis.support)) {
            candleSeries.createPriceLine({
              price: Number(activeModelAnalysis.support),
              color: 'rgba(56, 189, 248, 0.55)',
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: activeModel.id === 'model-3' ? `${activeModel.name} Structure Low` : `${activeModel.name} Support`,
            })
          }

          if (isFinitePrice(activeModelAnalysis.resistance)) {
            candleSeries.createPriceLine({
              price: Number(activeModelAnalysis.resistance),
              color: 'rgba(245, 158, 11, 0.55)',
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: activeModel.id === 'model-3' ? `${activeModel.name} Structure High` : `${activeModel.name} Resistance`,
            })
          }

          if (activeModelAnalysis.ready) {
            const entryColor = activeModelAnalysis.checklistSide === 'SHORT'
              ? 'rgba(244, 63, 94, 0.92)'
              : 'rgba(34, 197, 94, 0.92)'

            if (isFinitePrice(activeModelAnalysis.entryPrice)) {
              candleSeries.createPriceLine({
                price: Number(activeModelAnalysis.entryPrice),
                color: entryColor,
                lineWidth: 2,
                axisLabelVisible: true,
                title: `${activeModel.name} Entry`,
              })
            }

            if (isFinitePrice(activeModelAnalysis.stopLoss)) {
              candleSeries.createPriceLine({
                price: Number(activeModelAnalysis.stopLoss),
                color: 'rgba(248, 113, 113, 0.82)',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: 'Stop Loss',
              })
            }

            if (isFinitePrice(activeModelAnalysis.takeProfit)) {
              candleSeries.createPriceLine({
                price: Number(activeModelAnalysis.takeProfit),
                color: 'rgba(74, 222, 128, 0.82)',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: 'Take Profit',
              })
            }
          }
        }

        const panes = chart.panes()
        if (panes[0]) {
          panes[0].setHeight(360)
        }
        if (panes[1]) {
          panes[1].setHeight(140)
        }

        if (lastChartViewKeyRef.current !== chartViewKey) {
          visibleLogicalRangeRef.current = null
          lastChartViewKeyRef.current = chartViewKey
        }

        if (visibleLogicalRangeRef.current) {
          timeScale.setVisibleLogicalRange(visibleLogicalRangeRef.current)
        } else {
          timeScale.fitContent()
        }

        setChartEngineReady(true)
        cleanup = () => {
          timeScale.unsubscribeVisibleLogicalRangeChange(visibleRangeChangeHandler)
          chartApiRef.current = null
          chart.remove()
        }
      } catch (error) {
        if (!disposed) {
          setChartEngineError(error instanceof Error ? error.message : 'Unable to load chart engine')
        }
      }
    }

    renderChart()

    return () => {
      disposed = true
      cleanup()
    }
  }, [activeBotVisualSpec.series, activeModel.id, activeModel.name, activeModelAnalysis, activeSignalMarkers, chartViewKey, data, indicators, indicatorVisibility])

  const chartStatusMessage = chartEngineError
    ? `Chart unavailable: ${chartEngineError}`
    : loading
      ? 'Loading market candles...'
      : 'Loading chart engine...'
  const shouldShowChartOverlay = Boolean(chartEngineError) || loading || (data.length > 0 && !chartEngineReady)

  return (
    <Panel
      title={`${symbol} Chart | ${activeModel.name} Visuals`}
      className="min-h-[640px]"
      action={
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex flex-wrap gap-2">
            {indicatorItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onToggleIndicator(item.key)}
                className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] transition ${
                  indicatorVisibility[item.key]
                    ? 'border-sky-400/40 bg-sky-400/12 text-sky-200'
                    : 'border-white/10 bg-slate-950/70 text-slate-400'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={resetChartView}
              className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-slate-300 transition hover:border-sky-400/30 hover:text-sky-200"
            >
              Reset View
            </button>
            {intervals.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onChangeInterval(item)}
                className={`rounded-full px-3 py-1.5 text-xs transition ${
                  item === interval
                    ? 'bg-sky-400 text-slate-950'
                    : 'border border-white/10 bg-slate-950/70 text-slate-300'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      }
      contentClassName="space-y-4"
    >
      <div className="relative">
        <div ref={chartContainerRef} className="h-[540px] w-full" />
        {shouldShowChartOverlay ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-slate-950/35 px-6 text-center backdrop-blur-[2px]">
            <LoaderCircle className={`h-8 w-8 text-sky-300 ${chartEngineError ? '' : 'animate-spin'}`} />
            <div className="text-sm font-semibold text-white">{chartStatusMessage}</div>
            {!chartEngineError ? (
              <div className="max-w-md text-sm text-slate-400">
                The chart engine is being loaded separately so the rest of the workspace can render faster.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {footerContent ? (
        <div>{footerContent}</div>
      ) : null}

      <div className={`rounded-2xl border px-4 py-4 ${activeBotVisualSpec.panelTone}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] opacity-70">Chart Visual Mode</div>
            <div className="mt-2 text-sm font-semibold">{activeBotVisualSpec.title}</div>
            <div className="mt-2 text-sm opacity-90">{activeBotVisualSpec.detail}</div>
            <div className="mt-2 text-xs opacity-75">
              Drag the chart left to open scenario space on the right, then zoom into the section you want to inspect.
            </div>
          </div>
          <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${activeBotVisualSpec.badgeTone}`}>
            {activeBotVisualSpec.badge}
          </span>
        </div>

        {activeBotVisualSpec.legend.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {activeBotVisualSpec.legend.map((item) => (
              <span
                key={item.key}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em]"
              >
                <span className={`h-2.5 w-2.5 rounded-full ${item.chipClass}`} />
                {item.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className={`rounded-2xl border px-4 py-4 ${currentCandleSignalState.panelTone}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] opacity-70">Latest Confirmed Signal</div>
            <div className="mt-2 text-sm font-semibold">{currentCandleSignalState.title}</div>
            <div className="mt-2 text-sm opacity-90">{currentCandleSignalState.detail}</div>
          </div>
          <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${currentCandleSignalState.badgeTone}`}>
            {currentCandleSignalState.badge}
          </span>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
          {SIGNAL_MODELS.map((model) => {
            const analysis = modelAnalyses[model.id] || null
            const isActive = model.id === activeSignalModelId
            const tone = getModelTone(model, analysis, isActive)
            const directionMeta = getModelDirectionMeta(model, analysis)
            const stats = signalModelPerformance[model.id] || EMPTY_MODEL_STATS
            const signalSlots = getSignalSlots(model, analysis)
            const score = Number(analysis?.score || 0)
            const maxScore = Number(analysis?.maxScore || model.totalSignals || 0)
            const progressPercent = maxScore > 0 ? Math.max(0, Math.min(100, (score / maxScore) * 100)) : 0
            const pnl = Number(stats.pnl || 0)
            const pnlTone = pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-300'
            const hasProfessionalFilters = model.professionalSignalCount > 0 && analysis
            const aiMeta = getAiStatusMeta(analysis?.aiAdvisory || null)

            return (
              <div
                key={model.id}
                className={`rounded-2xl border px-4 py-3 backdrop-blur-md ${tone.card}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{model.name}</div>
                    <div className="mt-1 truncate text-sm font-semibold text-white">{model.tag}</div>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${tone.badge}`}>
                    {isActive ? 'Focus' : model.status}
                  </span>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${tone.badge}`}>
                    <directionMeta.Icon className="h-3.5 w-3.5" />
                    {directionMeta.label}
                  </span>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Live Score</div>
                    <div className="mt-1 text-sm font-semibold text-white">
                      {maxScore > 0 ? `${score}/${maxScore}` : '0/0'}
                    </div>
                  </div>
                </div>

                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all ${tone.fill}`}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>

                <div
                  className="mt-2 grid gap-1.5"
                  style={{ gridTemplateColumns: `repeat(${signalSlots.length || 1}, minmax(0, 1fr))` }}
                >
                  {signalSlots.map((signal) => (
                    <div
                      key={signal.key}
                      className={`h-1.5 rounded-full ${signal.passed ? tone.signalOn : tone.signalOff}`}
                    />
                  ))}
                </div>

                <div className="mt-3 text-xs text-slate-300">{getModelStatusLine(model, analysis)}</div>

                <div className={`mt-3 rounded-xl border px-3 py-3 ${aiMeta.tone}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] opacity-80">{aiMeta.label}</div>
                    <div className="text-[11px] font-semibold">{aiMeta.score}</div>
                  </div>
                  <div className="mt-2 text-[11px] leading-5 opacity-90">{aiMeta.detail}</div>
                  {analysis?.aiAdvisory?.policyLabel ? (
                    <div className="mt-2 text-[10px] uppercase tracking-[0.16em] opacity-70">
                      {analysis.aiAdvisory.policyLabel} • {analysis.aiAdvisory.datasetRows || 0} trained rows
                    </div>
                  ) : null}
                </div>

                <div className="mt-2 text-[11px] text-slate-500">Live bot status is shown above in direction and score. History shows the closed-trade win rate.</div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                  <div>
                    <div>History</div>
                    <div className="mt-1 text-slate-200">{formatWinRate(stats.winRate, stats.closedTrades)}</div>
                  </div>
                  <div className="text-right">
                    <div>PnL</div>
                    <div className={`mt-1 ${pnlTone}`}>{formatSignedUsdt(pnl)}</div>
                  </div>
                </div>

                {hasProfessionalFilters ? (
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                    <span>Professional filters</span>
                    <span className="font-medium text-slate-200">
                      {analysis.professionalSignalScore}/{model.professionalSignalCount}
                    </span>
                  </div>
                ) : null}

                {isActive && activeModelAnalysis?.ready && isFinitePrice(activeModelAnalysis.entryPrice) ? (
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                    <span>Live entry</span>
                    <span className="font-medium text-white">{formatPrice(activeModelAnalysis.entryPrice, 5)}</span>
                  </div>
                ) : null}
              </div>
            )
          })}
      </div>
    </Panel>
  )
}
