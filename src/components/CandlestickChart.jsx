import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { formatPrice } from '../lib/formatters'
import { calculateEMA, calculateSMA, calculateVWAP } from '../lib/indicators'
import { getSignalModel } from '../lib/signalModels'
import { computeSixtyCandleForecast, buildForecastWavePoints, intervalToMs, FORECAST_HORIZON_CANDLES } from '../lib/chartForecast'
import { Panel } from './Panel'

const intervals = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]
const indicatorItems = [
  { key: 'ema', label: 'EMA 12' },
  { key: 'ma', label: 'MA 20' },
  { key: 'bb', label: 'BB 20,2' },
  { key: 'rsi', label: 'RSI 14' },
]
// Reserves horizontal room to the right of the latest candle so the
// in-chart forecast line (drawn out to FORECAST_HORIZON_CANDLES) is visible
// without the user having to scroll.
const CHART_SCENARIO_RIGHT_OFFSET = FORECAST_HORIZON_CANDLES + 4
// The forecast's underlying bot signals re-poll every 15s (App.jsx) and their
// entry/take-profit levels track live price, so the percent shifts by tiny
// amounts almost every poll. A new prediction line (P1, P2, ...) is only
// drawn once the consensus has actually moved by this much or flipped
// direction - not on every tiny live-price wiggle.
const FORECAST_REDRAW_PERCENT_THRESHOLD = 0.15
// Each new prediction gets the next color in this palette (cycling), purely
// so P1/P2/P3/... stay visually distinguishable from each other on the chart
// - the color carries no other meaning.
const FORECAST_COLOR_PALETTE = ['#f59e0b', '#38bdf8', '#a78bfa', '#fb7185', '#34d399', '#f472b6', '#facc15', '#22d3ee']
// Caps how many prediction lines stay on the chart at once - the oldest is
// removed as a new one is added past this. Matches the palette length so
// every prediction visible at any moment has a genuinely distinct color.
// P-numbers themselves keep counting up forever and are never reused, even
// once their line has been evicted.
const FORECAST_MAX_VISIBLE_PREDICTIONS = FORECAST_COLOR_PALETTE.length

