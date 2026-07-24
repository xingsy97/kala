import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalBoolean, requireString } from './schema.js'
import { replaceInFileMutation } from '../mutation/engine.js'

export const replaceManyInFileTool: Tool = {
  name: 'replace_many_in_file',
  async run(input, ctx) {
    return replaceInFileMutation({
      path: requireString(input, 'path'),
      edits: parseEdits(input),
    }, ctx)
  },
}

function parseEdits(input: Record<string, unknown>) {
  const raw = input['edits']
  if (!Array.isArray(raw)) throw new ToolError('EINVAL', 'missing or non-array field "edits"')
  if (raw.length === 0) throw new ToolError('EINVAL', 'edits must not be empty')
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError('EINVAL', `edits[${index}] must be an object`)
    const record = item as Record<string, unknown>
    return {
      oldString: requireString(record, 'old_string'),
      newString: requireString(record, 'new_string'),
      replaceAll: optionalBoolean(record, 'replace_all') ?? false,
    }
  })
}
