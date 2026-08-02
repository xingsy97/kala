import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalBoolean, optionalString, requireString } from './schema.js'
import { replaceInFileMutation } from '../mutation/engine.js'

export const replaceManyInFileTool: Tool = {
  name: 'replace_many_in_file',
  async run(input, ctx) {
    return replaceInFileMutation({
      path: requireString(input, 'path'),
      expectedRevision: optionalString(input, 'expected_revision') ?? optionalString(input, 'expectedRevision'),
      noOpMode: optionalString(input, 'no_op_mode') === 'skip_noop' ? 'skip_noop' : 'strict',
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
