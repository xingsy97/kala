import process from 'node:process'

import pino, { type Logger, type LoggerOptions } from 'pino'
import pinoPretty from 'pino-pretty'

export type RuntimeLogFormat = 'json' | 'pretty'

export type RuntimeLoggerPolicy = {
  level: string
  format: RuntimeLogFormat
  warnUnknownFormat: boolean
  requestedFormat?: string
}

const REDACT_PATHS = [
  'apiKey',
  '*.apiKey',
  '*.authorization',
  '*.token',
  '*.password',
  'authorization',
  'token',
  'password',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'HOST_AUTH_TOKEN',
  'EXECUTOR_TOKEN',
  'process.env.ANTHROPIC_API_KEY',
  'process.env.OPENAI_API_KEY',
  'process.env.HOST_AUTH_TOKEN',
  'process.env.EXECUTOR_TOKEN',
]

export type RuntimeLogger = Logger

export function createRuntimeLogger(name: string): RuntimeLogger {
  const policy = resolveRuntimeLoggerPolicy(process.env)
  const options: LoggerOptions = {
    name,
    level: policy.level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[redacted]',
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  }

  if (policy.format === 'json') {
    return pino(options, pino.destination({ fd: 2, sync: true }))
  }

  const logger = pino(
    options,
    pinoPretty({
      colorize: process.stderr.isTTY,
      destination: 2,
      ignore: 'pid,hostname',
      singleLine: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    }),
  )

  if (policy.warnUnknownFormat) {
    logger.warn({ format: policy.requestedFormat }, 'unknown LOG_FORMAT; using pretty logs')
  }

  return logger
}

export function resolveRuntimeLoggerPolicy(env: { LOG_FORMAT?: string; LOG_LEVEL?: string }): RuntimeLoggerPolicy {
  const requestedFormat = env.LOG_FORMAT
  const normalizedFormat = (requestedFormat ?? 'pretty').toLowerCase()
  const format: RuntimeLogFormat = normalizedFormat === 'json' ? 'json' : 'pretty'
  return {
    level: env.LOG_LEVEL ?? 'info',
    format,
    warnUnknownFormat: requestedFormat !== undefined && normalizedFormat !== 'pretty' && normalizedFormat !== 'human' && normalizedFormat !== 'json',
    ...(requestedFormat !== undefined ? { requestedFormat } : {}),
  }
}
