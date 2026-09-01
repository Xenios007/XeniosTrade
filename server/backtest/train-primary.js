// Phase 2 of the primary run: flag the replay dataset for training, assemble the
// leakage-free v2 training set, launch the per-bot TAKE/SKIP trainer (CUDA), and
// wait for it to finish. Prints the artifact path on success.
//
//   node server/backtest/train-primary.js [--run-id primary-8bot-5yr]

process.env.XENIOS_SERVER_AUTOSTART = 'off'

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { patchRun, readRegistry } from './run-registry.js'

const { getSettings, normalizeLearningBotSettings, refreshLearningBotDatasetArtifact, launchLearningBotTraining } = await import('../mock-trading-server.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const args = process.argv.slice(2)
const runIdIdx = args.indexOf('--run-id')
const RUN_ID = runIdIdx >= 0 ? args[runIdIdx + 1] : 'primary-8bot-5yr'
const ARTIFACT_PATH = path.join(dataDir, 'learning-bot-train-artifact.json')
const STATUS_PATH = path.join(dataDir, 'learning-bot-train-status.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = async (p, d = null) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }

async function main() {
  const reg = await readRegistry()
  const entry = reg.find((r) => r.id === RUN_ID)
  if (!entry) throw new Error(`run ${RUN_ID} not in registry`)
  if (entry.status !== 'complete') throw new Error(`run ${RUN_ID} status is "${entry.status}", not complete`)

  console.log(`[train-primary] flagging ${RUN_ID} includeInTraining=true`)
  await patchRun(RUN_ID, { includeInTraining: true })

  const settings = await getSettings()
  const config = normalizeLearningBotSettings(settings.learningBot)
  config.aiTrainer.enabled = true
  console.log(`[train-primary] device preference: ${config.aiTrainer.devicePreference}, epochs ${config.aiTrainer.epochs}, batch ${config.aiTrainer.batchSize}`)

  console.log('[train-primary] assembling v2 training dataset …')
  const { dataset } = await refreshLearningBotDatasetArtifact(config)
  const v2 = dataset.filter((r) => r.schemaVersion === 2 && r.features)
  console.log(`[train-primary] dataset: ${dataset.length} rows total, ${v2.length} v2 feature rows`)
  if (v2.length < 200) throw new Error(`only ${v2.length} v2 rows — dataset assembly may have failed`)

  console.log('[train-primary] launching trainer (this blocks until the child exits) …')
  const launch = await launchLearningBotTraining({ config, dataset }).catch((e) => ({ error: String(e?.message || e) }))
  console.log('[train-primary] launch returned:', JSON.stringify(launch?.status || launch).slice(0, 400))

  // poll status/artifact until training is done
  for (let i = 0; i < 240; i += 1) { // up to ~40 min
    await sleep(10_000)
    const status = await readJson(STATUS_PATH, {})
    if (status && status.running === false && status.lastRunAt) {
      const artifact = await readJson(ARTIFACT_PATH, null)
      if (artifact) {
        console.log(`[train-primary] DONE — ok=${artifact.ok} framework=${artifact.metrics?.framework} device=${artifact.metrics?.deviceUsed}`)
        console.log(`[train-primary] artifact: ${ARTIFACT_PATH}`)
        if (!artifact.ok) { console.error('[train-primary] trainer error:', artifact.error); process.exit(1) }
        return
      }
    }
    if (i % 6 === 0) console.log(`[train-primary] …still training (${i * 10}s)`)
  }
  throw new Error('training did not complete within 40 min')
}

main().then(() => process.exit(0)).catch((e) => { console.error('[train-primary] FAILED:', e); process.exit(1) })
