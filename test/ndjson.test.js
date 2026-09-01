import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  writeRowsNdjson, concatNdjson, readRowsNdjson, iterateRowsNdjson,
  readRunRows, writeDatasetArtifactStreamed,
} from '../server/backtest/ndjson.js'

let dir
test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ndjson-test-'))
})
test.after(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

test('writeRowsNdjson / readRowsNdjson round-trips objects', async () => {
  const rows = [{ a: 1, f: { x: 0.5 } }, { a: 2, f: { x: -0.25 }, s: 'hi' }, { a: 3 }]
  const p = path.join(dir, 'a.ndjson')
  await writeRowsNdjson(p, rows)
  const text = await fsp.readFile(p, 'utf8')
  assert.equal(text.trim().split('\n').length, 3)
  assert.deepEqual(await readRowsNdjson(p), rows)
})

test('concatNdjson merges files in order without loading them', async () => {
  await writeRowsNdjson(path.join(dir, 'p1.ndjson'), [{ n: 1 }, { n: 2 }])
  await writeRowsNdjson(path.join(dir, 'p2.ndjson'), [{ n: 3 }, { n: 4 }])
  const merged = path.join(dir, 'merged.ndjson')
  await concatNdjson(merged, [path.join(dir, 'p1.ndjson'), path.join(dir, 'p2.ndjson')])
  assert.deepEqual((await readRowsNdjson(merged)).map((r) => r.n), [1, 2, 3, 4])
})

test('concatNdjson tolerates a missing source', async () => {
  await writeRowsNdjson(path.join(dir, 'only.ndjson'), [{ n: 9 }])
  const merged = path.join(dir, 'm2.ndjson')
  await concatNdjson(merged, [path.join(dir, 'does-not-exist.ndjson'), path.join(dir, 'only.ndjson')])
  assert.deepEqual(await readRowsNdjson(merged), [{ n: 9 }])
})

test('iterateRowsNdjson yields parsed rows lazily', async () => {
  await writeRowsNdjson(path.join(dir, 'iter.ndjson'), [{ i: 0 }, { i: 1 }, { i: 2 }])
  const seen = []
  for await (const r of iterateRowsNdjson(path.join(dir, 'iter.ndjson'))) seen.push(r.i)
  assert.deepEqual(seen, [0, 1, 2])
})

test('iterateRowsNdjson skips a torn final line', async () => {
  const p = path.join(dir, 'torn.ndjson')
  fs.writeFileSync(p, '{"ok":1}\n{"ok":2}\n{"ok":3', 'utf8') // last line truncated
  const seen = []
  for await (const r of iterateRowsNdjson(p)) seen.push(r.ok)
  assert.deepEqual(seen, [1, 2])
})

test('readRunRows prefers the per-symbol NDJSON dir', async () => {
  const dataDir = path.join(dir, 'data')
  const runDir = path.join(dataDir, 'backtest-runs', 'run-x')
  await fsp.mkdir(runDir, { recursive: true })
  await writeRowsNdjson(path.join(runDir, 'BTCUSDT.ndjson'), [{ symbol: 'BTCUSDT', k: 1 }])
  await writeRowsNdjson(path.join(runDir, 'ETHUSDT.ndjson'), [{ symbol: 'ETHUSDT', k: 2 }])
  await writeRowsNdjson(path.join(runDir, '_manifest.ndjson'), [{ ignored: true }]) // underscore-prefixed skipped
  const rows = await readRunRows(dataDir, 'run-x')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.symbol).sort(), ['BTCUSDT', 'ETHUSDT'])
})

test('readRunRows falls back to merged .ndjson then legacy .json', async () => {
  const dataDir = path.join(dir, 'data2')
  await fsp.mkdir(path.join(dataDir, 'backtest-runs'), { recursive: true })
  await writeRowsNdjson(path.join(dataDir, 'backtest-runs', 'run-m.ndjson'), [{ k: 'a' }, { k: 'b' }])
  assert.equal((await readRunRows(dataDir, 'run-m')).length, 2)
  fs.writeFileSync(path.join(dataDir, 'backtest-runs', 'run-j.json'), JSON.stringify([{ k: 'c' }]))
  assert.deepEqual(await readRunRows(dataDir, 'run-j'), [{ k: 'c' }])
})

test('writeDatasetArtifactStreamed produces JSON that JSON.parse accepts', async () => {
  const p = path.join(dir, 'art.json')
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: i, features: { a: i / 10, b: -i } }))
  await writeDatasetArtifactStreamed(p, { generatedAt: 123, config: { scope: 'test' }, rows })
  const parsed = JSON.parse(await fsp.readFile(p, 'utf8'))
  assert.equal(parsed.generatedAt, 123)
  assert.equal(parsed.config.scope, 'test')
  assert.equal(parsed.rows.length, 250)
  assert.deepEqual(parsed.rows[7], { id: 7, features: { a: 0.7, b: -7 } })
})
