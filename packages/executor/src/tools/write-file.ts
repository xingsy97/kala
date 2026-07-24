import type { Tool } from './registry.js'
import { requireString } from './schema.js'
import { writeFileMutation } from '../mutation/engine.js'

export const writeFileTool: Tool = {
  name: 'write_file',
  async run(input, ctx) {
    return writeFileMutation({
      path: requireString(input, 'path'),
      content: requireString(input, 'content'),
    }, ctx)
  },
}
