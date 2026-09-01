// RUN 7 — true unseen-symbol generalization. Trains a SEPARATE experimental
// TAKE/SKIP model on RUN 7's replay dataset, with four symbols
// (LINKUSDT, AVAXUSDT, NEARUSDT, INJUSDT) held out of ALL fitting / threshold /
// model selection, then scored only on those four.
//
// This NEVER touches the primary model:
//   * RUN 7's run is NOT flagged includeInTraining
//   * training reads ONLY RUN 7's rows (no merge with RUN 1 / real history)
//   * artifacts go to server/data/ai-training/run7-experimental/ (not the
//     primary learning-bot-train-artifact.json)
//
//   node server/backtest/train-experimental.js [--run-id validation-unseen-symbol-generalization]

process.env.XENIOS_SERVER_AUTOSTART = 'off'

import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Building RUN 7's training rows buffers >2 GB — re-exec with a larger V8 heap.
if (!process.env.__HEAP_BOOSTED && !process.execArgv.some((a) => a.startsWith('--max-old-space-size'))) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, __HEAP_BOOSTED: '1' },
  })
  process.exit(r.status ?? 0)
}

const { getSettings, normalizeLearningBotSettings, buildLearningBotDataset } = await import('../mock-trading-server.js')
const { readRunRows, writeDatasetArtifactStreamed } = await import('./ndjson.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const args = process.argv.slice(2)
const idIdx = args.indexOf('--run-id')
const RUN_ID = idIdx >= 0 ? args[idIdx + 1] : 'validation-unseen-symbol-generalization'
const HOLDOUT = ['LINKUSDT', 'AVAXUSDT', 'NEARUSDT', 'INJUSDT']

const OUT_DIR = path.join(dataDir, 'ai-training', 'run7-experimental')
const DATASET_PATH = path.join(OUT_DIR, 'dataset.json')
const CONFIG_PATH = path.join(OUT_DIR, 'config.json')
const ARTIFACT_PATH = path.join(OUT_DIR, 'artifact.json')
const TRAINER = path.join(__dirname, '..', 'learning-bot', 'rl_trainer.py')

const readJson = async (p, d = null) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }

// win32: prefer the bundled CUDA venv python (same logic the server uses)
function pythonCmd() {
  if (process.platform === 'win32') {
    const venv = path.join(__dirname, '..', 'learning-bot', '.venv', 'Scripts', 'python.exe')
    return venv
  }
  return 'python3'
}

function runTrainer() {
  return new Promise((resolve, reject) => {
    const cmd = pythonCmd()
    const a = [TRAINER, '--dataset', DATASET_PATH, '--config', CONFIG_PATH, '--artifact', ARTIFACT_PATH]
    console.log(`[run7] ${cmd} ${a.join(' ')}`)
    const child = spawn(cmd, a, { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => {
      if (out.trim()) console.log('[run7] trainer stdout:', out.trim().slice(0, 500))
      if (code !== 0) { console.error('[run7] trainer stderr:', err.trim().slice(0, 800)); reject(new Error(`trainer exit ${code}`)) }
      else resolve()
    })
    child.on('error', reject)
  })
}

async function main() {
  const rows = await readRunRows(dataDir, RUN_ID)
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`no rows for run ${RUN_ID} — replay it first`)
  const withFeatures = rows.filter((r) => r.schemaVersion === 2 && r.features && Object.keys(r.features).length > 5)
  if (withFeatures.length < 500) {
    throw new Error(`RUN 7 replay has ${withFeatures.length} feature rows — it must run WITHOUT --no-features`)
  }
  console.log(`[run7] ${rows.length} rows, ${withFeatures.length} with features`)
  const symCounts = {}
  for (const r of rows) symCounts[r.symbol] = (symCounts[r.symbol] || 0) + 1
  const missing = HOLDOUT.filter((s) => !symCounts[s])
  if (missing.length) console.warn(`[run7] WARNING holdout symbols missing from replay: ${missing.join(', ')}`)

  await fs.mkdir(OUT_DIR, { recursive: true })

  // build v2 training rows straight from RUN 7's replay rows (NO merge)
  const settings = await getSettings()
  const config = normalizeLearningBotSettings(settings.learningBot)
  const dataset = buildLearningBotDataset(rows, { focusSource: 'all', reviewWindowTrades: 0, minClosedTradesForInsights: 1 })
  const v2 = dataset.filter((r) => r.schemaVersion === 2 && r.features && Object.keys(r.features).length > 5)
  console.log(`[run7] built ${dataset.length} training rows (${v2.length} v2)`)

  await writeDatasetArtifactStreamed(DATASET_PATH, { generatedAt: Date.now(), config: { source: `run7:${RUN_ID}` }, rows: dataset })
  await fs.writeFile(CONFIG_PATH, JSON.stringify({
    generatedAt: Date.now(),
    learningBot: {
      trainingScope: 'per-bot',
      aiTrainer: {
        ...config.aiTrainer,
        enabled: true,
        devicePreference: config.aiTrainer.devicePreference || 'cuda',
        symbolHoldout: HOLDOUT,
      },
    },
  }, null, 2))

  await runTrainer()

  const art = await readJson(ARTIFACT_PATH, null)
  if (!art || !art.ok) throw new Error(`experimental training failed: ${art?.error || 'unknown'}`)
  const m = art.metrics
  console.log(`[run7] DONE — framework ${m.framework} on ${m.deviceUsed}, leakage check ${m.leakageCheck?.passed}`)
  console.log('[run7] unseen-symbol generalization (per bot):')
  for (const [bot, pb] of Object.entries(m.perBot || {})) {
    if (pb.status !== 'trained' || !pb.unseenSymbolEval) { console.log(`  ${bot}: ${pb.status}${pb.unseenSymbolEval ? '' : ' (no unseen rows)'}`); continue }
    const u = pb.unseenSymbolEval
    console.log(`  ${bot}: threshold ${u.threshold} | noAI exp ${u.noAI.expectancy} PF ${u.noAI.profitFactor} n ${u.noAI.trades}`
      + ` | withAI exp ${u.withAI.expectancy} PF ${u.withAI.profitFactor} n ${u.withAI.trades}`)
  }
  console.log(`[run7] artifact: ${ARTIFACT_PATH}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('[run7] FAILED:', e); process.exit(1) })
