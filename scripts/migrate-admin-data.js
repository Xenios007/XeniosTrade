// One-time migration for the SaaS multi-tenant pivot (Phase 1, see
// C:\Users\Rain\.claude\plans\robust-orbiting-swan.md and the saas-pivot-phase1 memory).
//
// Before this runs, server/mock-trading-server.js reads/writes settings.json and
// trade-history.json (plus auto-trade-log.json, bot-settings-log.json) from a per-user
// subtree under server/data/users/<userId>/,
// which starts out empty for every account including the admin's. This copies the
// operator's own pre-existing flat server/data/*.json files into the admin account's own
// subtree, so the admin's real settings/wallets/trade-history keep showing up after this
// deploy instead of appearing to have vanished.
//
// Copies, never moves or deletes: the original flat files are left exactly where they are
// (some other subsystems - settings-audit-log.json, settings-recovery.json, AI Trading,
// Learning Bot, Consolidated/Bot 10, backtest data - deliberately stay in those flat
// locations; see the "admin-only" comments in mock-trading-server.js). Safe to re-run: a
// destination file that already exists is left untouched, never overwritten, unless --force
// is passed.
//
//   node scripts/migrate-admin-data.js [--dry-run] [--force]

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findOrCreateUserByEmail, ADMIN_EMAIL, userDataPath, userDataDir } from '../server/lib/users-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'server', 'data')

const dryRun = process.argv.includes('--dry-run')
const force = process.argv.includes('--force')

// Exactly the files mock-trading-server.js now reads/writes per-user (see
// userSettingsFilePath / userHistoryFilePath / userAutoTradeLogFilePath /
// userBotSettingsLogFilePath). Deliberately excludes settings-audit-log.json and
// settings-recovery.json, which stay admin-only flat files by design (see the comment above
// getSettings() in mock-trading-server.js), and every other subsystem (AI Trading, Learning
// Bot, Consolidated/Bot 10, backtest data) which is out of scope for this pivot entirely.
const FILES_TO_MIGRATE = [
  'settings.json',
  'trade-history.json',
  'auto-trade-log.json',
  'bot-settings-log.json',
]

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function main() {
  const admin = await findOrCreateUserByEmail(ADMIN_EMAIL)
  console.log(`Admin account: ${admin.email} (${admin.id})`)

  if (!dryRun) {
    await fs.mkdir(userDataDir(admin.id), { recursive: true })
  }

  for (const filename of FILES_TO_MIGRATE) {
    const source = path.join(dataDir, filename)
    const destination = userDataPath(admin.id, filename)

    if (!(await exists(source))) {
      console.log(`  skip   ${filename} (no legacy file)`)
      continue
    }

    if (!force && (await exists(destination))) {
      console.log(`  skip   ${filename} (destination already exists - pass --force to overwrite)`)
      continue
    }

    const stat = await fs.stat(source)
    if (dryRun) {
      console.log(`  would copy ${filename} (${(stat.size / 1024).toFixed(1)} KB) -> ${destination}`)
      continue
    }

    await fs.copyFile(source, destination)
    console.log(`  copied ${filename} (${(stat.size / 1024).toFixed(1)} KB) -> ${destination}`)
  }

  console.log(dryRun ? '\nDry run only - nothing was written.' : '\nDone.')
}

main().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
