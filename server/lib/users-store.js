// User account registry for the multi-tenant SaaS pivot (see the approved plan:
// robust-orbiting-swan.md, Phase 0). One durable index (the registry array) plus one data
// subtree per user id, mirroring server/backtest/run-registry.js's proven shape: a small
// shared index + one subtree per entity id, atomic tmp-file+rename writes, no database.
//
// This module imports nothing from the server so it can be used (and tested) standalone, same
// as run-registry.js. It owns ONLY identity (who a user is, their role, their entitlements) -
// it does not know about wallets, trades, or settings; those become per-user files under
// userDataDir(userId), wired in a later phase.
//
// createUsersStore({ dataDir }) is the testable factory (same dependency-injection instinct as
// consolidated-testnet.js's createConsolidatedTestnet({ dataDir, ... })). The default export
// below is that factory pre-bound to the app's real server/data - mock-trading-server.js just
// imports the named functions directly; tests construct their own store against a tmpdir.

import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_DATA_DIR = path.join(here, '..', 'data')

// The one seeded admin. An env override exists for local/dev testing without touching the
// account that actually matters; every other email that signs in becomes an ordinary user.
export const ADMIN_EMAIL = (process.env.XENIOS_ADMIN_EMAIL || 'xeniosgaming87@gmail.com').trim().toLowerCase()

export const ROLE_ADMIN = 'admin'
export const ROLE_USER = 'user'

const normalizeEmail = (email) => String(email || '').trim().toLowerCase()

// SaaS Phase 8 (self-service marketplace): botSlots/signals are unchanged (whole-bot
// entitlements, still what drives wallet unlock). signalItems is new and separate - individual
// purchased checklist rows (`${modelId}:${key}`), the unit Bot Creation composes from; owning
// every item of a model does not by itself grant the whole-bot wallet unlock `signals` does.
// symbolSlots starts at 10 per the confirmed product decision. subscriptionTier is a bare flag
// with no consumer yet, deliberately not over-built. customBots lives in the user's own
// settings.json (alongside wallets/strategy), not here - this module only owns identity/plan.
export const defaultPlan = () => ({
  botSlots: 0,
  // Per bought slot: '' (empty), a premade model id, or a custom-bot id. Index i = slot-(i+1).
  botSlotAssignments: [],
  signals: [],
  signalItems: [],
  symbolSlots: 10,
  tradingSymbols: [],
  freeBotClaimed: false,
  subscriptionTier: null,
})

export function findUserByEmail(users, email) {
  const normalized = normalizeEmail(email)
  return users.find((user) => user && normalizeEmail(user.email) === normalized) || null
}

export function findUserById(users, id) {
  return users.find((user) => user && user.id === id) || null
}

