export function parseServiceConfig(source) {
  const value = JSON.parse(source)
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('CONFIG_SCHEMA_INVALID: port must be an integer from 1024 through 65535')
  if (typeof value.greeting !== 'string' || value.greeting.trim() === '') throw new Error('CONFIG_SCHEMA_INVALID: greeting must be a non-empty string')
  return { port: value.port, greeting: value.greeting }
}
