/**
 * runtime-config.ts tests.
 *
 * We construct temporary settings files rather than reading the real
 * `~/.claude/settings.json` — the point is to pin the loader's shape, not
 * the operator's current key.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadRuntimeConfig, parseCodexToml, parseHookConfigToml, loadHookConfigs } from './runtime-config.js'

describe('parseCodexToml', () => {
  it('extracts top-level model + provider block fields', () => {
    const input = [
      'model = "gpt-5.5"',
      'model_provider = "newapi"',
      'unrelated = 42',
      '',
      '[model_providers.newapi]',
      'name = "newapi"',
      'base_url = "https://api.example.test/v1"',
      'env_key = "TK_API_KEY"',
      'wire_api = "responses"',
      '',
      '[model_providers.direct]',
      'name = "Self Hosted"',
      'base_url = "http://gc.example.com/api/openai/v1"',
      'env_key = "GC_API_KEY"',
      '',
      '[projects."/some/path"]',
      'trust_level = "trusted"',
    ].join('\n')
    const out = parseCodexToml(input)
    expect(out.model).toBe('gpt-5.5')
    expect(out.defaultProviderId).toBe('newapi')
    expect(out.providers).toHaveLength(2)
    const [newapi, direct] = out.providers
    expect(newapi!.id).toBe('newapi')
    expect(newapi!.baseUrl).toBe('https://api.example.test/v1')
    expect(newapi!.envKey).toBe('TK_API_KEY')
    expect(direct!.id).toBe('direct')
    expect(direct!.envKey).toBe('GC_API_KEY')
  })

  it('ignores inline comments', () => {
    const out = parseCodexToml('model = "gpt-5.5" # default\n')
    expect(out.model).toBe('gpt-5.5')
  })
})

describe('loadRuntimeConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-runtime-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses claude settings + codex config into a model list, no keys leaked', () => {
    const claudePath = join(dir, 'claude.json')
    const codexPath = join(dir, 'codex.toml')
    writeFileSync(
      claudePath,
      JSON.stringify({
        apiKeyHelper: 'echo test-anthropic-key',
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:33333',
          ANTHROPIC_MODEL: 'claude-opus-4.7-1m-internal',
          ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
        },
      }),
    )
    writeFileSync(
      codexPath,
      [
        'model = "gpt-5.5"',
        'model_provider = "newapi"',
        '[model_providers.newapi]',
        'name = "newapi"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "AK_TEST_TK_KEY"',
      ].join('\n'),
    )
    process.env.AK_TEST_TK_KEY = 'test-openai-key'
    try {
      const cfg = loadRuntimeConfig({
        claudeSettingsPath: claudePath,
        codexConfigPath: codexPath,
      })
      expect(cfg.defaultModel).toBe('gpt-5.5')
      expect(cfg.models.map((m) => m.id)).toEqual([
        'claude-opus-4.7-1m-internal',
        'claude-haiku-4-5',
        'gpt-5.5',
      ])
      expect(cfg.models.map((m) => m.contextWindow)).toEqual([
        1_000_000,
        undefined,
        400_000,
      ])
      expect(cfg.models.map((m) => m.source)).toEqual([
        'claude-settings',
        'claude-settings',
        'codex-config',
      ])
      // Model list is the sanitized DTO — no `apiKey` field on ModelInfo.
      for (const m of cfg.models) {
        expect(m).not.toHaveProperty('apiKey')
      }
      // No gpt-4o slipped through anywhere.
      expect(cfg.models.some((m) => m.id.includes('gpt-4o'))).toBe(false)
      // Providers carry the resolved apiKey in-memory (not exposed to
      // dashboards) — this is what adapter constructors need.
      const anthropic = cfg.providers.find((p) => p.wire === 'anthropic')
      expect(anthropic?.apiKey).toBe('test-anthropic-key')
      expect(anthropic?.baseUrl).toBe('http://127.0.0.1:33333')
      const openai = cfg.providers.find((p) => p.wire === 'openai')
      expect(openai?.apiKey).toBe('test-openai-key')
      expect(openai?.baseUrl).toBe('https://api.example.test/v1')
    } finally {
      delete process.env.AK_TEST_TK_KEY
    }
  })

  it('drops providers whose env key is unset (so nothing loud fails when TK_API_KEY is missing)', () => {
    const codexPath = join(dir, 'codex.toml')
    writeFileSync(
      codexPath,
      [
        'model = "gpt-5.5"',
        'model_provider = "newapi"',
        '[model_providers.newapi]',
        'name = "newapi"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "AK_TEST_UNSET_KEY"',
      ].join('\n'),
    )
    // Point claude path at nothing.
    const cfg = loadRuntimeConfig({
      claudeSettingsPath: join(dir, 'missing.json'),
      codexConfigPath: codexPath,
    })
    expect(cfg.providers).toEqual([])
    expect(cfg.models).toEqual([])
  })

  it('returns empty when both files are missing', () => {
    const cfg = loadRuntimeConfig({
      claudeSettingsPath: join(dir, 'nope1'),
      codexConfigPath: join(dir, 'nope2'),
    })
    expect(cfg.providers).toEqual([])
    expect(cfg.models).toEqual([])
    expect(cfg.defaultModel).toBe('')
  })
})

describe('parseHookConfigToml', () => {
  it('extracts multiple [[hooks]] blocks with optional match', () => {
    const input = [
      '[[hooks]]',
      'event = "pre_tool_use"',
      'match = "bash"',
      'command = "/usr/local/bin/lint-shell.sh"',
      '',
      '[[hooks]]',
      'event = "post_tool_use"',
      'command = "echo done"',
    ].join('\n')
    const out = parseHookConfigToml(input)
    expect(out).toEqual([
      {
        event: 'pre_tool_use',
        command: '/usr/local/bin/lint-shell.sh',
        match: 'bash',
      },
      { event: 'post_tool_use', command: 'echo done' },
    ])
  })

  it('drops blocks with unknown event or missing command', () => {
    const input = [
      '[[hooks]]',
      'event = "not_a_real_event"',
      'command = "true"',
      '',
      '[[hooks]]',
      'event = "session_start"',
      '# no command here',
      '',
      '[[hooks]]',
      'event = "session_end"',
      'command = "notify.sh"',
    ].join('\n')
    const out = parseHookConfigToml(input)
    expect(out).toEqual([{ event: 'session_end', command: 'notify.sh' }])
  })

  it('ignores blocks belonging to other sections', () => {
    const input = [
      '[unrelated]',
      'foo = "bar"',
      '',
      '[[hooks]]',
      'event = "pre_tool_use"',
      'command = "echo hi"',
    ].join('\n')
    const out = parseHookConfigToml(input)
    expect(out).toEqual([{ event: 'pre_tool_use', command: 'echo hi' }])
  })
})

describe('loadHookConfigs', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-hooks-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns [] when file is missing', () => {
    expect(loadHookConfigs(join(dir, 'nope.toml'))).toEqual([])
  })

  it('reads hooks from an explicit path', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(
      path,
      ['[[hooks]]', 'event = "pre_tool_use"', 'command = "echo ok"'].join('\n'),
    )
    const out = loadHookConfigs(path)
    expect(out).toEqual([{ event: 'pre_tool_use', command: 'echo ok' }])
  })
})
