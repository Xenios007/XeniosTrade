import { ArrowRight, Check, Loader2, X } from 'lucide-react'
import { AI_TRADING_AGENTS } from '../lib/aiTrading'
import { formatDateTimeWithSeconds, formatPrice } from '../lib/formatters'
import { Badge } from './ui/Badge'
import { Panel } from './Panel'
import { ExecutionPanel } from './aiTrading/ExecutionPanel'
import { DECISION_TONE, label as decisionLabel } from './aiTrading/PositionManagerPanel'
import { StatCard } from './ui/StatCard'

const KIND_LABEL = { ai: 'AI', data: 'Data', code: 'Code' }
const KIND_TONE = { ai: 'info', data: 'neutral', code: 'warn' }

const STATUS_TONE = { ok: 'up', skipped: 'neutral', error: 'down', unconfigured: 'warn', pending: 'info', watching: 'info', closed: 'neutral', waiting: 'neutral' }
const STATUS_LABEL = { ok: 'Done', skipped: 'Skipped', error: 'Failed', unconfigured: 'No provider', pending: 'Running', watching: 'Watching', closed: 'Closed', waiting: 'After entry' }

const ACTION_TONE = { LONG: 'up', SHORT: 'down', HOLD: 'neutral' }
const VERDICT_TONE = { PASS: 'up', CAUTION: 'warn', REJECT: 'down', SUPPORTS: 'up', NEUTRAL: 'neutral', AGAINST: 'down' }
const SEVERITY_TONE = { low: 'neutral', medium: 'warn', high: 'down' }

const pct = (value, digits = 1) => (Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : 'n/a')
const signed = (value) => (Number(value) > 0 ? `+${value}` : `${value}`)
const num = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a')

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-right text-slate-200">{children}</span>
    </div>
  )
}

function Reasoning({ children }) {
  return children ? <p className="text-xs leading-relaxed text-slate-300">{children}</p> : null
}

/** The 5th step: the AI that manages the trade this run opened. It reads the trade record, not a run stage. */
function ManagerDetails({ stage }) {
  const { trade } = stage
  if (!trade) return <p className="text-xs leading-relaxed text-slate-500">{stage.summary}</p>
  const reviews = trade.managerReviews || []
  const latest = reviews[0]
  const isOpen = trade.status === 'OPEN'
  const stopMoved = trade.initialStopLoss != null && Number(trade.initialStopLoss) !== Number(trade.stopLoss)
  const targetMoved = trade.initialTakeProfit != null && Number(trade.initialTakeProfit) !== Number(trade.takeProfit ?? -1)

  return (
    <div className="grid gap-2">
      <Row label="Trade">{isOpen ? 'Open' : trade.closedBy === 'position-manager' ? 'Closed by the Position Manager' : 'Closed'}</Row>
      <Row label="Stop">{formatPrice(trade.stopLoss, 4)}{stopMoved ? ` (was ${formatPrice(trade.initialStopLoss, 4)})` : ''}</Row>
      <Row label="Target">{trade.takeProfit == null ? 'open-ended' : formatPrice(trade.takeProfit, 4)}{targetMoved && trade.initialTakeProfit ? ` (was ${formatPrice(trade.initialTakeProfit, 4)})` : ''}</Row>
      {latest ? (
        <>
          <Row label="Latest call"><Badge tone={DECISION_TONE[latest.decision] || 'neutral'}>{decisionLabel(latest.decision)}</Badge></Row>
          <Row label="Thesis confidence">{latest.thesisConfidence}%{trade.entryContext?.entryConfidence != null ? ` (entry ${trade.entryContext.entryConfidence}%)` : ''}</Row>
          {latest.rMultiple != null ? <Row label="Result at review">{num(latest.rMultiple)}R</Row> : null}
          <Reasoning>{latest.reason}</Reasoning>
          <p className="text-[11px] text-slate-500">{reviews.length} review{reviews.length > 1 ? 's' : ''} · full timeline on Trade History</p>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-slate-500">{isOpen ? 'No review yet — the first one runs about 5 minutes after entry.' : 'This trade was never reviewed.'}</p>
      )}
      {trade.managerLastError ? <p className="text-xs text-amber-200">Last review failed: {trade.managerLastError}</p> : null}
    </div>
  )
}

