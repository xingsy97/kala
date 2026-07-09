import { describe, expect, it } from 'vitest'

import { resolveRuntimeLoggerPolicy } from './runtime-logger.js'

describe('resolveRuntimeLoggerPolicy', () => {
  it('defaults to info pretty logs', () => {
    expect(resolveRuntimeLoggerPolicy({})).toEqual({
      level: 'info',
      format: 'pretty',
      warnUnknownFormat: false,
    })
  })

  it('accepts json logs and explicit log level', () => {
    expect(resolveRuntimeLoggerPolicy({ LOG_FORMAT: 'json', LOG_LEVEL: 'debug' })).toEqual({
      level: 'debug',
      format: 'json',
      warnUnknownFormat: false,
      requestedFormat: 'json',
    })
  })

  it('treats human as pretty without warning', () => {
    expect(resolveRuntimeLoggerPolicy({ LOG_FORMAT: 'human' })).toEqual({
      level: 'info',
      format: 'pretty',
      warnUnknownFormat: false,
      requestedFormat: 'human',
    })
  })

  it('falls back unknown formats to pretty and asks the logger to warn', () => {
    expect(resolveRuntimeLoggerPolicy({ LOG_FORMAT: 'raw' })).toEqual({
      level: 'info',
      format: 'pretty',
      warnUnknownFormat: true,
      requestedFormat: 'raw',
    })
  })
})
