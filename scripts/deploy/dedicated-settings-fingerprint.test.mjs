import assert from 'node:assert/strict'
import test from 'node:test'
import { dedicatedSettingsFingerprint } from './dedicated-settings-fingerprint.mjs'

const model = { id: 'gpt-4', ref: 'openai-env:gpt-4' }

test('normalizes a unique bare default model to its provider-qualified ref', () => {
  const catalog = { models: [model] }
  assert.equal(
    dedicatedSettingsFingerprint({ defaultModel: 'gpt-4', providers: [] }, catalog),
    dedicatedSettingsFingerprint({ defaultModel: 'openai-env:gpt-4', providers: [] }, catalog),
  )
})

test('retains provider and model drift in the fingerprint', () => {
  const catalog = { models: [model, { id: 'gpt-4', ref: 'other:gpt-4' }] }
  assert.notEqual(
    dedicatedSettingsFingerprint({ defaultModel: 'openai-env:gpt-4', providers: [{ id: 'openai-env', models: [model] }] }, catalog),
    dedicatedSettingsFingerprint({ defaultModel: 'other:gpt-4', providers: [{ id: 'other', models: [{ id: 'gpt-4', ref: 'other:gpt-4' }] }] }, catalog),
  )
  assert.notEqual(
    dedicatedSettingsFingerprint({ defaultModel: 'gpt-4', providers: [] }, catalog),
    dedicatedSettingsFingerprint({ defaultModel: 'openai-env:gpt-4', providers: [] }, catalog),
  )
})
