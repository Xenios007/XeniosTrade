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
const defaultPlan = () => ({ botSlots: 0, signals: [] })

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
   */
  async function findOrCreateUserByEmail(email) {
    const normalized = normalizeEmail(email)
    if (!normalized) throw new Error('findOrCreateUserByEmail: email is required')
    const users = await readUsers()
    const isAdminEmail = normalized === ADMIN_EMAIL
    const existing = findUserByEmail(users, normalized)

    if (existing) {
      if (isAdminEmail && existing.role !== ROLE_ADMIN) {
        existing.role = ROLE_ADMIN
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
