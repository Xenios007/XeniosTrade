import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createUsersStore, findUserByEmail, findUserById, ROLE_ADMIN, ROLE_USER, ADMIN_EMAIL } from '../server/lib/users-store.js'

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xenios-users-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return createUsersStore({ dataDir: dir })
}

test('ADMIN_EMAIL defaults to the seeded admin address', () => {
  assert.equal(ADMIN_EMAIL, 'xeniosgaming87@gmail.com')
})

test('a fresh registry is empty, not an error', async (t) => {
  const store = await fixture(t)
  assert.deepEqual(await store.readUsers(), [])
})

test('first sign-in creates a user; a second sign-in with the same email returns the same one, unchanged', async (t) => {
  const store = await fixture(t)
  const first = await store.findOrCreateUserByEmail('Someone@Example.com')
  assert.equal(first.email, 'someone@example.com', 'normalized to lowercase')
  assert.equal(first.role, ROLE_USER)
  assert.deepEqual(first.plan, { botSlots: 0, signals: [] })
  assert.ok(first.id && first.createdAt)

  const second = await store.findOrCreateUserByEmail('someone@example.com')
  assert.equal(second.id, first.id)
  assert.equal(second.createdAt, first.createdAt)
  assert.equal((await store.readUsers()).length, 1, 'no duplicate row')
})

test('the seeded admin email always becomes role admin, including self-healing an existing non-admin row', async (t) => {
  const store = await fixture(t)
  const admin = await store.findOrCreateUserByEmail(ADMIN_EMAIL)
  assert.equal(admin.role, ROLE_ADMIN)

  // Simulate a stale registry row (e.g. hand-edited, or created before ADMIN_EMAIL was configured).
  const users = await store.readUsers()
  const idx = users.findIndex((u) => u.id === admin.id)
  users[idx] = { ...users[idx], role: ROLE_USER }
  await fs.writeFile(store.registryPath, JSON.stringify(users, null, 2))

  const healed = await store.findOrCreateUserByEmail(ADMIN_EMAIL)
  assert.equal(healed.role, ROLE_ADMIN, 'self-healed back to admin')
  assert.equal(healed.id, admin.id, 'same user, not a duplicate')
})

test('an ordinary user\'s role is never silently changed on a later login', async (t) => {
  const store = await fixture(t)
  const user = await store.findOrCreateUserByEmail('user@example.com')
  await store.updateUserPlan(user.id, {}) // no-op patch, just touches updatedAt
  const users = await store.readUsers()
  users.find((u) => u.id === user.id).role = ROLE_ADMIN // hand-promoted by someone, e.g. a future admin UI
  await fs.writeFile(store.registryPath, JSON.stringify(users, null, 2))

  const again = await store.findOrCreateUserByEmail('user@example.com')
  assert.equal(again.role, ROLE_ADMIN, 'a login never reverts a role change for a non-admin-email user')
})

test('updateUserPlan merges onto the existing plan and rejects an unknown user id', async (t) => {
  const store = await fixture(t)
  const user = await store.findOrCreateUserByEmail('user@example.com')
  const updated = await store.updateUserPlan(user.id, { botSlots: 3 })
  assert.deepEqual(updated.plan, { botSlots: 3, signals: [] })

  const again = await store.updateUserPlan(user.id, { signals: ['zone-reversal-breakout'] })
  assert.deepEqual(again.plan, { botSlots: 3, signals: ['zone-reversal-breakout'] }, 'botSlots preserved across the second patch')

  await assert.rejects(store.updateUserPlan('nope', { botSlots: 1 }), /no user with id/)
})

test('userDataDir/userDataPath are scoped under the store\'s own dataDir, and each user gets a data directory on creation', async (t) => {
  const store = await fixture(t)
  const user = await store.findOrCreateUserByEmail('user@example.com')
  assert.equal(store.userDataDir(user.id), path.join(store.userDataRoot, user.id))
  assert.equal(store.userDataPath(user.id, 'settings.json'), path.join(store.userDataRoot, user.id, 'settings.json'))
  assert.throws(() => store.userDataDir(''), /userId is required/)

  const stat = await fs.stat(store.userDataDir(user.id))
  assert.ok(stat.isDirectory())
})

test('two stores against different dataDirs never see each other\'s users (real isolation, not just a filter)', async (t) => {
  const storeA = await fixture(t)
  const storeB = await fixture(t)
  await storeA.findOrCreateUserByEmail('a@example.com')
  assert.deepEqual(await storeB.readUsers(), [])
})

test('findUserByEmail / findUserById are pure helpers over an already-loaded array, case-insensitive on email', () => {
  const users = [{ id: 'u1', email: 'a@example.com' }, { id: 'u2', email: 'b@example.com' }]
  assert.equal(findUserByEmail(users, 'A@Example.com').id, 'u1')
  assert.equal(findUserByEmail(users, 'nope@example.com'), null)
  assert.equal(findUserById(users, 'u2').id, 'u2')
  assert.equal(findUserById(users, 'nope'), null)
})
