import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { AgentConfig, ToolSchema } from '@agent-kernel/kernel'

import type { SessionRecord, SessionStore } from '../store/session.js'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_SKILL_BYTES = 256 * 1024
const MAX_AVAILABLE_SKILLS_CHARS = 8_000

export const SKILL_TOOL_NAME = 'skill'

export type SkillInfo = {
  readonly name: string
  readonly description: string
  readonly path: string
}

export type SkillDiagnostic = {
  readonly level: 'warning'
  readonly path: string
  readonly message: string
}

export type SkillRegistry = {
  readonly skills: readonly SkillInfo[]
  readonly diagnostics: readonly SkillDiagnostic[]
  get(name: string): SkillInfo | undefined
}

export type SkillManager = {
  readonly kind: 'skill-manager'
  registryFor(record: SessionRecord): Promise<SkillRegistry>
  refreshSession(record: SessionRecord): Promise<SkillRegistry>
  refreshConfig(record: SessionRecord): Promise<void>
  diagnostics(record: SessionRecord): readonly SkillDiagnostic[]
}

export async function discoverSkills(
  roots: readonly string[] = defaultSkillRoots(),
): Promise<SkillRegistry> {
  const byName = new Map<string, SkillInfo>()
  const diagnostics: SkillDiagnostic[] = []
  for (const root of roots) {
    const resolvedRoot = resolve(root)
    if (!existsSync(resolvedRoot)) continue
    let entries: string[]
    try {
      entries = await readdir(resolvedRoot)
    } catch {
      diagnostics.push({ level: 'warning', path: resolvedRoot, message: 'failed to read skill root' })
      continue
    }
    for (const entry of entries.sort()) {
      const skillPath = join(resolvedRoot, entry, 'SKILL.md')
      if (!existsSync(skillPath)) continue
      const parsed = await parseSkillHeader(skillPath, entry)
      if (!parsed.info) {
        diagnostics.push({ level: 'warning', path: skillPath, message: parsed.reason })
        continue
      }
      const info = parsed.info
      if (byName.has(info.name)) {
        diagnostics.push({ level: 'warning', path: skillPath, message: `duplicate skill name skipped: ${info.name}` })
        continue
      }
      byName.set(info.name, info)
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return {
    skills,
    diagnostics,
    get(name) {
      return byName.get(name)
    },
  }
}

export function defaultSkillRoots(): readonly string[] {
  return skillRootsForCwd(process.cwd())
}

export function skillRootsForCwd(cwd: string): readonly string[] {
  return [
    join(resolve(cwd), '.agents', 'skills'),
    join(homedir(), '.agents', 'skills'),
  ]
}

export function createSkillManager(
  store: SessionStore,
  baseConfig: AgentConfig,
): SkillManager {
  const cache = new Map<string, SkillRegistry>()
  const sessionRoots = (record: SessionRecord): readonly string[] =>
    skillRootsForCwd(record.state.cwd ?? process.cwd())
  const cacheKey = (record: SessionRecord): string => sessionRoots(record).join('\0')

  async function load(record: SessionRecord): Promise<SkillRegistry> {
    const key = cacheKey(record)
    const existing = cache.get(key)
    if (existing) return existing
    const registry = await discoverSkills(sessionRoots(record))
    cache.set(key, registry)
    return registry
  }

  async function refresh(record: SessionRecord): Promise<SkillRegistry> {
    const key = cacheKey(record)
    const registry = await discoverSkills(sessionRoots(record))
    cache.set(key, registry)
    return registry
  }

  return {
    kind: 'skill-manager',
    registryFor: load,
    async refreshSession(record) {
      return await refresh(record)
    },
    async refreshConfig(record) {
      const registry = await refresh(record)
      store.updateConfig(record.sessionId, (config) => refreshSkillToolInConfig(config, registry.skills, baseConfig))
    },
    diagnostics(record) {
      return cache.get(cacheKey(record))?.diagnostics ?? []
    },
  }
}

export function isSkillManager(value: SkillRegistry | SkillManager | undefined): value is SkillManager {
  return Boolean(value && 'kind' in value && value.kind === 'skill-manager')
}

export function refreshSkillToolInConfig(
  config: AgentConfig,
  skills: readonly SkillInfo[],
  _baseConfig: AgentConfig = config,
): AgentConfig {
  const nextSkillTool = skillToolSchema(skills)
  const hasSkill = config.tools.some((tool) => tool.name === SKILL_TOOL_NAME)
  if (!hasSkill) return config
  const tools = config.tools.map((tool) => tool.name === SKILL_TOOL_NAME ? nextSkillTool : tool)
  return { ...config, tools }
}

export function skillToolSchema(skills: readonly SkillInfo[]): ToolSchema {
  return {
    name: SKILL_TOOL_NAME,
    description: [
      'Load one reusable agent skill by name. Use this before attempting a task that matches an available skill description. The tool returns the full SKILL.md instructions; supporting files are relative to the skill directory.',
      renderAvailableSkills(skills),
    ].join('\n\n'),
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: 'Skill name from <available_skills>.',
          pattern: SKILL_NAME_PATTERN.source,
        },
      },
    },
    requiresApproval: false,
  }
}

