// Combined cross-run report: RUN 1 (primary training) + RUNS 2-7 (validation).
// Combines RESULT SUMMARIES only — never training samples.
//
//   node server/backtest/combined-report.js
//   -> server/backtest/reports/COMBINED-validation-report.md

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  metrics, groupBy, mdTable, stdev, yearOf, splitFriction, n2, n4,
} from './report-lib.js'
import { readRunRows } from './ndjson.js'
import { getSignalModel, getSignalModelName, SIGNAL_MODELS } from '../../src/lib/signalModels.js'
import { spawnSync } from 'node:child_process'

// Reading every run's rows can exceed 2 GB — re-exec with a larger V8 heap.
if (!process.env.__HEAP_BOOSTED && !process.execArgv.some((a) => a.startsWith('--max-old-space-size'))) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, __HEAP_BOOSTED: '1' },
  })
  process.exit(r.status ?? 0)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const OUT = path.join(__dirname, 'reports', 'COMBINED-validation-report.md')

const readJson = async (p, d = null) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }

const RUNS = [
  { key: 'RUN 1', id: 'primary-8bot-5yr', kind: 'primary-training', fee: 5, slip: 2, note: 'stride 2, features, PRIMARY training dataset' },
  { key: 'RUN 2', id: 'validation-stress-5y-20symbols-8bots-5fee-5slip', kind: 'validation', fee: 5, slip: 5, note: 'moderate execution stress' },
  { key: 'RUN 3', id: 'validation-high-stress-5y-20symbols-8bots-7fee-10slip', kind: 'validation', fee: 7, slip: 10, note: 'high execution stress' },
  { key: 'RUN 4', id: 'validation-strict-context-5y-20symbols-8bots', kind: 'validation', fee: 5, slip: 3, note: 'strict historical context (no proxy order-book / funding)' },
  { key: 'RUN 5', id: 'validation-core-12symbols-5y-8bots', kind: 'validation', fee: 5, slip: 3, note: 'core 12-symbol market' },
  { key: 'RUN 6', id: 'validation-extended-8symbols-8bots', kind: 'validation', fee: 5, slip: 3, note: 'extended / high-beta 8-symbol' },
  { key: 'RUN 7', id: 'validation-unseen-symbol-generalization', kind: 'validation+experimental', fee: 5, slip: 3, note: 'unseen-symbol generalization; own experimental model' },
]
const BOTS = SIGNAL_MODELS.map((m) => m.id)

async function loadRun(spec) {
  const rows = await readRunRows(dataDir, spec.id)
  const reg = await readJson(path.join(dataDir, 'backtest-runs.json'), [])
  const entry = (reg || []).find((r) => r.id === spec.id) || {}
  return { ...spec, rows: Array.isArray(rows) ? rows : [], entry }
}

function botMetricsBlock(rows, feeBps, slipBps) {
  const out = {}
  for (const id of BOTS) {
    const sub = rows.filter((r) => r.signalModelId === id)
    if (!sub.length) { out[id] = null; continue }
    const oos = sub.filter((r) => r.split === 'holdout')
    const mAll = metrics(sub)
    const mOos = metrics(oos)
    const fAll = splitFriction(mAll.frictionUsd, feeBps, slipBps)
    out[id] = { all: { ...mAll, ...fAll }, oos: { ...mOos, ...splitFriction(mOos.frictionUsd, feeBps, slipBps) } }
  }
  return out
}

function line(...s) { return s.join('') }