function StageDetails({ stage }) {
  if (stage.id === 'manager') return <ManagerDetails stage={stage} />
  const output = stage.output

  if (stage.status === 'error' || stage.status === 'unconfigured') {
    return <p className="text-xs leading-relaxed text-amber-200">{stage.error}</p>
  }
  if (stage.status === 'skipped' || !output) {
    return <p className="text-xs leading-relaxed text-slate-500">{stage.summary}</p>
  }

  switch (stage.id) {
    case 'analyst':
      return (
        <div className="grid gap-2">
          <Row label="Call"><Badge tone={ACTION_TONE[output.action]}>{output.action}</Badge></Row>
          <Row label="Confidence">{output.confidence}%</Row>
          <Row label="Regime">{output.regime}</Row>
          {output.action !== 'HOLD' ? (
            <Row label="Proposed stop / target">{num(output.stopLossPercent)}% / {num(output.takeProfitPercent)}%</Row>
          ) : null}
          {output.keyFactors.length ? (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-300">
              {output.keyFactors.map((factor) => <li key={factor}>{factor}</li>)}
            </ul>
          ) : null}
          <Reasoning>{output.reasoning}</Reasoning>
        </div>
      )
    case 'flow': {
      const m = output.metrics || {}
      const metricRows = [
        ['Funding', m.fundingRatePct == null ? null : `${m.fundingRatePct}% (${m.fundingAnnualizedPct}% annualised)`],
        ['Open interest 1h / 4h', m.oiChange1hPct == null ? null : `${signed(m.oiChange1hPct)}% / ${signed(m.oiChange4hPct)}%`],
        ['Price vs OI (1h)', m.oiPriceRegime],
        ['Long / short accounts', m.longShortRatio == null ? null : `${m.longShortRatio} (${m.longAccountPct}% long)`],
        ['Top traders L/S', m.topTraderLongShortRatio],
        ['Taker buy/sell (1h)', m.takerBuySellRatio1h],
        ['Book bid/ask depth', m.bookImbalance],
        ['BTC 1h / 4h', m.btcChange1hPct == null ? null : `${signed(m.btcChange1hPct)}% / ${signed(m.btcChange4hPct)}%`],
      ].filter(([, value]) => value != null)

      return (
        <div className="grid gap-2">
          <Row label="Verdict"><Badge tone={VERDICT_TONE[output.verdict]}>{output.verdict}</Badge></Row>
          {output.crowding ? <Row label="Crowding"><Badge tone={{ LOW: 'up', MEDIUM: 'warn', HIGH: 'down' }[output.crowding]}>{output.crowding}</Badge></Row> : null}
          {output.flags.map((item) => (
            <div key={item.issue} className="flex items-start gap-2 text-xs text-slate-300">
              <Badge tone={SEVERITY_TONE[item.severity]} className="shrink-0">{item.severity}</Badge>
              <span>{item.issue}</span>
            </div>
          ))}
          <Reasoning>{output.reasoning}</Reasoning>
          {metricRows.length ? (
            <div className="mt-1 grid gap-1.5 border-t border-white/10 pt-2">
              <span className="text-[10px] uppercase tracking-[0.2em] text-slate-600">Evidence it saw</span>
              {metricRows.map(([label, value]) => <Row key={label} label={label}>{value}</Row>)}
            </div>
          ) : null}
        </div>
      )
    }
    case 'critic':
      return (
        <div className="grid gap-2">
          <Row label="Verdict"><Badge tone={VERDICT_TONE[output.verdict]}>{output.verdict}</Badge></Row>
          {output.objections.map((item) => (
            <div key={item.issue} className="flex items-start gap-2 text-xs text-slate-300">
              <Badge tone={SEVERITY_TONE[item.severity]} className="shrink-0">{item.severity}</Badge>
              <span>{item.issue}</span>
            </div>
          ))}
          <Reasoning>{output.reasoning}</Reasoning>
        </div>
      )
    case 'risk':
      return (
        <div className="grid gap-2">
          <Row label="Result">
            <Badge tone={output.approved ? 'up' : 'down'}>{output.approved ? (output.reduced ? 'Reduced' : 'Approved') : 'Veto'}</Badge>
          </Row>
          {output.ai?.confidence != null ? <Row label="Entry confidence">{output.ai.confidence}%</Row> : null}
          {output.ai?.riskLevel ? (
            <Row label="Risk level">
              <Badge tone={output.ai.riskLevel === 'HIGH' ? 'down' : output.ai.riskLevel === 'LOW' ? 'info' : 'warn'}>{output.ai.riskLevel}</Badge>
            </Row>
          ) : null}
          {output.ai && ['APPROVE', 'REDUCE'].includes(output.ai.decision) ? (
            <Row label="Model asked for">
              {num(output.ai.stopLossPercent)}% stop · {num(output.ai.takeProfitPercent)}% target · {num(output.ai.riskPercent)}% risk · {num(output.ai.leverage, 0)}x
            </Row>
          ) : null}
          {output.plan ? (
            <>
              <Row label="Final stop / target">{num(output.plan.stopLossPct)}% / {num(output.plan.takeProfitPct)}% ({num(output.plan.rewardRisk)}R)</Row>
              <Row label="Notional">{num(output.plan.notionalUsdt)} USDT</Row>
              <Row label="Leverage / margin">{output.plan.leverage}x / {num(output.plan.marginUsdt)} USDT</Row>
              <Row label="Max loss">{num(output.plan.maxLossUsdt)} USDT ({num(output.plan.riskPctOfEquity)}% of equity)</Row>
            </>
          ) : null}
          {output.ai?.concerns?.length ? (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-300">
              {output.ai.concerns.map((concern) => <li key={concern}>{concern}</li>)}
            </ul>
          ) : null}
          {output.ai?.reasoning && output.approved ? <Reasoning>{output.ai.reasoning}</Reasoning> : null}
          {output.backtest?.available ? (
            <p className="text-[11px] leading-relaxed text-slate-500">
              Backtest background (not a gate): {num(output.backtest.expectedValueR)}R expected value over {output.backtest.sampleSize.toLocaleString()} similar trades from Bots 1–4.
            </p>
          ) : null}
          {output.vetoReasons.map((reason) => <p key={reason} className="text-xs leading-relaxed text-rose-200">{reason}</p>)}
          {output.adjustments.map((note) => <p key={note} className="text-[11px] leading-relaxed text-amber-200">Limit applied: {note}</p>)}
        </div>
      )
    default:
      return null
  }
}