export async function runSkillTool(
  registry: SkillRegistry,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const name = input.name
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, content: 'skill name must match /^[a-z0-9]+(-[a-z0-9]+)*$/' }
  }
  const skill = registry.get(name)
  if (!skill) return { ok: false, content: `unknown skill: ${name}` }
  try {
    const content = await readFile(skill.path, 'utf8')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_SKILL_BYTES) {
      return {
        ok: false,
        content: `skill ${name} is too large: ${bytes} bytes (limit ${MAX_SKILL_BYTES})`,
      }
    }
    return {
      ok: true,
      content: [
        `--- skill: ${skill.name} ---`,
        `path: ${skill.path}`,
        'Use paths in this skill relative to its containing directory.',
        '',
        content,
      ].join('\n'),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, content: `failed to load skill ${name}: ${message}` }
  }
}

function renderAvailableSkills(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return '<available_skills />'
  const lines = ['<available_skills>']
  let used = lines[0]!.length + 1
  let omitted = 0
  for (const skill of skills) {
    const block = [
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      '  </skill>',
    ]
    const length = block.join('\n').length + 1
    if (used + length + '</available_skills>'.length + 1 > MAX_AVAILABLE_SKILLS_CHARS) {
      omitted++
      continue
    }
    lines.push(...block)
    used += length
  }
  if (omitted > 0) {
    lines.push(`  <omitted count="${omitted}" reason="available skills index budget exceeded" />`)
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

async function parseSkillHeader(
  path: string,
  dirName: string,
): Promise<{ info: SkillInfo | null; reason: string }> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return { info: null, reason: 'failed to read SKILL.md' }
  }
  const frontmatter = extractFrontmatter(content)
  if (!frontmatter) return { info: null, reason: 'missing or malformed frontmatter' }
  const name = frontmatter.get('name')
  const description = frontmatter.get('description')
  if (!name) return { info: null, reason: 'missing required name' }
  if (!description) return { info: null, reason: 'missing required description' }
  if (name !== basename(dirName)) return { info: null, reason: 'name must match containing directory' }
  if (!SKILL_NAME_PATTERN.test(name)) return { info: null, reason: 'invalid skill name' }
  const trimmedDescription = description.trim()
  if (
    trimmedDescription.length === 0 ||
    trimmedDescription.length > MAX_DESCRIPTION_LENGTH
  ) {
    return { info: null, reason: `description must be 1-${MAX_DESCRIPTION_LENGTH} characters` }
  }
  return { info: { name, description: trimmedDescription, path }, reason: '' }
}

function extractFrontmatter(content: string): Map<string, string> | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const values = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line?.trim() === '---') return values
    if (!line || line.trim().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    const raw = match[2]!.trim()
    values.set(key, unquote(raw))
  }
  return null
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
