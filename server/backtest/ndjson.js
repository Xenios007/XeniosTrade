// Streaming NDJSON helpers. A 5-year / 20-symbol / 8-bot dataset with the full
// feature vector is ~600 MB+ — past V8's ~512 MB max string length, so it can
// never be produced or consumed via a single JSON.stringify / JSON.parse. These
// helpers stream row-by-row instead.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { createReadStream, createWriteStream } from 'node:fs'

/** Stream an array of plain objects to `file` as NDJSON (one compact JSON/line). */
export async function writeRowsNdjson(file, rows) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(file)
    ws.on('error', reject)
    let i = 0
    const pump = () => {
      let ok = true
      while (i < rows.length && ok) {
        ok = ws.write(`${JSON.stringify(rows[i])}\n`)
        i += 1
      }
      if (i < rows.length) ws.once('drain', pump)
      else ws.end(resolve)
    }
    pump()
  })
}

/** Concatenate NDJSON `sources` into `file` without loading them into memory. */
export async function concatNdjson(file, sources) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const ws = createWriteStream(file)
  for (const src of sources) {
    try { await fsp.access(src) } catch { continue }
    await new Promise((resolve, reject) => {
      const rs = createReadStream(src)
      rs.on('error', reject)
      rs.on('end', resolve)
      rs.pipe(ws, { end: false })
    })
    // ensure a trailing newline between files
    ws.write('\n')
  }
  await new Promise((resolve) => ws.end(resolve))
}

/** Read an NDJSON file into an array of parsed objects (line-streamed). */
export async function readRowsNdjson(file) {
  const rows = []
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    rl.on('line', (line) => {
      const t = line.trim()
      if (t) {
        try { rows.push(JSON.parse(t)) } catch { /* skip torn line */ }
      }
    })
    rl.on('close', resolve)
    rl.on('error', reject)
  })
  return rows
}

/** Async iterator over parsed rows of an NDJSON file (no full-array buffering). */
export async function* iterateRowsNdjson(file) {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    const t = line.trim()
    if (!t) continue
    try { yield JSON.parse(t) } catch { /* skip torn line */ }
  }
}

/**
 * Load all rows for a backtest run. Prefers the per-symbol NDJSON files under
 * backtest-runs/<runId>/ (smaller, always present); falls back to a merged
 * <runId>.ndjson, then a legacy <runId>.json array.
 */
export async function readRunRows(dataDir, runId) {
  const dir = path.join(dataDir, 'backtest-runs', runId)
  const rows = []
  try {
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.ndjson') && !f.startsWith('_'))
    if (files.length) {
      for (const f of files) {
        for (const r of await readRowsNdjson(path.join(dir, f))) rows.push(r)
      }
      return rows
    }
  } catch { /* no per-symbol dir */ }
  const ndjson = path.join(dataDir, 'backtest-runs', `${runId}.ndjson`)
  if (fs.existsSync(ndjson)) return readRowsNdjson(ndjson)
  const jsonFile = path.join(dataDir, 'backtest-runs', `${runId}.json`)
  if (fs.existsSync(jsonFile)) {
    try { return JSON.parse(await fsp.readFile(jsonFile, 'utf8')) } catch { return [] }
  }
  return []
}

/**
 * Write a learning-bot training-dataset artifact ({generatedAt, config, rows})
 * by streaming — the rows array alone can exceed the JSON.stringify limit.
 * Produces valid JSON that Python's json.load reads without any size limit.
 */
export async function writeDatasetArtifactStreamed(file, { generatedAt, config, rows }) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(file)
    ws.on('error', reject)
    ws.write('{\n')
    ws.write(`  "generatedAt": ${JSON.stringify(generatedAt ?? Date.now())},\n`)
    ws.write(`  "config": ${JSON.stringify(config ?? {})},\n`)
    ws.write('  "rows": [\n')
    let i = 0
    const pump = () => {
      let ok = true
      while (i < rows.length && ok) {
        ok = ws.write((i ? ',\n' : '') + JSON.stringify(rows[i]))
        i += 1
      }
      if (i < rows.length) ws.once('drain', pump)
      else { ws.write('\n  ]\n}\n'); ws.end(resolve) }
    }
    pump()
  })
}