function StageCard({ agent, stage, running }) {
  const status = running ? 'pending' : stage?.status || 'skipped'
  const modelLine = stage?.provider ? `${stage.provider}${stage.model ? ` · ${stage.model}` : ''}` : null

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold text-white">{agent.name}</span>
          <Badge tone={KIND_TONE[agent.kind]}>{KIND_LABEL[agent.kind]}</Badge>
          {agent.guardrail ? <Badge tone="warn">Limits in code</Badge> : null}
        </div>
        <Badge tone={STATUS_TONE[status]} className="shrink-0">
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {STATUS_LABEL[status]}
        </Badge>
      </div>
      {running || !stage ? (
        <p className="text-xs leading-relaxed text-slate-500">{agent.role}</p>
      ) : (
        <StageDetails stage={stage} />
      )}
      {stage && !running && (modelLine || stage.durationMs > 0) ? (
        <div className="mt-auto truncate border-t border-white/10 pt-2 text-[11px] text-slate-500">
          {[modelLine, stage.durationMs >= 1 ? `${(stage.durationMs / 1000).toFixed(1)}s` : null].filter(Boolean).join(' · ')}
        </div>
      ) : null}
    </div>
  )
}

const DOT_TONE = {
  watching: 'bg-sky-400',
  closed: 'bg-slate-500',
  waiting: 'bg-slate-600',
  ok: 'bg-emerald-400',
  skipped: 'bg-slate-600',
  error: 'bg-rose-400',
  unconfigured: 'bg-amber-400',
  pending: 'bg-sky-400 animate-pulse',
}

function FlowNode({ label, tone = 'neutral', dot }) {
  const toneClass = {
    up: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    down: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
    neutral: 'border-white/10 bg-slate-950/60 text-slate-300',
  }[tone]

  return (
    <div className={`flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-semibold ${toneClass}`}>
      {dot ? <span className={`h-2 w-2 rounded-full ${dot}`} /> : null}
      {label}
    </div>
  )
}

/** Market Data -> 4 entry agents -> Trade / No Trade, then one detail card per stage. Pass `run={null}` for the idle diagram. */
// The 5th step. It is not a stage of the run: it manages the trade this run opened, so its state comes from that trade.
function managerStageFor(run, trade) {
  if (trade) return { id: 'manager', status: trade.status === 'OPEN' ? 'watching' : 'closed', trade }
  if (!run) return { id: 'manager', status: 'waiting', summary: 'Starts once a trade is open, then re-reads it every 5 minutes.' }
  if (run.execution?.status === 'opened') return { id: 'manager', status: 'watching', summary: 'Trade opened. The first review runs about 5 minutes after entry.' }
  if (run.final?.approved) return { id: 'manager', status: 'waiting', summary: 'Approved, but the trade has not been opened yet. The Position Manager starts once it is.' }
  return { id: 'manager', status: 'skipped', summary: 'No trade was opened, so there is nothing to manage.' }
}

