/**
 * Small input helpers for tool runners. We hand-roll type checks instead of
 * pulling in a schema library — the input surface is tiny and each tool owns
 * the shape it needs. All helpers throw {@link ToolError} on validation
 * failure so callers can propagate a stable `ERROR: ...` string.
 */

import { ToolError } from './registry.js'

export function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const v = input[key]
  if (typeof v !== 'string') {
    throw new ToolError('EINVAL', `missing or non-string field "${key}"`)
  }
  return v
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    throw new ToolError('EINVAL', `field "${key}" must be a string`)
  }
  return v
}

export function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') {
    throw new ToolError('EINVAL', `field "${key}" must be a boolean`)
  }
  return v
}

export function optionalPositiveInt(
  input: Record<string, unknown>,
  key: string,
  min = 1,
): number | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ToolError(
      'EINVAL',
      `field "${key}" must be an integer >= ${min}`,
    )
  }
  return v
}
