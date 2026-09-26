import { useMemo } from 'react'
import { TrendingUp, TrendingDown, Compass } from 'lucide-react'
import { Panel } from './Panel'
import { computeSixtyCandleForecast, intervalToMs, FORECAST_HORIZON_CANDLES } from '../lib/chartForecast'

const BOT_LABELS = {
  'model-1': 'Bot 1',
  'model-2': 'Bot 2',
  'model-3': 'Bot 3',
  'model-4': 'Bot 4',
  'model-5': 'Bot 5',
  'model-6': 'Bot 6',
  'model-7': 'Bot 7',
  'model-8': 'Bot 8',
  'model-9': 'Bot 9',
  'model-10': 'Consolidated Knowledge',
}

function formatHorizon(interval) {
  const totalMs = intervalToMs(interval) * FORECAST_HORIZON_CANDLES
  const hours = totalMs / (60 * 60_000)

  if (hours < 1) {
    return `${Math.round(totalMs / 60_000)}m`
  }
  if (hours < 48) {
    return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`
  }
  return `${(hours / 24).toFixed(1)}d`
}

function BotVoteRow({ bot, positive }) {
  const label = BOT_LABELS[bot.modelId] || bot.modelId
  const progress = bot.maxScore > 0 ? `${bot.score}/${bot.maxScore}` : '—'

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-slate-950/40 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${positive ? (bot.direction === 'LONG' ? 'bg-emerald-400' : 'bg-rose-400') : 'bg-slate-600'}`} />
        <span className="text-slate-200">{label}</span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ${
          bot.direction === 'LONG' ? 'bg-emerald-400/10 text-emerald-300' : bot.direction === 'SHORT' ? 'bg-rose-400/10 text-rose-300' : 'bg-slate-800 text-slate-400'
        }`}
        >
          {bot.direction}
        </span>
      </div>
      <span className="text-slate-500">{progress} · w {bot.weight.toFixed(2)}</span>
    </div>
  )
}

// The actual forecast line is drawn on CandlestickChart itself (see
// computeSixtyCandleForecast usage there); this panel is just the reasoning
// behind that line — which bots agree, and how confident the vote is.
export function ForecastPanel({ modelAnalyses, symbol, interval }) {
  const forecast = useMemo(() => computeSixtyCandleForecast(modelAnalyses), [modelAnalyses])
  const horizonLabel = useMemo(() => formatHorizon(interval), [interval])
  const isLong = forecast.direction === 'LONG'
  const hasDirection = forecast.direction === 'LONG' || forecast.direction === 'SHORT'

  return (
    <Panel
      title="60-Candle Forecast (Draft)"
      action={(
        hasDirection ? (
          <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${isLong ? 'bg-emerald-400/12 text-emerald-200' : 'bg-rose-400/15 text-rose-200'}`}>
            {isLong ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {forecast.direction} {forecast.percent.toFixed(2)}%
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            <Compass className="h-3.5 w-3.5" /> No consensus
          </span>
        )
      )}
    >
      <p className="text-sm leading-6 text-slate-300">
        Each colored line on the chart above (P1, P2, ...) is a weighted vote across every bot's
        current signal for <span className="text-white">{symbol}</span> at the moment it was drawn,
        projected {FORECAST_HORIZON_CANDLES} candles ahead (~{horizonLabel}). Readiness and
        checklist completion set each bot's weight; the percentage is the weighted-average distance
        from entry to take-profit among the bots that agree with the winning side. A new line is
        only added once the consensus direction flips or its percentage moves meaningfully — earlier
        predictions stay on the chart as a running record, so you can see how the call evolved. A
        hand-sketched line, not a validated price path.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-400">
        <span>Confidence <span className="text-white">{(forecast.confidence * 100).toFixed(0)}%</span> ({forecast.agreeingBots.length} of {forecast.allBots.length} bots agree)</span>
      </div>

      {forecast.allBots.length > 0 ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {[...forecast.agreeingBots, ...forecast.disagreeingBots, ...forecast.waitingBots].map((bot) => (
            <BotVoteRow key={bot.modelId} bot={bot} positive={bot.direction === forecast.direction} />
          ))}
        </div>
      ) : (
        <div className="mt-4 text-sm text-slate-500">No bot signals loaded yet for this symbol.</div>
      )}
    </Panel>
  )
}
