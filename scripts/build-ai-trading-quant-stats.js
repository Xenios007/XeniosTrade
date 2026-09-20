// Aggregates server/data/backtest-history.json (~116 MB, one pretty-printed JSON
// array) into the small bucket table the AI Trading Quant Agent reads at runtime.
// Streams line-by-line so it never holds the whole file — relies on the file's
// JSON.stringify(rows, null, 2) layout (each row is a "  {" ... "  }," block).
//
//   npm run ai-trading:quant-stats [-- path/to/history.json]

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createQuantStatsAccumulator, QUANT_STATS_FILE } from '../server/ai-trading/quant-stats.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const input = process.argv[2] || path.join(__dirname, '..', 'server', 'data', 'backtest-history.json')

const accumulator = createQuantStatsAccumulator()
let block = null
let rowsSeen = 0

const lines = readline.createInterface({ input: fs.createReadStream(input, 'utf8'), crlfDelay: Infinity })
for await (const line of lines) {
  if (line === '  {') {
    block = ['{']
  } else if (block && (line === '  }' || line === '  },')) {
    block.push('}')
    accumulator.add(JSON.parse(block.join('\n')))
    rowsSeen += 1
    block = null
  } else if (block) {
    block.push(line)
  }
}

if (rowsSeen === 0) {
  console.error(`No rows parsed from ${input} — is it a pretty-printed JSON array?`)
  process.exit(1)
}

const stats = accumulator.finalize(path.basename(input))
await fsp.mkdir(path.dirname(QUANT_STATS_FILE), { recursive: true })
await fsp.writeFile(QUANT_STATS_FILE, JSON.stringify(stats), 'utf8')
console.log(`Wrote ${QUANT_STATS_FILE}: ${stats.tradeCount} trades in ${Object.keys(stats.buckets).length} buckets.`)
