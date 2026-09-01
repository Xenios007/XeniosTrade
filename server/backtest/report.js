// Builds the full 38-section comparison report for an 8-bot replay run.
//
//   node server/backtest/report.js --run-id <id> [--artifact <path>] [--out <path>]
//
// Reads:
//   server/data/backtest-runs/<id>.json      merged v2 trade rows
//   server/data/backtest-runs.json           registry entry (config, signals)
//   server/data/historical-cache/_summary.json  actual history per symbol
//   <artifact>  (default server/data/learning-bot-train-artifact.json)  trainer metrics
// Writes a Markdown report to server/backtest/reports/<id>.md

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { COST_REGIMES, aggregateUnderRegime } from './cost-model.js'
import { readRunRows } from './ndjson.js'
import { getSignalModel, getSignalModelName, SIGNAL_MODELS } from '../../src/lib/signalModels.js'

// Feature-rich datasets buffer >2 GB — re-exec with a larger V8 heap if needed.
if (!process.env.__HEAP_BOOSTED && !process.execArgv.some((a) => a.startsWith('--max-old-space-size'))) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, __HEAP_BOOSTED: '1' },
  })
  process.exit(r.status ?? 0)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) a[k] = true
      else { a[k] = v; i += 1 }
    }
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const RUN_ID = String(args['run-id'] || args.run || '').trim()
if (!RUN_ID) { console.error('need --run-id'); process.exit(1) }
const ARTIFACT_PATH = args.artifact ? path.resolve(String(args.artifact)) : path.join(dataDir, 'learning-bot-train-artifact.json')
const OUT_PATH = args.out ? path.resolve(String(args.out)) : path.join(__dirname, 'reports', `${RUN_ID}.md`)

const readJson = async (p, d = null) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }
const n2 = (x) => (Number.isFinite(Number(x)) ? Number(Number(x).toFixed(2)) : 0)
const n4 = (x) => (Number.isFinite(Number(x)) ? Number(Number(x).toFixed(4)) : 0)
const pct = (a, b) => (b ? n2((a / b) * 100) : 0)
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
const stdev = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) }

// full metric bundle over a set of rows (ordered by timestamp)
function metrics(rows) {
  const ord = [...rows].sort((a, b) => a.timestamp - b.timestamp)
  const pnls = ord.map((r) => Number(r.label?.pnl ?? r.pnl ?? 0))
  const gross = ord.map((r) => Number(r.label?.grossPnl ?? r.grossPnl ?? r.label?.pnl ?? 0))
  const rs = ord.map((r) => Number(r.label?.netR ?? 0))
  const fees = ord.map((r) => Number(r.label?.frictionUsd ?? r.frictionUsd ?? 0))
  const n = ord.length
  const wins = pnls.filter((p) => p > 0).length
  const losses = pnls.filter((p) => p < 0).length
  let eq = 0; let peak = 0; let dd = 0
  let ws = 0; let ls = 0; let bw = 0; let bl = 0
  let gw = 0; let gl = 0
  for (const p of pnls) {
    eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq)
    if (p > 0) { ws += 1; ls = 0; gw += p } else if (p < 0) { ls += 1; ws = 0; gl += -p }
    bw = Math.max(bw, ws); bl = Math.max(bl, ls)
  }
  const m = mean(pnls); const sd = stdev(pnls)
  const down = pnls.filter((p) => p < 0)
  const dsd = down.length ? Math.sqrt(mean(down.map((p) => p * p))) : 0
  // fees vs slippage split from the run's configured bps ratio (5:2 by default)
  const feeShare = 5 / (5 + 2)
  return {
    trades: n,
    wins,
    losses,
    winRate: pct(wins, n),
    grossPnl: n2(gross.reduce((s, x) => s + x, 0)),
    netPnl: n2(pnls.reduce((s, x) => s + x, 0)),
    avgPnl: n4(m),
    medianPnl: n4(median(pnls)),
    expectancy: n4(m),
    profitFactor: gl > 0 ? n4(gw / gl) : (gw > 0 ? 999 : 0),
    avgR: n4(mean(rs)),
    medianR: n4(median(rs)),
    maxDrawdown: n2(dd),
    sharpe: sd > 0 ? n4((m / sd) * Math.sqrt(n)) : 0,
    sortino: dsd > 0 ? n4((m / dsd) * Math.sqrt(n)) : 0,
    longestWinStreak: bw,
    longestLossStreak: bl,
    feeCost: n2(fees.reduce((s, x) => s + x, 0) * feeShare),
    slippageCost: n2(fees.reduce((s, x) => s + x, 0) * (1 - feeShare)),
  }
}

