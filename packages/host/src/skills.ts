import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { ToolSchema } from '@agent-kernel/kernel'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_DESCRIPTION_LENGTH = 1024

export const SKILL_TOOL_NAME = 'skill'

export type SkillInfo = {
  readonly name: string
  readonly description: string
  readonly path: string
}

export type SkillRegistry = {
  readonly skills: readonly SkillInfo[]
  get(name: string): SkillInfo | undefined
}

export async function discoverSkills(
  roots: readonly string[] = defaultSkillRoots(),
): Promise<SkillRegistry> {
  const byName = new Map<string, SkillInfo>()
  for (const root of roots) {
    const resolvedRoot = resolve(root)
    if (!existsSync(resolvedRoot)) continue
    let entries: string[]
    try {
      entries = await readdir(resolvedRoot)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      const skillPath = join(resolvedRoot, entry, 'SKILL.md')
      if (!existsSync(skillPath)) continue
      const info = await parseSkillHeader(skillPath, entry)
      if (!info || byName.has(info.name)) continue
      byName.set(info.name, info)
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return {
    skills,
    get(name) {
      return byName.get(name)
    },
  }
}

export function defaultSkillRoots(): readonly string[] {
  return [
    join(process.cwd(), '.agents', 'skills'),
    join(homedir(), '.agents', 'skills'),
  ]
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
  return [
    '<available_skills>',
    ...skills.flatMap((skill) => [
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n')
}

async function parseSkillHeader(
  path: string,
  dirName: string,
): Promise<SkillInfo | null> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const frontmatter = extractFrontmatter(content)
  if (!frontmatter) return null
  const name = frontmatter.get('name')
  const description = frontmatter.get('description')
  if (!name || !description) return null
  if (name !== basename(dirName)) return null
  if (!SKILL_NAME_PATTERN.test(name)) return null
  const trimmedDescription = description.trim()
  if (
    trimmedDescription.length === 0 ||
    trimmedDescription.length > MAX_DESCRIPTION_LENGTH
  ) {
    return null
  }
  return { name, description: trimmedDescription, path }
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
