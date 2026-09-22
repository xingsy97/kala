import { describe, expect, it } from 'vitest'

import { ModelsRequestError, modelsEndpoint, normalizeModelsHost } from './use-models.js'

describe('models query scope', () => {
  it('normalizes equivalent host URLs to a stable key', () => {
    expect(normalizeModelsHost('https://example.test/')).toBe('https://example.test')
    expect(normalizeModelsHost(' https://example.test/api/ ')).toBe('https://example.test/api')
  })

  it('uses a stable same-origin scope when no host is supplied', () => {
    expect(normalizeModelsHost(undefined)).toBe('same-origin')
  })

  it('resolves model requests against the active host endpoint', () => {
    expect(modelsEndpoint('http://127.0.0.1:5301')).toBe('http://127.0.0.1:5301/models')
    expect(modelsEndpoint(undefined)).toBe('/models')
  })

  it('preserves the response status on request failures', () => {
    const error = new ModelsRequestError(401)
    expect(error.status).toBe(401)
    expect(error.message).toContain('401')
  })
})