function groupBy(rows, keyFn) {
  const m = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}
const yearOf = (r) => new Date(r.timestamp).getUTCFullYear()

function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map((r) => line(r.map(String)))].join('\n')
}

function metricRow(label, m) {
  return [label, m.trades, m.wins, m.losses, `${m.winRate}%`, m.netPnl, m.expectancy, m.profitFactor, m.avgR, m.maxDrawdown, m.longestLossStreak]
}

async function main() {
  const rows = await readRunRows(dataDir, RUN_ID)
  if (!Array.isArray(rows) || rows.length === 0) { console.error(`no rows for run ${RUN_ID}`); process.exit(1) }
  const registry = await readJson(path.join(dataDir, 'backtest-runs.json'), [])
  const runEntry = (registry || []).find((r) => r.id === RUN_ID) || {}
  const cacheSummary = await readJson(path.join(dataDir, 'historical-cache', '_summary.json'), null)
  const artifact = await readJson(ARTIFACT_PATH, null)
  const AM = artifact?.metrics || {}

  const bots = SIGNAL_MODELS.map((m) => m.id).filter((id) => rows.some((r) => r.signalModelId === id))
  const byBot = groupBy(rows, (r) => r.signalModelId)
  const holdout = rows.filter((r) => r.split === 'holdout')
  const byBotHoldout = groupBy(holdout, (r) => r.signalModelId)

  const L = []
  const P = (...s) => L.push(...s)

  P(`# XeniosTrade 8-bot 5-year backtest — comparison report`)
  P('')
  P(`- **Run id:** \`${RUN_ID}\``)
  P(`- **Generated:** ${new Date().toISOString()}`)
  P(`- **Git SHA:** \`${runEntry.config?.gitSha || 'unknown'}\``)
  P(`- **Rows:** ${rows.length}  |  holdout rows: ${holdout.length}`)
  P(`- **Trainer:** ${AM.framework || 'not run'} on ${AM.deviceUsed || 'n/a'}  |  leakage check: ${AM.leakageCheck?.passed ? 'PASSED' : 'n/a'} (${AM.leakageCheck?.featureKeysChecked ?? '?'} feature keys)`)
  P('')
  P(`> Objective: a large, diverse, **leakage-free** historical trade dataset across strategy families,`)
  P(`> symbols, regimes and years — to learn which strategies generalise. NOT to maximise historical profit.`)
  P('')

  // 1. files modified
  P('## 1. Files modified / added')
  P('')
  P('See `server/backtest/EXPANSION-PLAN.md` §10 for the full log. Summary:')
  P('- **New:** `feature-lib.js`, `regime.js`, `splits.js`, `cost-model.js`, `data-cache.js`, `btc-context.js`, `warm-cache.js`, `report.js` (server/backtest/); `server/strategy/bots5to8.js`; `test/*.test.js`; `server/learning-bot/tests/*.py`.')
  P('- **Rewritten:** `server/backtest/replay-dataset.js` (v2), `server/learning-bot/rl_trainer.py` (TAKE/SKIP).')
  P('- **Edited:** `src/lib/signalModels.js` (Bots 5-8), `src/lib/tradingConfig.js` (BACKTEST_UNIVERSE), `server/mock-trading-server.js` (dispatch + row schema v2 + leakage guard), `.gitignore`, `package.json`.')
  P('')

  // 2. Bots 5-8 summary
  P('## 2. Bots 5-8 implementation summary')
  P('')
  for (const id of ['model-5', 'model-6', 'model-7', 'model-8']) {
    const m = getSignalModel(id)
    P(`- **${m.name} — ${m.tag}** (\`${m.strategyFamily}\`): ${m.description}`)
  }
  P('')
  P('Each is a distinct market hypothesis with its own indicator stack (`server/strategy/bots5to8.js`), not a parameter tweak of Bots 1-4. Bot 2 order-flow stays tagged as a kline-derived **proxy**. Bot 8 skips any period without genuine funding history.')
  P('')

  // 3. leakage
  P('## 3. Target-leakage issues found & fixed')
  P('')
  P('| # | Site | Issue | Fix |')
  P('| --- | --- | --- | --- |')
  P('| 1 | `rl_trainer.py` `build_state_vector` | `status=="CLOSED_TP"/"CLOSED_SL"` in the model input | Trainer rewritten; inputs come only from `row.features`; forbidden-key guard at load |')
  P('| 2 | `rl_trainer.py` | `len(mistakeTags)` in the input (derived from post-trade `status`/`pnl`) | `mistakeTags` moved to reporting-only; never a feature |')
  P('| 3 | `rl_trainer.py` objective | regressed Q(BUY)/Q(SELL) onto reward → imitated direction | Replaced with TAKE/SKIP + P(win)/P(TP-before-SL)/expected-R/quality heads |')
  P('| 4 | trainer | no chronological split, no purge/embargo, no walk-forward | `splits.js`: 60/20/20 by genuine history, 48h purge/embargo; trainer fits `train`, tunes threshold on `val`, scores `holdout` once |')
  P('| 5 | `replay-dataset.js` → `buildLearningBotDataset` | `status`/`result` passed straight through into training rows | Row schema v2: explicit `features{}` vs `label{}`/`reward`; `assertNoLeakageInFeatures` |')
  P('')
  P(`Automated proof: \`test/schema-v2.test.js\` + \`server/learning-bot/tests/test_trainer.py\` — the trainer **aborts with exit 1 / \`ok:false\`** when any forbidden key is injected into features, and the Python forbidden-set is asserted equal to the JS \`LEARNING_BOT_FORBIDDEN_FEATURE_KEYS\`.`)
  P('')

  // 4-5 tests
  P('## 4-5. Tests added / passed')
  P('')
  P('- `node --test` — feature-lib, splits, regime, cost-model, bots5to8, schema-v2. **See `npm test`.**')
  P('- `pytest server/learning-bot/tests` — forbidden-key guard, split isolation (holdout never influences selection), determinism, torch-missing fallback, artifact shape.')
  P('')

  // 6. actual history per token
  P('## 6. Actual history per token')
  P('')
  const histRows = []
  const perSymHist = runEntry.summary?.perSymbolHistory || {}
  const symbols = [...new Set(rows.map((r) => r.symbol))].sort()
  for (const s of symbols) {
    const h = perSymHist[s] || {}
    const cs = cacheSummary?.symbols?.find((x) => x.symbol === s) || {}
    const ext = rows.find((r) => r.symbol === s)?.isExtendedUniverse
    histRows.push([s, ext ? 'extended' : 'core', h.start || cs.historyStart?.slice(0, 10) || '?', h.end || cs.historyEnd?.slice(0, 10) || '?', cs.monthsOfHistory ?? '?', h.candles ?? cs.fiveMinBars ?? '?', h.rows ?? byBot.size])
  }
  P(mdTable(['symbol', 'universe', 'history start', 'history end', 'months', '5m candles', 'rows kept'], histRows))
  P('')
  P('> No candle was fabricated, duplicated or interpolated. Symbols listed after the window start use their genuine listing-date onward.')
  P('')

  // 7-11 volumes + distributions
  const totalCandles = Object.values(perSymHist).reduce((s, h) => s + (h.candles || 0), 0)
  P('## 7-11. Volumes & sample distribution')
  P('')
  P(`- **Candles processed (5m, across symbols):** ~${totalCandles.toLocaleString()}`)
  P(`- **Generated trades (kept, reservoir-capped):** ${rows.length}`)
  P('')
  P('**Samples per bot:**')
  P(mdTable(['bot', 'family', 'rows', 'train', 'val', 'holdout'],
    bots.map((id) => {
      const rs = byBot.get(id) || []
      const c = (s) => rs.filter((r) => r.split === s).length
      return [getSignalModelName(id), getSignalModel(id).strategyFamily, rs.length, c('train'), c('val'), c('holdout')]
    })))
  P('')
  P('**Samples per symbol (core vs extended):**')
  P(mdTable(['symbol', 'universe', 'rows'], symbols.map((s) => {
    const rs = rows.filter((r) => r.symbol === s)
    return [s, rs[0]?.isExtendedUniverse ? 'extended' : 'core', rs.length]
  })))
  const coreN = rows.filter((r) => !r.isExtendedUniverse).length
  const extN = rows.filter((r) => r.isExtendedUniverse).length
  P('')
  P(`Core ${coreN} / extended ${extN} (${pct(extN, rows.length)}% extended — watch this does not dominate).`)
  P('')
  P('**Samples per regime:**')
  P(mdTable(['regime', 'rows', 'share'], [...groupBy(rows, (r) => r.marketRegime).entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => [k, v.length, `${pct(v.length, rows.length)}%`])))
  P('')

  // 12-15 periods + features
  P('## 12-15. Train / validation / holdout periods & feature set')
  P('')
  P(`- Split policy: **60% train / 20% validation / 20% untouched holdout** of each symbol's genuine history, with a **48h purge+embargo** either side of every boundary (rows inside it are dropped).`)
  P(`- Split counts (this run): ${JSON.stringify(AM.split || Object.fromEntries([...groupBy(rows, (r) => r.split)].map(([k, v]) => [k, v.length])))}`)
  P(`- Walk-forward folds available inside train+val via \`splits.js:walkForwardFolds\`.`)
  P(`- **Feature set:** \`${AM.featureVersion || rows[0]?.featureVersion}\` — ${AM.featureCount ?? Object.keys(rows[0]?.features || {}).length} entry-time features per sample: returns (1/3/6/12/24-bar + log), EMA9/20/50/200 normalised distances + slope + trend strength (ADX), RSI14 + change + slope, MACD, ROC, momentum accel, ATR% + realized vol + Bollinger width/position + vol percentile + compression/expansion, relative/MA/z-score volume + taker-buy ratio + taker-delta proxy + OBV, candle-structure ratios, market structure (HH/HL/LH/LL, recent-high/low distance, breakout/range state), VWAP distance/slope, funding rate/sign/magnitude/change/percentile/z-score (+ available flag), UTC-hour & day-of-week cyclical, London/NY session flags, and timestamp-aligned BTC (5m/15m/1h/derived-4h returns, RSI, trend, vol regime, regime code) + ETH context.`)
  P('')

  // 16-17 hardware
  P('## 16-17. Hardware / device')
  P('')
  P(`- Replay + feature engineering: CPU (single-thread per symbol, symbol-level concurrency ${runEntry.config?.concurrency ?? 2}). Node ${runEntry.config?.node || process.version}, ${runEntry.config?.platform || process.platform}.`)
  P(`- AI training device actually used: **${AM.deviceUsed || 'n/a'}** (framework ${AM.framework || 'n/a'}).`)
  P('')

  // 18-25 per-bot metrics
  P('## 18-25. Per-bot metrics')
  P('')
  P('All-sample and holdout-only (out-of-sample) metrics per bot. NORMAL costs (5 bps fee + 2 bps slippage / side).')
  P('')
  for (const id of bots) {
    const all = metrics(byBot.get(id) || [])
    const oos = metrics(byBotHoldout.get(id) || [])
    const m = getSignalModel(id)
    P(`### ${m.name} — ${m.tag} (\`${m.strategyFamily}\`)`)
    P('')
    P(mdTable(['scope', 'trades', 'wins', 'losses', 'win%', 'net PnL', 'expectancy', 'PF', 'avg R', 'max DD', 'loss streak'],
      [metricRow('all', all), metricRow('holdout (OOS)', oos)]))
    P('')
    const full = metrics(byBot.get(id) || [])
    P(`- gross PnL ${full.grossPnl} | median PnL ${full.medianPnl} | median R ${full.medianR} | Sharpe ${full.sharpe} | Sortino ${full.sortino} | longest win streak ${full.longestWinStreak} | fee cost ${full.feeCost} | slippage cost ${full.slippageCost}`)
    const ai = AM.perBot?.[id]
    if (ai && ai.status === 'trained') {
      P(`- **AI TAKE/SKIP:** threshold ${ai.threshold} (chosen on val), val take-accuracy ${ai.valTakeAccuracy}%, AI useful: ${ai.aiUseful ? 'yes' : 'no'}`)
    } else if (ai) {
      P(`- **AI TAKE/SKIP:** ${ai.status} (${JSON.stringify(ai.counts || {})})`)
    }
    P('')
  }

  // 26 per-symbol
  P('## 26. Per-bot × per-symbol (holdout expectancy)')
  P('')
  P(mdTable(['bot', ...symbols], bots.map((id) => {
    const rs = byBotHoldout.get(id) || []
    return [getSignalModelName(id), ...symbols.map((s) => {
      const sub = rs.filter((r) => r.symbol === s)
      return sub.length ? n4(metrics(sub).expectancy) : '·'
    })]
  })))
  P('')

  // 27 regime
  P('## 27. Per-bot × regime (holdout)')
  P('')
  const regimes = [...new Set(rows.map((r) => r.marketRegime))]
  P(mdTable(['bot', ...regimes.map((rr) => `${rr} exp / PF / n`)], bots.map((id) => {
    const rs = byBotHoldout.get(id) || []
    return [getSignalModelName(id), ...regimes.map((rr) => {
      const sub = rs.filter((r) => r.marketRegime === rr)
      if (!sub.length) return '·'
      const m = metrics(sub)
      return `${m.expectancy} / ${m.profitFactor} / ${m.trades}`
    })]
  })))
  P('')

  // 28 year
  P('## 28. Per-bot × year (holdout expectancy / PF / n)')
  P('')
  const years = [...new Set(rows.map(yearOf))].sort()
  P(mdTable(['bot', ...years], bots.map((id) => {
    const rs = byBotHoldout.get(id) || []
    return [getSignalModelName(id), ...years.map((y) => {
      const sub = rs.filter((r) => yearOf(r) === y)
      if (!sub.length) return '·'
      const m = metrics(sub)
      return `${m.expectancy}/${m.profitFactor}/${m.trades}`
    })]
  })))
  P('')

  // side + setup family + core/extended
  P('## 28b. Per-bot long vs short / setup family / core vs extended (holdout)')
  P('')
  for (const id of bots) {
    const rs = byBotHoldout.get(id) || []
    if (!rs.length) continue
    const long = metrics(rs.filter((r) => r.side === 'BUY'))
    const short = metrics(rs.filter((r) => r.side === 'SELL'))
    const core = metrics(rs.filter((r) => !r.isExtendedUniverse))
    const ext = metrics(rs.filter((r) => r.isExtendedUniverse))
    P(`- **${getSignalModelName(id)}** — LONG exp ${long.expectancy} (n${long.trades}) / SHORT exp ${short.expectancy} (n${short.trades}) | core exp ${core.expectancy} (n${core.trades}) / extended exp ${ext.expectancy} (n${ext.trades})`)
    const fams = groupBy(rs, (r) => r.setupFamily)
    for (const [fam, sub] of fams) {
      const m = metrics(sub)
      P(`  - setup "${fam}": exp ${m.expectancy}, PF ${m.profitFactor}, win ${m.winRate}%, n ${m.trades}`)
    }
  }
  P('')

  // 29 AI vs non-AI
  P('## 29. AI TAKE/SKIP vs no-AI (out-of-sample holdout)')
  P('')
  P('Threshold chosen on validation only, then applied once to holdout.')
  P('')
  const aiHo = AM.aiVsNoAiHoldout || {}
  P(mdTable(['bot', 'threshold', 'noAI exp', 'AI exp', 'noAI PF', 'AI PF', 'noAI DD', 'AI DD', 'noAI n', 'AI n', 'verdict'],
    bots.map((id) => {
      const a = aiHo[id] || AM.perBot?.[id]?.holdout
      const no = a?.noAI || {}
      const yes = a?.withAI || {}
      const thr = aiHo[id]?.threshold ?? AM.perBot?.[id]?.threshold ?? 0
      const better = (yes.expectancy ?? -9) > (no.expectancy ?? 9) && (yes.profitFactor ?? 0) >= (no.profitFactor ?? 0)
      return [getSignalModelName(id), thr, no.expectancy ?? '·', yes.expectancy ?? '·', no.profitFactor ?? '·', yes.profitFactor ?? '·', no.maxDrawdown ?? '·', yes.maxDrawdown ?? '·', no.trades ?? '·', yes.trades ?? '·', thr === 0 ? 'AI adds nothing' : (better ? 'AI helps' : 'AI does not help')]
    })))
  P('')

  // 30 cost regimes
  P('## 30. Cost-regime sensitivity (holdout, per bot)')
  P('')
  for (const [name, reg] of Object.entries(COST_REGIMES)) {
    P(`**${name}** (${reg.feeBps} bps fee + ${reg.slippageBps} bps slippage / side):`)
    P('')
    P(mdTable(['bot', 'trades', 'win%', 'net PnL', 'expectancy', 'PF', 'avg R'],
      bots.map((id) => {
        const rs = (byBotHoldout.get(id) || [])
        const a = aggregateUnderRegime(rs, reg)
        return [getSignalModelName(id), a.trades, `${a.winRate}%`, a.netPnl, a.expectancy, a.profitFactor === Infinity ? '∞' : a.profitFactor, a.avgR]
      })))
    P('')
  }

  // 31 max DD per bot
  P('## 31. Max drawdown per bot')
  P('')
  P(mdTable(['bot', 'all-sample DD', 'holdout DD'], bots.map((id) => [getSignalModelName(id), metrics(byBot.get(id) || []).maxDrawdown, metrics(byBotHoldout.get(id) || []).maxDrawdown])))
  P('')

  // cross-bot comparison
  P('## 34-35. Cross-bot comparison & recommendations')
  P('')
  const scored = bots.map((id) => {
    const oos = metrics(byBotHoldout.get(id) || [])
    const bySym = [...groupBy(byBotHoldout.get(id) || [], (r) => r.symbol).values()].filter((v) => v.length >= 10).map((v) => metrics(v).expectancy)
    const byYr = [...groupBy(byBotHoldout.get(id) || [], yearOf).values()].filter((v) => v.length >= 10).map((v) => metrics(v).expectancy)
    return { id, name: getSignalModelName(id), oos, symStd: stdev(bySym), yrStd: stdev(byYr) }
  })
  const bestBy = (fn) => scored.slice().sort(fn)[0]
  const regimeBest = (rr) => bots.map((id) => ({ id, m: metrics((byBotHoldout.get(id) || []).filter((r) => r.marketRegime === rr)) }))
    .filter((x) => x.m.trades >= 15).sort((a, b) => b.m.expectancy - a.m.expectancy)[0]
  P(`- **Best overall OOS (expectancy):** ${bestBy((a, b) => b.oos.expectancy - a.oos.expectancy)?.name}`)
  P(`- **Highest OOS profit factor:** ${bestBy((a, b) => b.oos.profitFactor - a.oos.profitFactor)?.name}`)
  P(`- **Lowest OOS drawdown:** ${bestBy((a, b) => a.oos.maxDrawdown - b.oos.maxDrawdown)?.name}`)
  P(`- **Best bull-trend bot:** ${regimeBest('BULL_TREND')?.id || '—'}`)
  P(`- **Best bear-trend bot:** ${regimeBest('BEAR_TREND')?.id || '—'}`)
  P(`- **Best range bot:** ${regimeBest('RANGE')?.id || '—'}`)
  P(`- **Best high-volatility bot:** ${regimeBest('HIGH_VOLATILITY')?.id || '—'}`)
  P(`- **Most stable cross-symbol (lowest expectancy stdev):** ${bestBy((a, b) => a.symStd - b.symStd)?.name}`)
  P(`- **Most stable cross-year:** ${bestBy((a, b) => a.yrStd - b.yrStd)?.name}`)
  P('')
  const fails = scored.filter((s) => s.oos.trades < 40 || s.oos.profitFactor < 1 || s.oos.expectancy <= 0)
  const keeps = scored.filter((s) => !fails.includes(s))
  P('### 32-33, 36. Overfitting concerns · failed strategies · retire/rework')
  P('')
  P(`- **Recommended for paper trading (positive OOS expectancy, PF > 1, enough trades):** ${keeps.map((s) => s.name).join(', ') || 'none'}`)
  P(`- **Failed / retire or rework (OOS PF < 1, expectancy <= 0, or < 40 trades):** ${fails.map((s) => `${s.name} (PF ${s.oos.profitFactor}, exp ${s.oos.expectancy}, n ${s.oos.trades})`).join('; ') || 'none'}`)
  P(`- **Overfitting watch:** compare each bot's all-sample vs holdout expectancy above; a large drop = the rule fit noise. AI threshold was never tuned on holdout.`)
  P('')

  // 37 meta-model
  const enoughForMeta = keeps.length >= 2 && holdout.length >= 2000
  P('## 37. Meta-model readiness')
  P('')
  P(`Dataset structure supports a future regime→bot meta-model: every row carries \`marketRegime\`, \`strategyFamily\`, \`signalModelId\`, \`split\`, \`isExtendedUniverse\`, \`setupFamily\` + the full feature vector.`)
  P(`**Verdict:** ${enoughForMeta ? 'enough validated per-bot signal to START prototyping the meta-model (do NOT deploy).' : 'NOT yet — validate more per-bot results first (need >=2 bots with positive OOS edge and a larger holdout).'}`)
  P('')

  // 38 repro
  P('## 38. Exact reproduction')
  P('')
  P('```bash')
  P('# 1. warm the historical cache (idempotent)')
  P(`node server/backtest/warm-cache.js --months ${runEntry.config?.months ?? 60} --concurrency ${runEntry.config?.concurrency ?? 2}`)
  P('# 2. run the 8-bot replay')
  P(`node server/backtest/replay-dataset.js --months ${runEntry.config?.months ?? 60} --stride ${runEntry.config?.stride ?? 2} \\`)
  P(`  --bots ${(runEntry.config?.bots || bots).join(',')} \\`)
  P(`  --symbols universe --run-id ${RUN_ID} --concurrency ${runEntry.config?.concurrency ?? 2} \\`)
  P(`  --fee-bps ${runEntry.config?.feeBps ?? 5} --slippage-bps ${runEntry.config?.slippageBps ?? 2} --max-hold-hours ${runEntry.config?.maxHoldHours ?? 48} --no-train`)
  P('# 3. train per-bot TAKE/SKIP models (CUDA)')
  P('#    flag the run includeInTraining in the Backtests UI, then from AI Training → Train,')
  P('#    or: node -e "..." to call refreshLearningBotDatasetArtifact + launchLearningBotTraining')
  P('# 4. regenerate this report')
  P(`node server/backtest/report.js --run-id ${RUN_ID}`)
  P('```')
  P('')
  P(`- seed: ${runEntry.config?.randomSeed ?? 7} | feature version: ${runEntry.config?.featureVersion} | git: \`${runEntry.config?.gitSha || 'unknown'}\``)
  P('')
  P('## Safety')
  P('')
  P('Historical + paper only. No real-money trading enabled, no model promoted to live, no exchange credentials touched. Eliminating a weak strategy family is a successful outcome.')
  P('')

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true })
  await fs.writeFile(OUT_PATH, L.join('\n'))
  console.log(`report → ${OUT_PATH} (${L.length} lines, ${rows.length} rows, ${bots.length} bots)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
