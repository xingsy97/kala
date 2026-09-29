import { describe, expect, it } from 'vitest'

import { parsePublicListeners, parsePublicUrls, validatePublicRequest } from './public-access.js'

describe('public access policy', () => {
  it('parses explicit IPv4 and IPv6 listeners', () => {
    expect(parsePublicListeners('127.0.0.1:13000,192.0.2.10:13000,[::1]:13000')).toEqual([
      { host: '127.0.0.1', port: 13000 },
      { host: '192.0.2.10', port: 13000 },
      { host: '::1', port: 13000 },
    ])
    expect(() => parsePublicListeners('box.local:13000')).toThrow(/literal IP/u)
    expect(() => parsePublicListeners('127.0.0.1:0')).toThrow(/invalid port/u)
  })

  it('accepts exact public hosts and normalizes origins', () => {
    const policy = parsePublicUrls('http://localhost:13000, https://agent.example.test')

    expect(validatePublicRequest(policy, 'LOCALHOST:13000', 'http://localhost:13000')).toEqual({
      ok: true,
      origin: 'http://localhost:13000',
    })
    expect(validatePublicRequest(policy, 'agent.example.test', 'https://agent.example.test')).toEqual({
      ok: true,
      origin: 'https://agent.example.test',
    })
  })

  it('supports any hostname without allowing a cross-origin caller', () => {
    const policy = parsePublicUrls('http://*:13000')

    expect(validatePublicRequest(policy, 'workspace.example.test:13000', 'http://workspace.example.test:13000')).toEqual({
      ok: true,
      origin: 'http://workspace.example.test:13000',
    })
    expect(validatePublicRequest(policy, 'workspace.example.test:13000', 'https://evil.example')).toEqual({
      ok: false,
      status: 403,
      error: 'ORIGIN_NOT_ALLOWED',
    })
  })

  it('rejects missing, malformed, unlisted, and wrong-port hosts', () => {
    const policy = parsePublicUrls('http://127.0.0.1:13000')

    expect(validatePublicRequest(policy, undefined)).toMatchObject({ ok: false, status: 400 })
    expect(validatePublicRequest(policy, 'user@127.0.0.1:13000')).toMatchObject({ ok: false, status: 400 })
    expect(validatePublicRequest(policy, 'localhost:13000')).toEqual({
      ok: false,
      status: 400,
      error: 'HOST_NOT_ALLOWED',
    })
    expect(validatePublicRequest(policy, '127.0.0.1:13001')).toEqual({
      ok: false,
      status: 400,
      error: 'HOST_NOT_ALLOWED',
    })
  })

  it('normalizes bracketed IPv6 hosts', () => {
    const policy = parsePublicUrls('http://[::1]:13000')

    expect(validatePublicRequest(policy, '[::1]:13000', 'http://[::1]:13000')).toEqual({
      ok: true,
      origin: 'http://[::1]:13000',
    })
  })

  it('rejects unsafe URL shapes and duplicate entries', () => {
    expect(() => parsePublicUrls('')).toThrow(/at least one/u)
    expect(() => parsePublicUrls('ftp://example.test')).toThrow(/invalid public origin/u)
    expect(() => parsePublicUrls('http://example.test/path')).toThrow(/invalid public origin/u)
    expect(() => parsePublicUrls('http://*.example.test:13000')).toThrow(/invalid wildcard/u)
    expect(() => parsePublicUrls('http://localhost:13000,http://localhost:13000')).toThrow(/duplicate/u)
  })
})
