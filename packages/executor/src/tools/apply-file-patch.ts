import type { Tool } from './registry.js'
import { requireString } from './schema.js'
import { applyFilePatchMutation } from '../mutation/engine.js'

export const applyFilePatchTool: Tool = {
  name: 'apply_file_patch',
  async run(input, ctx) {
    return applyFilePatchMutation({ patch: requireString(input, 'patch') }, ctx)
  },
}
