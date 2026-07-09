import process from 'node:process'

import pino, { type Logger, type LoggerOptions } from 'pino'

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

export function createRuntimeLogger(name: string): Logger {
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

  if (process.env.LOG_FORMAT === 'pretty') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: process.stderr.isTTY,
          ignore: 'pid,hostname',
          translateTime: 'SYS:standard',
        },
      },
    })
  }

  return pino(options)
}
