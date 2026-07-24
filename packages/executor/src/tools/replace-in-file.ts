import type { Tool } from './registry.js'
import { optionalBoolean, requireString } from './schema.js'
import { replaceInFileMutation } from '../mutation/engine.js'

export const replaceInFileTool: Tool = {
  name: 'replace_in_file',
  async run(input, ctx) {
    return replaceInFileMutation({
      path: requireString(input, 'path'),
      edits: [{
        oldString: requireString(input, 'old_string'),
        newString: requireString(input, 'new_string'),
        replaceAll: optionalBoolean(input, 'replace_all') ?? false,
      }],
    }, ctx)
  },
}
