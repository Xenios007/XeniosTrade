import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AUTO_TRADE_SESSIONS, normalizeAutoTradeSessions } from '../src/lib/tradingSessions.js'

test('an empty or missing list falls back to the 3 named Manila defaults', () => {
  assert.deepEqual(normalizeAutoTradeSessions([]), DEFAULT_AUTO_TRADE_SESSIONS)
  assert.deepEqual(normalizeAutoTradeSessions(undefined), DEFAULT_AUTO_TRADE_SESSIONS)
})

test('a user-authored list of arbitrary length is preserved as-is, not padded/truncated to 3', () => {
  const sessions = [
    { id: 'a', label: 'Session A', startHour: 1, endHour: 3 },
    { id: 'b', label: 'Session B', startHour: 5, endHour: 7 },
    { id: 'c', label: 'Session C', startHour: 9, endHour: 11 },
    { id: 'd', label: 'Session D', startHour: 13, endHour: 15 },
    { id: 'e', label: 'Session E', startHour: 17, endHour: 19 },
  ]
  const result = normalizeAutoTradeSessions(sessions)
  assert.equal(result.length, 5)
  assert.deepEqual(result, sessions)
})

test('SaaS Phase 8H regression: a 4th+ session no longer inherits an unrelated default session\'s hours on repair', () => {
  // Before the fix, a malformed 4th entry (startHour >= endHour) fell back to
  // DEFAULT_AUTO_TRADE_SESSIONS.at(-1) = Manila Night (21-23), regardless of what the user
  // actually typed - this asserts the repaired value is now derived from the entry itself.
  const sessions = [
    { id: 'a', label: 'A', startHour: 1, endHour: 3 },
    { id: 'b', label: 'B', startHour: 5, endHour: 7 },
    { id: 'c', label: 'C', startHour: 9, endHour: 11 },
    { id: 'd', label: 'D', startHour: 14, endHour: 10 }, // invalid: end before start
  ]
  const result = normalizeAutoTradeSessions(sessions)
  const fourth = result[3]
  assert.equal(fourth.startHour, 14)
  assert.equal(fourth.endHour, 15, 'repairs to startHour + 1, not an unrelated default session\'s endHour (23)')
})

test('a missing id/label gets a generic, index-based fallback, not a borrowed default session\'s name', () => {
  const result = normalizeAutoTradeSessions([{ startHour: 2, endHour: 4 }, { startHour: 6, endHour: 8 }, { startHour: 10, endHour: 12 }, { startHour: 14, endHour: 16 }])
  assert.equal(result[3].id, 'session-4')
  assert.equal(result[3].label, 'Session 4')
})

test('hours are clamped into 0-24 and endHour is always after startHour', () => {
  const result = normalizeAutoTradeSessions([{ id: 'x', label: 'X', startHour: -5, endHour: 99 }])
  assert.equal(result[0].startHour, 0)
  assert.equal(result[0].endHour, 24)
})
