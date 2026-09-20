import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_PROVIDERS, getAiProvider, mergeAiProviderCredentialsUpdate, normalizeAiProviderCredentials,
} from '../src/lib/aiProviders.js'

test('AI_PROVIDERS: every id is unique and the five wired-bot providers exist', () => {
  const ids = AI_PROVIDERS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique')
  for (const id of ['anthropic', 'openai', 'google', 'xai', 'openrouter']) {
    assert.ok(getAiProvider(id), `${id} missing from catalog`)
    assert.ok(getAiProvider(id).wiredBot, `${id} should be marked as wired to a bot`)
  }
})

test('normalizeAiProviderCredentials: drops unknown providers and empty entries, trims strings', () => {
  const normalized = normalizeAiProviderCredentials({
    anthropic: { apiKey: '  sk-ant-123  ', baseUrl: '', model: ' claude-opus-5 ' },
    'not-a-real-provider': { apiKey: 'sk-whatever' },
    openai: { apiKey: '', baseUrl: '', model: '' },
    xai: null,
  })
  assert.deepEqual(Object.keys(normalized), ['anthropic'])
  assert.deepEqual(normalized.anthropic, { apiKey: 'sk-ant-123', baseUrl: '', model: 'claude-opus-5' })
})

test('normalizeAiProviderCredentials: non-object / array input returns an empty map', () => {
  assert.deepEqual(normalizeAiProviderCredentials(null), {})
  assert.deepEqual(normalizeAiProviderCredentials('x'), {})
  assert.deepEqual(normalizeAiProviderCredentials([{ apiKey: 'x' }]), {})
})

test('mergeAiProviderCredentialsUpdate: a blank field in the request keeps the stored value (never wipes it)', () => {
  const current = { anthropic: { apiKey: 'sk-ant-current', baseUrl: '', model: 'claude-opus-5' } }
  const next = mergeAiProviderCredentialsUpdate(current, { anthropic: { apiKey: '', baseUrl: '', model: 'claude-sonnet-5' } })
  assert.deepEqual(next.anthropic, { apiKey: 'sk-ant-current', baseUrl: '', model: 'claude-sonnet-5' })
})

test('mergeAiProviderCredentialsUpdate: a non-blank field replaces the stored value', () => {
  const current = { anthropic: { apiKey: 'sk-ant-old', baseUrl: '', model: '' } }
  const next = mergeAiProviderCredentialsUpdate(current, { anthropic: { apiKey: 'sk-ant-new', baseUrl: '', model: '' } })
  assert.equal(next.anthropic.apiKey, 'sk-ant-new')
})

test('mergeAiProviderCredentialsUpdate: other providers are untouched by a single-provider update', () => {
  const current = {
    anthropic: { apiKey: 'sk-ant', baseUrl: '', model: '' },
    openai: { apiKey: 'sk-openai', baseUrl: '', model: '' },
  }
  const next = mergeAiProviderCredentialsUpdate(current, { anthropic: { apiKey: 'sk-ant-rotated', baseUrl: '', model: '' } })
  assert.equal(next.openai.apiKey, 'sk-openai', 'unrelated provider must survive untouched')
})

test('mergeAiProviderCredentialsUpdate: sending null for a provider removes it entirely', () => {
  const current = {
    anthropic: { apiKey: 'sk-ant', baseUrl: '', model: '' },
    openai: { apiKey: 'sk-openai', baseUrl: '', model: '' },
  }
  const next = mergeAiProviderCredentialsUpdate(current, { anthropic: null })
  assert.deepEqual(Object.keys(next), ['openai'])
})

test('mergeAiProviderCredentialsUpdate: an unknown provider id in the request is ignored', () => {
  const current = { anthropic: { apiKey: 'sk-ant', baseUrl: '', model: '' } }
  const next = mergeAiProviderCredentialsUpdate(current, { 'not-a-real-provider': { apiKey: 'sk-x' } })
  assert.deepEqual(Object.keys(next), ['anthropic'])
})

test('custom slots: unique ids, optional key, labels kept only on custom slots', async () => {
  const { isProviderConnected, isProviderListed, providerDisplayName } = await import('../src/lib/aiProviders.js')
  const slots = AI_PROVIDERS.filter((provider) => provider.customSlot)
  assert.ok(slots.length >= 3)
  assert.ok(slots.every((provider) => provider.keyOptional && provider.baseUrlRequired))

  const normalized = normalizeAiProviderCredentials({
    'custom-2': { apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1', model: 'm', label: '  My vLLM  ' },
    anthropic: { apiKey: 'k', label: 'ignored' },
  })
  assert.equal(normalized['custom-2'].label, 'My vLLM')
  assert.equal('label' in normalized.anthropic, false)

  // Blank label in an update keeps the stored one; a new one replaces it.
  assert.equal(mergeAiProviderCredentialsUpdate(normalized, { 'custom-2': { baseUrl: 'http://x/v1', label: '' } })['custom-2'].label, 'My vLLM')
  assert.equal(mergeAiProviderCredentialsUpdate(normalized, { 'custom-2': { label: 'Other' } })['custom-2'].label, 'Other')

  const custom2 = getAiProvider('custom-2')
  assert.equal(providerDisplayName(custom2, normalized), 'My vLLM')
  assert.equal(providerDisplayName(custom2, {}), custom2.label)
  assert.equal(isProviderConnected(custom2, normalized['custom-2'], false), true)
  assert.equal(isProviderConnected(getAiProvider('openai'), { baseUrl: 'http://x' }, false), false)

  // Only the first empty slot after the last used one is offered.
  assert.equal(isProviderListed(getAiProvider('custom'), {}), true)
  assert.equal(isProviderListed(getAiProvider('custom-2'), {}), false)
  assert.equal(isProviderListed(getAiProvider('custom-2'), { custom: { baseUrl: 'x' } }), true)
  assert.equal(isProviderListed(getAiProvider('custom-3'), { custom: { baseUrl: 'x' } }), false)
  assert.equal(isProviderListed(getAiProvider('custom-3'), normalized), true)
})