function isFinitePrice(value) {
  return Number.isFinite(Number(value))
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
  chartPatterns = [],
}) {
  const chartContainerRef = useRef(null)
  const chartApiRef = useRef(null)
  const chartRuntimeRef = useRef(null)
  const seriesRef = useRef({})
  const markersPrimitiveRef = useRef(null)
  const botSeriesRef = useRef([])
  const botSeriesModelRef = useRef('')
  const tradePriceLinesRef = useRef([])
  const rsiPriceLinesRef = useRef([])
  const patternSeriesRef = useRef([])
  const patternSigRef = useRef('')
  // Every prediction ever drawn for the current symbol/interval, oldest
  // first - each is a frozen snapshot (its own series), never mutated after
  // creation. Reset only on a symbol/interval change (see chartViewKey effect).
  const predictionsRef = useRef([])
  const predictionCounterRef = useRef(0)
  const didFitRef = useRef(false)
  const prevViewKeyRef = useRef('')
  const [chartEngineReady, setChartEngineReady] = useState(false)
  const [chartEngineError, setChartEngineError] = useState('')
  const activeModel = useMemo(() => getSignalModel(activeSignalModelId), [activeSignalModelId])
  const activeModelAnalysis = modelAnalyses[activeSignalModelId] || null
  const activeSignalMarkers = useMemo(
    () => buildActiveSignalMarkers(data, activeModelAnalysis),
    [data, activeModelAnalysis],
  )
  const allMarkers = useMemo(() => {
    const patternMarkers = chartPatterns
      .filter((pattern) => pattern.marker)
      .map((pattern) => pattern.marker)
    return [...activeSignalMarkers, ...patternMarkers].sort((a, b) => a.time - b.time)
  }, [activeSignalMarkers, chartPatterns])
  const patternSignature = useMemo(
    () => chartPatterns.map((pattern) => pattern.id).join('|'),
    [chartPatterns],
  )
  const forecast = useMemo(() => computeSixtyCandleForecast(modelAnalyses), [modelAnalyses])
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
    chartApiRef.current?.timeScale().fitContent()
  }

  // Create the chart and its base series exactly once. Everything after this
  // is an incremental update on the existing chart instance, so the user's
  // pan/zoom is never thrown away by a streaming candle update.
  useEffect(() => {
    if (!chartContainerRef.current) {
      return undefined
    }

    let disposed = false
    let cleanup = () => {}

    async function bootChart() {
      try {
        setChartEngineError('')

        if (!chartRuntimeRef.current) {
          chartRuntimeRef.current = await import('lightweight-charts')
        }

        if (disposed || !chartContainerRef.current || chartApiRef.current) {
          return
        }

        const { CandlestickSeries, CrosshairMode, LineSeries, createChart } = chartRuntimeRef.current

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

        const candle = chart.addSeries(CandlestickSeries, {
          upColor: '#22c55e',
          downColor: '#f43f5e',
          borderVisible: false,
          wickUpColor: '#22c55e',
          wickDownColor: '#f43f5e',
        })
        const ema = chart.addSeries(LineSeries, {
          color: '#38bdf8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        })
        const ma = chart.addSeries(LineSeries, {
          color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        })
        const bbUpper = chart.addSeries(LineSeries, {
          color: 'rgba(148, 163, 184, 0.7)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false,
        })
        const bbBasis = chart.addSeries(LineSeries, {
          color: 'rgba(244, 114, 182, 0.9)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        })
        const bbLower = chart.addSeries(LineSeries, {
          color: 'rgba(148, 163, 184, 0.7)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false,
        })
        const rsi = chart.addSeries(LineSeries, {
          color: '#a78bfa', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        }, 1)

        seriesRef.current = { candle, ema, ma, bbUpper, bbBasis, bbLower, rsi }

        const panes = chart.panes()
        if (panes[0]) {
          panes[0].setHeight(360)
        }
        if (panes[1]) {
          panes[1].setHeight(140)
        }

        didFitRef.current = false
        prevViewKeyRef.current = ''
        setChartEngineReady(true)

        cleanup = () => {
          setChartEngineReady(false)
          chartApiRef.current = null
          seriesRef.current = {}
          markersPrimitiveRef.current = null
          botSeriesRef.current = []
          botSeriesModelRef.current = ''
          tradePriceLinesRef.current = []
          rsiPriceLinesRef.current = []
          patternSeriesRef.current = []
          patternSigRef.current = ''
          predictionsRef.current = []
          predictionCounterRef.current = 0
          chart.remove()
        }
      } catch (error) {
        if (!disposed) {
          setChartEngineError(error instanceof Error ? error.message : 'Unable to load chart engine')
        }
      }
    }

    bootChart()

    return () => {
      disposed = true
      cleanup()
    }
  }, [])

  // Candle data. fitContent() runs once per symbol/interval, after that
  // symbol's fresh candles have loaded - never on a plain streaming update,
  // so the user's pan/zoom is preserved while they read the chart.
  useEffect(() => {
    const candle = seriesRef.current.candle
    if (!chartEngineReady || !candle) {
      return
    }

    if (prevViewKeyRef.current !== chartViewKey) {
      prevViewKeyRef.current = chartViewKey
      didFitRef.current = false

      // A prediction's wave is drawn in this symbol/interval's own time and
      // price space, so it doesn't carry over to a different market or timeframe.
      const chart = chartApiRef.current
      predictionsRef.current.forEach(({ series }) => {
        try {
          chart?.removeSeries(series)
        } catch {
          // already detached
        }
      })
      predictionsRef.current = []
      predictionCounterRef.current = 0
    }

    candle.setData(data)

    if (data.length > 0 && !didFitRef.current && !loading) {
      chartApiRef.current?.timeScale().fitContent()
      didFitRef.current = true
    }
  }, [data, chartViewKey, chartEngineReady, loading])

  // Draft 60-candle forecast lines: every time the weighted bot-signal
  // consensus (computeSixtyCandleForecast) genuinely changes - a direction
  // flip, or the percent moving by FORECAST_REDRAW_PERCENT_THRESHOLD or more
  // since the last one - a NEW hand-sketched wave is added as P{n}, labelled
  // with its percent and colored from FORECAST_COLOR_PALETTE. Predictions are
  // never mutated once drawn, only evicted oldest-first past
  // FORECAST_MAX_VISIBLE_PREDICTIONS (or all at once on a symbol/interval
  // change - see the chartViewKey effect above), so the chart keeps a
  // running, bounded visual record of the most recent predictions made.
  useEffect(() => {
    const chart = chartApiRef.current
    const runtime = chartRuntimeRef.current
    if (!chartEngineReady || !chart || !runtime?.LineSeries || !forecast.direction) {
      return
    }

    const latestCandle = data[data.length - 1]
    if (!latestCandle) {
      return
    }

    const existing = predictionsRef.current
    const last = existing[existing.length - 1] || null
    const percentMoved = !last || Math.abs(forecast.percent - last.percent) >= FORECAST_REDRAW_PERCENT_THRESHOLD
    const isNewPrediction = !last || last.direction !== forecast.direction || percentMoved

    if (!isNewPrediction) {
      return
    }

    const predictionNumber = predictionCounterRef.current + 1
    predictionCounterRef.current = predictionNumber
    const isLong = forecast.direction === 'LONG'
    const horizonSeconds = Math.round((intervalToMs(interval) * FORECAST_HORIZON_CANDLES) / 1000)
    const wavePoints = buildForecastWavePoints({
      startTime: latestCandle.time,
      startPrice: latestCandle.close,
      horizonSeconds,
      direction: forecast.direction,
      percent: forecast.percent,
    })
    const color = FORECAST_COLOR_PALETTE[(predictionNumber - 1) % FORECAST_COLOR_PALETTE.length]

    const series = chart.addSeries(runtime.LineSeries, {
      color,
      lineWidth: 3,
      lineStyle: 0,
      lineType: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: `P${predictionNumber} ${isLong ? '+' : '-'}${forecast.percent.toFixed(2)}%`,
    })
    series.setData(wavePoints)

    const nextPredictions = [...existing, {
      series,
      direction: forecast.direction,
      percent: forecast.percent,
      time: latestCandle.time,
    }]
    while (nextPredictions.length > FORECAST_MAX_VISIBLE_PREDICTIONS) {
      const evicted = nextPredictions.shift()
      try {
        chart.removeSeries(evicted.series)
      } catch {
        // already detached
      }
    }
    predictionsRef.current = nextPredictions
  }, [forecast.direction, forecast.percent, data, interval, chartEngineReady])

  // Indicator overlays + RSI guide lines.
  useEffect(() => {
    const s = seriesRef.current
    if (!chartEngineReady || !s.candle) {
      return
    }

    s.ema.setData(indicatorVisibility.ema ? indicators.ema : [])
    s.ma.setData(indicatorVisibility.ma ? indicators.ma : [])
    s.bbUpper.setData(indicatorVisibility.bb ? indicators.bollinger.upper : [])
    s.bbBasis.setData(indicatorVisibility.bb ? indicators.bollinger.basis : [])
    s.bbLower.setData(indicatorVisibility.bb ? indicators.bollinger.lower : [])
    s.rsi.setData(indicatorVisibility.rsi ? indicators.rsi : [])

    rsiPriceLinesRef.current.forEach((line) => s.rsi.removePriceLine(line))
    rsiPriceLinesRef.current = []
    if (indicatorVisibility.rsi) {
      rsiPriceLinesRef.current.push(s.rsi.createPriceLine({
        price: 70, color: 'rgba(244, 63, 94, 0.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'RSI 70',
      }))
      rsiPriceLinesRef.current.push(s.rsi.createPriceLine({
        price: 30, color: 'rgba(34, 197, 94, 0.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'RSI 30',
      }))
    }
  }, [indicators, indicatorVisibility, chartEngineReady])

  // Confirmed-signal + detected-pattern markers on the candle series.
  useEffect(() => {
    const candle = seriesRef.current.candle
    const runtime = chartRuntimeRef.current
    if (!chartEngineReady || !candle || !runtime?.createSeriesMarkers) {
      return
    }

    if (!markersPrimitiveRef.current) {
      markersPrimitiveRef.current = runtime.createSeriesMarkers(candle, allMarkers, {
        autoScale: true,
        zOrder: 'aboveSeries',
      })
    } else {
      markersPrimitiveRef.current.setMarkers(allMarkers)
    }
  }, [allMarkers, chartEngineReady])

  // Geometric chart-pattern overlays (necklines, trendlines, pattern outlines).
  // Rebuilt only when the detected set changes, not on every streaming tick.
  useEffect(() => {
    const chart = chartApiRef.current
    const runtime = chartRuntimeRef.current
    if (!chartEngineReady || !chart || !runtime?.LineSeries) {
      return
    }

    if (patternSigRef.current === patternSignature) {
      return
    }
    patternSigRef.current = patternSignature

    patternSeriesRef.current.forEach((series) => {
      try {
        chart.removeSeries(series)
      } catch {
        // already detached
      }
    })

    const nextSeries = []
    for (const pattern of chartPatterns) {
      for (const line of pattern.lines || []) {
        if (!line.points || line.points.length < 2) continue
        const series = chart.addSeries(runtime.LineSeries, {
          color: line.color,
          lineWidth: line.lineWidth || 1,
          lineStyle: line.lineStyle ?? 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        })
        series.setData(
          line.points
            .slice()
            .sort((a, b) => a.time - b.time)
            .filter((point, index, arr) => index === 0 || point.time !== arr[index - 1].time),
        )
        nextSeries.push(series)
      }
    }
    patternSeriesRef.current = nextSeries
  }, [patternSignature, chartPatterns, chartEngineReady])

  // Per-bot visual overlay lines (EMA 9 / VWAP / etc.). The spec's options are
  // static per bot, so when only the point data changed (every streaming tick)
  // we reuse the existing series and just push new data.
  useEffect(() => {
    const chart = chartApiRef.current
    const runtime = chartRuntimeRef.current
    if (!chartEngineReady || !chart || !runtime?.LineSeries) {
      return
    }

    const specs = activeBotVisualSpec.series
    if (
      botSeriesModelRef.current === activeModel.id
      && botSeriesRef.current.length === specs.length
    ) {
      specs.forEach((spec, index) => botSeriesRef.current[index].setData(spec.data))
      return
    }

    botSeriesRef.current.forEach((series) => {
      try {
        chart.removeSeries(series)
      } catch {
        // series already detached
      }
    })
    botSeriesRef.current = specs.map((spec) => {
      const series = chart.addSeries(runtime.LineSeries, spec.options)
      series.setData(spec.data)
      return series
    })
    botSeriesModelRef.current = activeModel.id
  }, [activeBotVisualSpec.series, activeModel.id, chartEngineReady])

  // Trade projection lines: entry / stop / target / support / resistance.
  // Shown whenever the bot has priced them, dashed until the setup is ready
  // so you can see how the trade would play out before it triggers.
  useEffect(() => {
    const candle = seriesRef.current.candle
    if (!chartEngineReady || !candle) {
      return
    }

    tradePriceLinesRef.current.forEach((line) => candle.removePriceLine(line))
    tradePriceLinesRef.current = []

    const analysis = activeModelAnalysis
    if (!analysis) {
      return
    }

    const ready = Boolean(analysis.ready)
    const isShort = analysis.checklistSide === 'SHORT'
    const add = (options) => {
      tradePriceLinesRef.current.push(candle.createPriceLine(options))
    }

    if (isFinitePrice(analysis.support)) {
      add({
        price: Number(analysis.support),
        color: 'rgba(56, 189, 248, 0.55)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: activeModel.id === 'model-3' ? `${activeModel.name} Structure Low` : `${activeModel.name} Support`,
      })
    }

    if (isFinitePrice(analysis.resistance)) {
      add({
        price: Number(analysis.resistance),
        color: 'rgba(245, 158, 11, 0.55)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: activeModel.id === 'model-3' ? `${activeModel.name} Structure High` : `${activeModel.name} Resistance`,
      })
    }

    if (isFinitePrice(analysis.entryPrice)) {
      add({
        price: Number(analysis.entryPrice),
        color: ready
          ? (isShort ? 'rgba(244, 63, 94, 0.95)' : 'rgba(34, 197, 94, 0.95)')
          : 'rgba(125, 211, 252, 0.9)',
        lineWidth: 2,
        lineStyle: ready ? 0 : 2,
        axisLabelVisible: true,
        title: ready ? `${activeModel.name} Entry` : `${activeModel.name} Entry (projected)`,
      })
    }

    if (isFinitePrice(analysis.stopLoss)) {
      add({
        price: Number(analysis.stopLoss),
        color: ready ? 'rgba(248, 113, 113, 0.9)' : 'rgba(248, 113, 113, 0.6)',
        lineWidth: ready ? 2 : 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: ready ? 'Stop Loss' : 'Stop Loss (projected)',
      })
    }

    if (isFinitePrice(analysis.takeProfit)) {
      add({
        price: Number(analysis.takeProfit),
        color: ready ? 'rgba(74, 222, 128, 0.9)' : 'rgba(74, 222, 128, 0.6)',
        lineWidth: ready ? 2 : 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: ready ? 'Take Profit' : 'Take Profit (projected)',
      })
    }
  }, [activeModelAnalysis, activeModel.id, activeModel.name, chartEngineReady])

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
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={resetChartView}
              className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-slate-300 transition hover:border-sky-400/30 hover:text-sky-200"
            >
              Reset View
            </button>
            <label className="relative">
              <span className="sr-only">Chart timeframe</span>
              <select
                value={interval}
                onChange={(event) => onChangeInterval(event.target.value)}
                className="appearance-none rounded-full border border-sky-400/40 bg-sky-400/12 py-1.5 pl-3 pr-8 text-xs font-semibold text-sky-100 outline-none transition focus:border-sky-300/60 focus:ring-2 focus:ring-sky-400/20"
              >
                {intervals.map((item) => (
                  <option key={item} value={item} className="bg-slate-900 text-white">
                    {item}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sky-200" />
            </label>
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

      <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Chart Patterns Detected</div>
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-400">
            {chartPatterns.length} found
          </span>
        </div>

        {chartPatterns.length === 0 ? (
          <div className="mt-3 text-sm text-slate-400">No recognised candlestick or chart pattern in the visible range.</div>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {chartPatterns.map((pattern) => {
              const tone = pattern.bias === 'bullish'
                ? 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-100'
                : pattern.bias === 'bearish'
                  ? 'border-rose-400/25 bg-rose-400/[0.07] text-rose-100'
                  : 'border-sky-400/25 bg-sky-400/[0.07] text-sky-100'
              return (
                <div key={pattern.id} className={`rounded-xl border px-3 py-2.5 ${tone}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{pattern.name}</span>
                    <span className="text-[10px] uppercase tracking-[0.18em] opacity-80">
                      {pattern.bias} · {Math.round(pattern.confidence * 100)}%
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] uppercase tracking-[0.14em] opacity-70">
                    {pattern.category === 'candlestick' ? 'Candlestick' : 'Chart pattern'}
                  </div>
                  <div className="mt-1 text-xs leading-5 opacity-90">{pattern.detail}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Panel>
  )
}