async function main() {
  const runs = []
  for (const spec of RUNS) runs.push(await loadRun(spec))
  const present = runs.filter((r) => r.rows.length > 0)
  const run1 = runs.find((r) => r.id === 'primary-8bot-5yr')
  const primaryArtifact = await readJson(path.join(dataDir, 'learning-bot-train-artifact.json'), null)
  const run7Artifact = await readJson(path.join(dataDir, 'ai-training', 'run7-experimental', 'artifact.json'), null)

  const L = []
  const P = (...s) => L.push(line(...s))

  P('# XeniosTrade — combined 8-bot backtest & validation report')
  P('')
  P(`- Generated: ${new Date().toISOString()}`)
  P(`- Runs present: ${present.map((r) => r.key).join(', ') || 'none'}`)
  P(`- Primary training artifact: ${primaryArtifact?.ok ? `${primaryArtifact.metrics?.framework} on ${primaryArtifact.metrics?.deviceUsed}, leakage check ${primaryArtifact.metrics?.leakageCheck?.passed}` : 'not available'}`)
  P(`- RUN 7 experimental artifact: ${run7Artifact?.ok ? `${run7Artifact.metrics?.framework} on ${run7Artifact.metrics?.deviceUsed}` : 'not available'}`)
  P('')
  P('> Result summaries only. RUNS 2-7 training samples were **never** merged into the primary model.')
  P('> Winners are chosen on untouched out-of-sample expectancy, profit factor after costs, drawdown,')
  P('> and cross-symbol / cross-year / regime / execution-cost robustness — not on total historical PnL.')
  P('')

  // ---- 1. run inventory ----
  P('## 1. Run inventory')
  P('')
  P(mdTable(
    ['run', 'id', 'kind', 'fee/slip bps', 'status', 'rows', 'symbols', 'note'],
    runs.map((r) => [
      r.key, `\`${r.id}\``, r.kind, `${r.fee}/${r.slip}`,
      r.entry.status || (r.rows.length ? '?' : 'not run'),
      r.rows.length, r.entry.config?.symbolCount ?? new Set(r.rows.map((x) => x.symbol)).size, r.note,
    ]),
  ))
  P('')

  // ---- 2. per-bot metrics, every run ----
  P('## 2. Per-bot metrics — every run (holdout / out-of-sample)')
  P('')
  P('Metrics: trades · win% · net PnL · expectancy · profit factor · avg R · median R · max DD · longest loss streak · Sharpe · Sortino · fee$ · slippage$.')
  P('')
  for (const id of BOTS) {
    const m = getSignalModel(id)
    P(`### ${m.name} — ${m.tag}  (\`${m.strategyFamily || 'legacy'}\`)`)
    P('')
    const rows = []
    for (const r of present) {
      const blk = botMetricsBlock(r.rows, r.fee, r.slip)[id]
      if (!blk) { rows.push([r.key, '·', '·', '·', '·', '·', '·', '·', '·', '·', '·', '·', '·', '·']); continue }
      const o = blk.oos
      rows.push([
        r.key, o.trades, `${o.winRate}%`, o.netPnl, o.expectancy, o.profitFactor,
        o.avgR, o.medianR, o.maxDrawdown, o.longestLossStreak, o.sharpe, o.sortino, o.feeCost, o.slippageCost,
      ])
    }
    P(mdTable(['run', 'trades', 'win%', 'netPnl', 'exp', 'PF', 'avgR', 'medR', 'maxDD', 'lossStk', 'Sharpe', 'Sortino', 'fee$', 'slip$'], rows))
    P('')
  }

  // ---- 3. breakdowns for RUN 1 (the reference) ----
  if (run1 && run1.rows.length) {
    P('## 3. RUN 1 breakdowns (reference)')
    P('')
    const oos = run1.rows.filter((r) => r.split === 'holdout')
    const regimes = [...new Set(run1.rows.map((r) => r.marketRegime))]
    const years = [...new Set(run1.rows.map(yearOf))].sort()
    const symbols = [...new Set(run1.rows.map((r) => r.symbol))].sort()

    P('### by regime × bot (holdout expectancy / PF / n)')
    P('')
    P(mdTable(['bot', ...regimes], BOTS.filter((id) => oos.some((r) => r.signalModelId === id)).map((id) => {
      const rs = oos.filter((r) => r.signalModelId === id)
      return [getSignalModelName(id), ...regimes.map((rg) => {
        const s = rs.filter((r) => r.marketRegime === rg)
        if (!s.length) return '·'
        const mm = metrics(s)
        return `${mm.expectancy}/${mm.profitFactor}/${mm.trades}`
      })]
    })))
    P('')
    P('### by year × bot (holdout expectancy / PF / n)')
    P('')
    P(mdTable(['bot', ...years], BOTS.filter((id) => oos.some((r) => r.signalModelId === id)).map((id) => {
      const rs = oos.filter((r) => r.signalModelId === id)
      return [getSignalModelName(id), ...years.map((y) => {
        const s = rs.filter((r) => yearOf(r) === y)
        if (!s.length) return '·'
        const mm = metrics(s)
        return `${mm.expectancy}/${mm.profitFactor}/${mm.trades}`
      })]
    })))
    P('')
    P('### long vs short / family (holdout)')
    P('')
    for (const id of BOTS) {
      const rs = oos.filter((r) => r.signalModelId === id)
      if (!rs.length) continue
      const lng = metrics(rs.filter((r) => r.side === 'BUY'))
      const sht = metrics(rs.filter((r) => r.side === 'SELL'))
      P(`- **${getSignalModelName(id)}** (${getSignalModel(id).strategyFamily}): LONG exp ${lng.expectancy} (n${lng.trades}) · SHORT exp ${sht.expectancy} (n${sht.trades})`)
    }
    P('')
    P(`### by symbol × bot (holdout expectancy)`)
    P('')
    P(mdTable(['bot', ...symbols], BOTS.filter((id) => oos.some((r) => r.signalModelId === id)).map((id) => {
      const rs = oos.filter((r) => r.signalModelId === id)
      return [getSignalModelName(id), ...symbols.map((s) => {
        const sub = rs.filter((r) => r.symbol === s)
        return sub.length ? n4(metrics(sub).expectancy) : '·'
      })]
    })))
    P('')
  }

  // ---- 4. RUN 1 vs validation runs — cost & context robustness ----
  P('## 4. RUN 1 vs validation runs — per-bot holdout expectancy')
  P('')
  P(mdTable(
    ['bot', ...present.map((r) => `${r.key} (exp/PF)`)],
    BOTS.map((id) => [
      getSignalModelName(id),
      ...present.map((r) => {
        const oos = r.rows.filter((x) => x.split === 'holdout' && x.signalModelId === id)
        if (!oos.length) return '·'
        const mm = metrics(oos)
        return `${mm.expectancy}/${mm.profitFactor}`
      }),
    ]),
  ))
  P('')

  // ---- 5. RUN 7 unseen-symbol generalization ----
  P('## 5. RUN 7 — unseen-symbol generalization (LINK / AVAX / NEAR / INJ)')
  P('')
  if (run7Artifact?.ok) {
    const pb = run7Artifact.metrics.perBot || {}
    P(mdTable(
      ['bot', 'threshold', 'noAI exp', 'noAI PF', 'noAI n', 'withAI exp', 'withAI PF', 'withAI n', 'verdict'],
      BOTS.map((id) => {
        const u = pb[id]?.unseenSymbolEval
        if (!u) return [getSignalModelName(id), '·', '·', '·', '·', '·', '·', '·', pb[id]?.status || 'n/a']
        const better = (u.withAI.expectancy ?? -9) > (u.noAI.expectancy ?? 9)
        return [getSignalModelName(id), u.threshold, u.noAI.expectancy, u.noAI.profitFactor, u.noAI.trades,
          u.withAI.expectancy, u.withAI.profitFactor, u.withAI.trades,
          u.noAI.expectancy > 0 ? (better ? 'generalises + AI helps' : 'generalises') : 'does NOT generalise']
      }),
    ))
    P('')
    P('_The experimental model never saw these four symbols during training, threshold selection, or model selection._')
  } else {
    P('_RUN 7 experimental artifact not available yet._')
  }
  P('')

  // ---- 6. verdicts ----
  P('## 6. Cross-run verdicts')
  P('')
  const score = {}
  for (const id of BOTS) {
    const r1oos = run1 ? run1.rows.filter((r) => r.split === 'holdout' && r.signalModelId === id) : []
    const m1 = metrics(r1oos)
    // cost robustness: RUN 3 (high stress) expectancy vs RUN 1
    const r3 = present.find((r) => r.id.includes('high-stress'))
    const m3 = r3 ? metrics(r3.rows.filter((r) => r.split === 'holdout' && r.signalModelId === id)) : null
    const r4 = present.find((r) => r.id.includes('strict-context'))
    const m4 = r4 ? metrics(r4.rows.filter((r) => r.split === 'holdout' && r.signalModelId === id)) : null
    const bySym = run1 ? [...groupBy(r1oos, (r) => r.symbol).values()].filter((v) => v.length >= 8).map((v) => metrics(v).expectancy) : []
    const byYr = run1 ? [...groupBy(r1oos, yearOf).values()].filter((v) => v.length >= 8).map((v) => metrics(v).expectancy) : []
    score[id] = {
      name: getSignalModelName(id),
      family: getSignalModel(id).strategyFamily,
      oosExp: m1.expectancy,
      oosPF: m1.profitFactor,
      oosDD: m1.maxDrawdown,
      oosTrades: m1.trades,
      lossStreak: m1.longestLossStreak,
      costRobust: m3 ? m3.expectancy : null,
      strictRobust: m4 ? m4.expectancy : null,
      symStd: bySym.length ? stdev(bySym) : null,
      yrStd: byYr.length ? stdev(byYr) : null,
    }
  }
  const arr = Object.entries(score).map(([id, v]) => ({ id, ...v }))
  const top = (fn, label) => {
    const s = arr.filter((x) => x.oosTrades >= 30).slice().sort(fn)[0]
    P(`- **${label}:** ${s ? s.name : '—'}`)
  }
  const regimeBest = (rg, label) => {
    if (!run1) return
    const oos = run1.rows.filter((r) => r.split === 'holdout' && r.marketRegime === rg)
    const b = BOTS.map((id) => ({ id, m: metrics(oos.filter((r) => r.signalModelId === id)) }))
      .filter((x) => x.m.trades >= 15).sort((a, b2) => b2.m.expectancy - a.m.expectancy)[0]
    P(`- **${label}:** ${b ? getSignalModelName(b.id) : '—'}`)
  }
  top((a, b) => b.oosExp - a.oosExp, 'Best overall out-of-sample (expectancy)')
  top((a, b) => b.oosPF - a.oosPF, 'Highest out-of-sample profit factor')
  top((a, b) => a.oosDD - b.oosDD, 'Lowest drawdown')
  regimeBest('BULL_TREND', 'Best trend / bull-market bot')
  regimeBest('BEAR_TREND', 'Best bear-market bot')
  regimeBest('RANGE', 'Best range bot')
  regimeBest('HIGH_VOLATILITY', 'Best high-volatility bot')
  top((a, b) => (a.symStd ?? 9) - (b.symStd ?? 9), 'Most stable across symbols')
  top((a, b) => (a.yrStd ?? 9) - (b.yrStd ?? 9), 'Most stable across years')
  top((a, b) => (b.costRobust ?? -9) - (a.costRobust ?? -9), 'Most robust to realistic execution costs (RUN 3)')
  top((a, b) => (b.strictRobust ?? -9) - (a.strictRobust ?? -9), 'Most robust under strict context (RUN 4)')
  if (run7Artifact?.ok) {
    const pb = run7Artifact.metrics.perBot || {}
    const best = BOTS.map((id) => ({ id, e: pb[id]?.unseenSymbolEval?.noAI?.expectancy ?? -99 }))
      .sort((a, b) => b.e - a.e)[0]
    P(`- **Best unseen-symbol generalization (RUN 7):** ${best && best.e > -99 ? getSignalModelName(best.id) : '—'}`)
  }
  P('')

  const overfit = arr.filter((x) => {
    const r1All = run1 ? metrics(run1.rows.filter((r) => r.signalModelId === x.id)) : null
    return r1All && r1All.expectancy > 0 && x.oosExp <= 0 && x.oosTrades >= 30
  })
  const retire = arr.filter((x) => x.oosTrades >= 30 && (x.oosPF < 0.9 || x.oosExp <= 0) && !overfit.includes(x))
  const rework = arr.filter((x) => x.oosTrades >= 30 && x.oosPF >= 0.9 && x.oosPF < 1.05 && !retire.includes(x) && !overfit.includes(x))
  const paper = arr.filter((x) => x.oosTrades >= 40 && x.oosExp > 0 && x.oosPF > 1
    && (x.costRobust == null || x.costRobust > -0.05) && (x.strictRobust == null || x.strictRobust > -0.05))

  P(`- **Appears overfit (positive in-sample, non-positive OOS):** ${overfit.map((x) => x.name).join(', ') || 'none'}`)
  P(`- **Should be reworked (marginal OOS PF 0.9-1.05):** ${rework.map((x) => x.name).join(', ') || 'none'}`)
  P(`- **Should be retired (OOS PF < 0.9 or expectancy ≤ 0):** ${retire.map((x) => x.name).join(', ') || 'none'}`)
  P(`- **Suitable for PAPER TRADING (positive untouched OOS expectancy, PF > 1, cost- & context-robust, ≥40 trades):** ${paper.map((x) => x.name).join(', ') || 'none — collect more evidence'}`)
  P('')
  P('## 7. Safety')
  P('')
  P('Historical + paper only. No live orders, no real-money auto-trading, no automatic promotion to production. Retiring a weak strategy family is a successful outcome.')
  P('')

  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, L.join('\n'))
  console.log(`combined report -> ${OUT}  (${L.length} lines, ${present.length}/${RUNS.length} runs present)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
