import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSessionProfile, type PricingTable, type SessionProfile } from '@agent-kernel/shared/enhancement'

import { readSessionLog } from './store/log.js'

export async function profileSession(input: {
  rootDir: string
  sessionLogPath: string
  pricingPath?: string
}): Promise<{ profile: SessionProfile; profilePath: string }> {
  const parsed = await readSessionLog(input.sessionLogPath)
  const pricing = input.pricingPath
    ? JSON.parse(await readFile(input.pricingPath, 'utf8')) as PricingTable
    : undefined
  const profile = createSessionProfile({
    header: parsed.header,
    events: parsed.events,
    ...(pricing ? { pricing } : {}),
  })
  await mkdir(input.rootDir, { recursive: true })
  const profilePath = join(input.rootDir, 'profile.json')
  await writeFile(profilePath, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  return { profile, profilePath }
}