export function createUsersStore({ dataDir = DEFAULT_DATA_DIR } = {}) {
  const registryPath = path.join(dataDir, 'users.json')
  const userDataRoot = path.join(dataDir, 'users')

  /** Where a user's own data subtree lives - e.g. userDataDir(id) + '/settings.json' once Phase 1 wires it in. */
  function userDataDir(userId) {
    if (!userId || typeof userId !== 'string') throw new Error('userDataDir: userId is required')
    return path.join(userDataRoot, userId)
  }

  function userDataPath(userId, ...segments) {
    return path.join(userDataDir(userId), ...segments)
  }

  async function ensureUserDataDir(userId) {
    await fs.mkdir(userDataDir(userId), { recursive: true })
  }

  /** Never throws on a missing/corrupt registry - a fresh install has no users.json yet. */
  async function readUsers() {
    try {
      const raw = await fs.readFile(registryPath, 'utf8')
      if (!raw.trim()) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      if (error instanceof SyntaxError) return []
      throw error
    }
  }

  async function writeUsersAtomic(users) {
    await fs.mkdir(dataDir, { recursive: true })
    const tmp = `${registryPath}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(users, null, 2))
    await fs.rename(tmp, registryPath)
  }

  /**
   * Looks up a user by email, creating one on first sign-in. The seeded admin email always
   * ends up role: 'admin' (even if the registry somehow already had a stale non-admin row for
   * it - self-healing on every login, the same instinct as this codebase's settings self-heal);
   * every other email is role: 'user'. An existing user's role is never silently changed by a
   * later login - only the one seeded admin address is force-corrected.
   *
   * Plan shape is self-healed the same way: a user created before a new plan field existed
   * (e.g. symbolSlots, added in SaaS Phase 8) gets that field filled in from defaultPlan() on
   * their next login, not just the next time updateUserPlan happens to touch their plan. Only
   * writes to disk when a key was actually missing - never on a pure key-order difference.
   */
  async function findOrCreateUserByEmail(email) {
    const normalized = normalizeEmail(email)
    if (!normalized) throw new Error('findOrCreateUserByEmail: email is required')
    const users = await readUsers()
    const isAdminEmail = normalized === ADMIN_EMAIL
    const existing = findUserByEmail(users, normalized)

    if (existing) {
      let dirty = false

      if (isAdminEmail && existing.role !== ROLE_ADMIN) {
        existing.role = ROLE_ADMIN
        dirty = true
      }

      const plan = existing.plan || {}
      const missingPlanKeys = Object.keys(defaultPlan()).filter((key) => !(key in plan))
      if (missingPlanKeys.length > 0) {
        existing.plan = { ...defaultPlan(), ...plan }
        dirty = true
      }

      if (dirty) {
        existing.updatedAt = Date.now()
        await writeUsersAtomic(users)
      }
      await ensureUserDataDir(existing.id)
      return existing
    }

    const user = {
      id: crypto.randomUUID(),
      email: normalized,
      role: isAdminEmail ? ROLE_ADMIN : ROLE_USER,
      plan: defaultPlan(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    users.push(user)
    await writeUsersAtomic(users)
    await ensureUserDataDir(user.id)
    return user
  }

  /** Admin-only entitlement grant (Phase 2/5's whole "billing" surface for the test phase). */
  async function updateUserPlan(userId, patch) {
    const users = await readUsers()
    const user = findUserById(users, userId)
    if (!user) throw new Error(`updateUserPlan: no user with id "${userId}"`)
    user.plan = { ...defaultPlan(), ...user.plan, ...patch }
    user.updatedAt = Date.now()
    await writeUsersAtomic(users)
    return user
  }

  async function getUserById(userId) {
    return findUserById(await readUsers(), userId)
  }

  // Phase 1: surfaces that are deliberately NOT per-user yet (AI Trading, Learning Bot,
  // Consolidated/Bot 10, server startup) always resolve to the admin account regardless of
  // who is logged in. Cached per store instance - the admin's id never changes once created,
  // and this is called on nearly every request these subsystems handle.
  let cachedAdminUserId = null
  async function getAdminUserId() {
    if (cachedAdminUserId) return cachedAdminUserId
    const admin = await findOrCreateUserByEmail(ADMIN_EMAIL)
    cachedAdminUserId = admin.id
    return cachedAdminUserId
  }

  return {
    dataDir,
    registryPath,
    userDataRoot,
    userDataDir,
    userDataPath,
    readUsers,
    listUsers: readUsers,
    findOrCreateUserByEmail,
    updateUserPlan,
    getAdminUserId,
    getUserById,
  }
}

// The real, server-facing store - bound to the app's actual server/data directory.
const defaultStore = createUsersStore()
export const userDataDir = defaultStore.userDataDir
export const userDataPath = defaultStore.userDataPath
export const readUsers = defaultStore.readUsers
export const listUsers = defaultStore.listUsers
export const findOrCreateUserByEmail = defaultStore.findOrCreateUserByEmail
export const updateUserPlan = defaultStore.updateUserPlan
export const getAdminUserId = defaultStore.getAdminUserId
export const getUserById = defaultStore.getUserById
