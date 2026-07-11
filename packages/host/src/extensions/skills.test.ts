import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSkillManager, discoverSkills, runSkillTool, skillToolSchema } from './skills.js'
import { createConfig } from '@agent-kernel/kernel'
import { createBuiltinTools } from '../builtin-tools.js'
import { SessionStore } from '../store/session.js'

describe('skills', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-skills-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeSkill(root: string, name: string, body?: string): string {
    const skillDir = join(root, name)
    mkdirSync(skillDir, { recursive: true })
    const content =
      body ??
      [
        '---',
        `name: ${name}`,
        `description: Use ${name} for focused test coverage.`,
        '---',
        '',
        `# ${name}`,
        '',
        'Follow these instructions.',
      ].join('\n')
    const skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(skillPath, content, 'utf8')
    return skillPath
  }

  it('discovers valid directory skills sorted by name', async () => {
    const root = join(dir, 'skills')
    writeSkill(root, 'zeta-skill')
    writeSkill(root, 'alpha-skill')

    const registry = await discoverSkills([root])

    expect(registry.skills.map((skill) => skill.name)).toEqual([
      'alpha-skill',
      'zeta-skill',
    ])
    expect(registry.get('alpha-skill')?.description).toBe(
      'Use alpha-skill for focused test coverage.',
    )
  })

  it('treats missing skill roots as empty rather than diagnostic noise', async () => {
    const registry = await discoverSkills([join(dir, 'missing-root')])

    expect(registry.skills).toEqual([])
    expect(registry.diagnostics).toEqual([])
  })

  it('skips invalid skills and directory/name mismatches', async () => {
    const root = join(dir, 'skills')
    writeSkill(root, 'valid-skill')
    writeSkill(
      root,
      'bad-name',
      ['---', 'name: BadName', 'description: Invalid uppercase name.', '---'].join('\n'),
    )
    writeSkill(
      root,
      'wrong-dir',
      ['---', 'name: other-name', 'description: Name does not match directory.', '---'].join(
        '\n',
      ),
    )
    writeSkill(root, 'missing-description', ['---', 'name: missing-description', '---'].join('\n'))

    const registry = await discoverSkills([root])

    expect(registry.skills.map((skill) => skill.name)).toEqual(['valid-skill'])
    expect(registry.diagnostics.map((d) => d.message)).toEqual([
      'name must match containing directory',
      'missing required description',
      'name must match containing directory',
    ])
  })

  it('keeps the first duplicate skill name by root priority', async () => {
    const projectRoot = join(dir, 'project')
    const userRoot = join(dir, 'user')
    const projectPath = writeSkill(
      projectRoot,
      'shared-skill',
      [
        '---',
        'name: shared-skill',
        'description: Project skill wins.',
        '---',
        '',
        'PROJECT BODY',
      ].join('\n'),
    )
    writeSkill(
      userRoot,
      'shared-skill',
      [
        '---',
        'name: shared-skill',
        'description: User skill loses.',
        '---',
        '',
        'USER BODY',
      ].join('\n'),
    )

    const registry = await discoverSkills([projectRoot, userRoot])

    expect(registry.skills).toHaveLength(1)
    expect(registry.get('shared-skill')?.path).toBe(projectPath)
    await expect(runSkillTool(registry, { name: 'shared-skill' })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining('PROJECT BODY'),
    })
  })

  it('renders available skills in the loader tool schema', async () => {
    const root = join(dir, 'skills')
    writeSkill(
      root,
      'xml-skill',
      [
        '---',
        'name: xml-skill',
        'description: Use when values include <xml> & quotes.',
        '---',
        '',
        'BODY',
      ].join('\n'),
    )
    const registry = await discoverSkills([root])

    const schema = skillToolSchema(registry.skills)

    expect(schema.name).toBe('skill')
    expect(schema.requiresApproval).toBe(false)
    expect(schema.description).toContain('<available_skills>')
    expect(schema.description).toContain('<name>xml-skill</name>')
    expect(schema.description).toContain(
      '<description>Use when values include &lt;xml&gt; &amp; quotes.</description>',
    )
  })

  it('budgets the available skills list instead of rendering unbounded schema text', async () => {
    const skills = Array.from({ length: 20 }, (_, i) => ({
      name: `skill-${i}`,
      description: 'x'.repeat(900),
      path: join(dir, 'unused', String(i), 'SKILL.md'),
    }))

    const schema = skillToolSchema(skills)

    expect(schema.description.length).toBeLessThan(9_000)
    expect(schema.description).toContain('<omitted count=')
  })

  it('refreshes a session-scoped registry from the session cwd', async () => {
    const workspace = join(dir, 'workspace')
    const store = new SessionStore(join(dir, 'sessions'))
    const config = createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' })
    const record = await store.create({ sessionId: 'sess', config, initialCwd: workspace })
    const manager = createSkillManager(store, config)

    expect((await manager.registryFor(record)).skills).toEqual([])
    writeSkill(join(workspace, '.agents', 'skills'), 'new-skill')

    const registry = await manager.refreshSession(record)

    expect(registry.get('new-skill')?.name).toBe('new-skill')
    await expect(runSkillTool(registry, { name: 'new-skill' })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining('# new-skill'),
    })
  })

  it('keeps skill discovery scoped by workspace cwd', async () => {
    const workspaceA = join(dir, 'a')
    const workspaceB = join(dir, 'b')
    writeSkill(join(workspaceA, '.agents', 'skills'), 'a-skill')
    writeSkill(join(workspaceB, '.agents', 'skills'), 'b-skill')
    const store = new SessionStore(join(dir, 'sessions'))
    const config = createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' })
    const a = await store.create({ sessionId: 'a', config, initialCwd: workspaceA })
    const b = await store.create({ sessionId: 'b', config, initialCwd: workspaceB })
    const manager = createSkillManager(store, config)

    expect((await manager.refreshSession(a)).skills.map((s) => s.name)).toEqual(['a-skill'])
    expect((await manager.refreshSession(b)).skills.map((s) => s.name)).toEqual(['b-skill'])
  })

  it('rejects unknown or malformed skill names', async () => {
    const registry = await discoverSkills([join(dir, 'missing')])

    await expect(runSkillTool(registry, { name: '../bad' })).resolves.toEqual({
      ok: false,
      content: 'skill name must match /^[a-z0-9]+(-[a-z0-9]+)*$/',
    })
    await expect(runSkillTool(registry, { name: 'missing-skill' })).resolves.toEqual({
      ok: false,
      content: 'unknown skill: missing-skill',
    })
  })

  it('refuses oversized skill files instead of injecting them into context', async () => {
    const root = join(dir, 'skills')
    writeSkill(
      root,
      'huge-skill',
      [
        '---',
        'name: huge-skill',
        'description: Use for testing size limits.',
        '---',
        '',
        'x'.repeat(260 * 1024),
      ].join('\n'),
    )
    const registry = await discoverSkills([root])

    const result = await runSkillTool(registry, { name: 'huge-skill' })

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/skill huge-skill is too large:/)
  })
})
