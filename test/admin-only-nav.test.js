import test from 'node:test'
import assert from 'node:assert/strict'
import { filterAdminOnlyNav } from '../src/components/shell/navItems.js'

const sampleGroups = [
  {
    label: 'Trading',
    items: [
      {
        to: '/dashboard',
        label: 'Dashboard',
        children: [
          { to: '/dashboard', label: 'Overview' },
          { to: '/dashboard/codex', label: 'Codex Console' },
        ],
      },
    ],
  },
  {
    label: 'Consolidated Knowledge',
    items: [{ to: '/consolidated-knowledge', label: 'Consolidated Knowledge' }],
  },
  {
    label: 'Analysis',
    items: [
      {
        to: '/journal',
        label: 'Journal',
        children: [
          { to: '/journal', label: 'Summary' },
          { to: '/journal/head-to-head', label: 'Head to Head' },
        ],
      },
      { to: '/ai-training', label: 'AI Training' },
    ],
  },
]

test('filterAdminOnlyNav: an admin sees every group and item unchanged', () => {
  const result = filterAdminOnlyNav(sampleGroups, true)
  assert.equal(result, sampleGroups, 'returns the same reference - no filtering work done for an admin')
})

test('filterAdminOnlyNav: a non-admin loses the Consolidated Knowledge group entirely', () => {
  const result = filterAdminOnlyNav(sampleGroups, false)
  assert.equal(result.find((group) => group.label === 'Consolidated Knowledge'), undefined)
})

test('filterAdminOnlyNav: a non-admin loses the AI Training item from Analysis, keeps Journal', () => {
  const result = filterAdminOnlyNav(sampleGroups, false)
  const analysis = result.find((group) => group.label === 'Analysis')
  assert.equal(analysis.items.find((item) => item.to === '/ai-training'), undefined)
  assert.ok(analysis.items.find((item) => item.to === '/journal'), 'unrelated items are untouched')
})

test('filterAdminOnlyNav: a non-admin loses the Codex Console child link, keeps its siblings', () => {
  const result = filterAdminOnlyNav(sampleGroups, false)
  const dashboard = result.find((group) => group.label === 'Trading').items.find((item) => item.to === '/dashboard')
  assert.equal(dashboard.children.find((child) => child.to === '/dashboard/codex'), undefined)
  assert.ok(dashboard.children.find((child) => child.to === '/dashboard'), 'unrelated children are untouched')
})

test('filterAdminOnlyNav: a non-admin loses the Head to Head child link, keeps Summary', () => {
  const result = filterAdminOnlyNav(sampleGroups, false)
  const journal = result.find((group) => group.label === 'Analysis').items.find((item) => item.to === '/journal')
  assert.equal(journal.children.find((child) => child.to === '/journal/head-to-head'), undefined)
  assert.ok(journal.children.find((child) => child.to === '/journal'), 'unrelated children are untouched')
})

test('filterAdminOnlyNav: a group left with zero items after filtering is dropped, not shown empty', () => {
  const onlyAdminGroup = [{ label: 'Consolidated Knowledge', items: [{ to: '/consolidated-knowledge', label: 'x' }] }]
  const result = filterAdminOnlyNav(onlyAdminGroup, false)
  assert.deepEqual(result, [])
})
