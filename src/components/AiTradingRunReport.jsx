import { ArrowRight, Check, Loader2, X } from 'lucide-react'
import { AI_TRADING_AGENTS, AI_TRADING_ENTRY_STAGE_IDS, AI_TRADING_STAGE_NAMES } from '../lib/aiTrading'
import { formatDateTimeWithSeconds, formatPrice } from '../lib/formatters'
import { Badge } from './ui/Badge'
import { Panel } from './Panel'
import { ExecutionPanel } from './aiTrading/ExecutionPanel'
import { StatCard } from './ui/StatCard'

// The entry pipeline's agents. The Position Manager works after entry and is not a stage of a run.
const ENTRY_AGENTS = AI_TRADING_AGENTS.filter((agent) => AI_TRADING_ENTRY_STAGE_IDS.includes(agent.id))

const KIND_LABEL = { ai: 'AI', data: 'Data', code: 'Code' }
const KIND_TONE = { ai: 'info', data: 'neutral', code: 'warn' }

const STATUS_TONE = { ok: 'up', skipped: 'neutral', error: 'down', unconfigured: 'warn', pending: 'info' }
const STATUS_LABEL = { ok: 'Done', skipped: 'Skipped', error: 'Failed', unconfigured: 'No provider', pending: 'Running' }

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

function StageDetails({ stage }) {
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
    case 'decision':
      return (
        <div className="grid gap-2">
          <Row label="Decision"><Badge tone={ACTION_TONE[output.decision]}>{output.decision}</Badge></Row>
          <Row label="Confidence">{output.confidence}%</Row>
          <Reasoning>{output.reasoning}</Reasoning>
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

/** Market Data -> 4 entry agents -> Trade / No Trade (-> Position Manager), then one detail card per stage. Pass `run={null}` for the idle diagram. */
export function PipelineFlow({ run, running }) {
  // Runs saved before the Decision Agent was retired still show that stage, so old history stays readable.
  const legacyStages = (run?.stages || []).filter((stage) => !AI_TRADING_ENTRY_STAGE_IDS.includes(stage.id))
  const legacyAgents = legacyStages.map((stage) => ({ id: stage.id, name: AI_TRADING_STAGE_NAMES[stage.id] || stage.name || stage.id, kind: 'ai', role: 'Retired agent, shown for this older run.' }))
  const agents = [...ENTRY_AGENTS, ...legacyAgents]
  const finalTone = !run || running ? 'neutral' : run.final.approved ? (run.final.action === 'LONG' ? 'up' : 'down') : 'neutral'
  const finalLabel = !run || running ? 'Trade / No Trade' : run.final.approved ? `Trade ${run.final.action}` : 'No Trade'

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <FlowNode label="Market Data" />
        {agents.map((agent) => {
          const stage = run?.stages.find((item) => item.id === agent.id)
          return (
            <div key={agent.id} className="flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-slate-600" />
              <FlowNode label={agent.name} dot={DOT_TONE[running ? 'pending' : stage?.status || 'skipped']} />
            </div>
          )
        })}
        <ArrowRight className="h-4 w-4 text-slate-600" />
        <FlowNode label={finalLabel} tone={finalTone} />
        <ArrowRight className="h-4 w-4 text-slate-600" />
        <FlowNode label="Position Manager (after entry)" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {agents.map((agent) => (
          <StageCard key={agent.id} agent={agent} stage={run?.stages.find((stage) => stage.id === agent.id)} running={running} />
        ))}
      </div>
    </div>
  )
}

function Gates({ gates }) {
  if (!gates?.length) return null
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {gates.map((gate) => (
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

export function AiTradingRunReport({ run, running = false, execution = null, onExecuted = null }) {
  return (
    <div className="grid gap-6">
      {run && !running ? <Verdict run={run} execution={execution} onExecuted={onExecuted} /> : null}
      <Panel title="Pipeline">
        <PipelineFlow run={running ? null : run} running={running} />
      </Panel>
    </div>
  )
}
