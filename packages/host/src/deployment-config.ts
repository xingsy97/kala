import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PORTABLE_DEPLOYMENT,
  parseProductDeploymentConfig,
  type ProductDeploymentConfig,
} from '@agent-kernel/shared'

export function loadProductDeploymentConfig(input: {
  configPath?: string
  defaultConfig?: ProductDeploymentConfig
} = {}): ProductDeploymentConfig {
  const path = input.configPath?.trim()
  if (path) {
    const parsed: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'))
    return parseProductDeploymentConfig(parsed)
  }
  return input.defaultConfig ?? PORTABLE_DEPLOYMENT
}