/**
 * Market Data -> Analyst -> Flow -> Critic -> Risk Manager -> Position Manager, then one detail card per step. Pass `run={null}`
 * for the idle diagram, and the run's `trade` (from the AI ledger) to show how the Position Manager is handling it. Older saved
 * runs may carry a retired Decision (or Quant) stage; it is not displayed.
 */
export function PipelineFlow({ run, running, trade = null }) {
  const stageFor = (agent) => (agent.id === 'manager' ? managerStageFor(run, trade) : run?.stages.find((item) => item.id === agent.id))
  // While a run is in progress the first four steps show as running; the Position Manager only starts after entry.
  const isRunning = (agent) => running && agent.id !== 'manager'

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <FlowNode label="Market Data" />
        {AI_TRADING_AGENTS.map((agent) => {
          const stage = stageFor(agent)
          return (
            <div key={agent.id} className="flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-slate-600" />
              <FlowNode label={agent.name} dot={DOT_TONE[isRunning(agent) ? 'pending' : stage?.status || 'skipped']} />
            </div>
          )
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {AI_TRADING_AGENTS.map((agent) => (
          <StageCard key={agent.id} agent={agent} stage={stageFor(agent)} running={isRunning(agent)} />
        ))}
      </div>
    </div>
  )
}

// Gates a run can carry today; older runs also have a retired 'decision' gate that is not shown.
const SHOWN_GATE_IDS = ['analyst', 'flow', 'critic', 'risk']

function Gates({ gates }) {
  const shown = (gates || []).filter((gate) => SHOWN_GATE_IDS.includes(gate.id))
  if (!shown.length) return null
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {shown.map((gate) => (
        <li key={gate.id} className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2.5">
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${gate.passed ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300'}`}>
            {gate.passed ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
          </span>
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-200">{gate.label}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{gate.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function Verdict({ run, execution, onExecuted }) {
  const { final } = run
  const tone = final.approved ? (final.action === 'LONG' ? 'up' : 'down') : 'default'
  const trade = final.trade

  return (
    <Panel title="Verdict">
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={final.approved ? ACTION_TONE[final.action] : 'neutral'} className="px-4 py-1.5 text-sm">
            {final.approved ? `Trade ${final.action}` : 'No trade · HOLD'}
          </Badge>
          <span className="text-sm text-slate-400">
            {run.symbol} at {formatPrice(run.price, 4)} · {formatDateTimeWithSeconds(run.startedAt)}
          </span>
        </div>
        {final.reason ? <p className="max-w-3xl text-sm leading-relaxed text-slate-300">{final.reason}</p> : null}

        {trade ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Entry" value={formatPrice(trade.entryPrice, 4)} sublabel={trade.side} tone={tone} />
            <StatCard label="Stop-loss" value={formatPrice(trade.stopLoss, 4)} sublabel={`${num(trade.stopLossPct)}% away`} tone="down" />
            <StatCard label="Take-profit" value={formatPrice(trade.takeProfit, 4)} sublabel={`${num(trade.takeProfitPct)}% · ${num(trade.rewardRisk)}R`} tone="up" />
            <StatCard label="Max loss" value={`${num(trade.maxLossUsdt)} USDT`} sublabel={`${num(trade.riskPctOfEquity)}% of equity`} tone="warn" />
            <StatCard label="Notional" value={`${num(trade.notionalUsdt, 0)} USDT`} sublabel={`qty ${Number(trade.quantity).toPrecision(4)}`} />
            <StatCard label="Leverage" value={`${trade.leverage}x`} sublabel={`${num(trade.marginUsdt)} USDT margin`} />
          </div>
        ) : null}

        <Gates gates={final.gates} />

        <ExecutionPanel run={run} execution={execution} onExecuted={onExecuted} />

        <p className="text-[11px] leading-relaxed text-slate-500">
          The pipeline itself never places an order. Approval means every gate above passed, including a deterministic
          Risk Manager sizing check; it is not a prediction that the trade will win. A trade only opens on the AI wallets
          (testnet automatically if enabled, real money only by your explicit confirmation).
        </p>
      </div>
    </Panel>
  )
}

export function AiTradingRunReport({ run, running = false, execution = null, onExecuted = null, trades = [] }) {
  const trade = run?.execution?.tradeId ? trades.find((item) => item.id === run.execution.tradeId) || null : null
  return (
    <div className="grid gap-6">
      {run && !running ? <Verdict run={run} execution={execution} onExecuted={onExecuted} /> : null}
      <Panel title="Pipeline">
        <PipelineFlow run={running ? null : run} running={running} trade={running ? null : trade} />
      </Panel>
    </div>
  )
}
