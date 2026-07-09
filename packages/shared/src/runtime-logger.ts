import process from 'node:process'

import pino, { type Logger, type LoggerOptions } from 'pino'
import pinoPretty from 'pino-pretty'

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
  const format = (process.env.LOG_FORMAT ?? 'pretty').toLowerCase()
  const options: LoggerOptions = {
    name,
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[redacted]',
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  }

  if (format === 'json') {
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

  if (format !== 'pretty' && format !== 'human') {
    logger.warn({ format: process.env.LOG_FORMAT }, 'unknown LOG_FORMAT; using pretty logs')
  }

  return logger
}
