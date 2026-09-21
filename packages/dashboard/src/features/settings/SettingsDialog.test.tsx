import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachedExecutor, ServerSettingsPayload } from '@agent-kernel/shared'

import { SettingsDialog } from './SettingsDialog.js'
import { i18n } from '../../i18n/index.js'

const payload: ServerSettingsPayload = {
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic',
      wire: 'anthropic',
      source: 'claude-settings',
      baseUrl: 'http://private-3.example.com/v1',
      models: [
        { id: 'claude-opus-4-7', label: 'claude-opus-4-7', provider: 'Anthropic', providerId: 'anthropic', source: 'claude-settings' },
        { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', provider: 'Anthropic', providerId: 'anthropic', source: 'claude-settings' },
        { id: 'claude-haiku-4-6', label: 'claude-haiku-4-6', provider: 'Anthropic', providerId: 'anthropic', source: 'manual' },
      ],
    },
    {
      id: 'openai-compat',
      label: 'internal-router',
      wire: 'openai',
      source: 'codex-config',
      models: [],
    },
  ],
  defaultModel: 'claude-opus-4-7',
  hooks: [
    { event: 'pre_tool_use', match: 'bash', command: '/usr/local/bin/lint.sh' },
    { event: 'post_tool_use', command: '/usr/local/bin/log.sh' },
  ],
  versions: {
    host: '0.0.0',
    protocol: '1.0.0',
    build: {
      releaseTag: 'test-release',
      gitCommit: 'abc123',
      builtAt: '2026-07-15T00:00:00.000Z',
      artifactKind: 'cjs',
      dashboardMode: 'embedded',
      embeddedDashboardFiles: 42,
    },
  },
  socketConnections: {
    total: 3,
    dashboard: 2,
    executor: 1,
    other: 0,
    namespaces: [
      { namespace: '/dashboard', sockets: 2, dashboard: 2, executor: 0, other: 0 },
      { namespace: '/executor', sockets: 1, dashboard: 0, executor: 1, other: 0 },
    ],
    updatedAt: '2026-07-20T00:00:00.000Z',
  },
  agentPrompt: {
    selectedPreset: 'codex',
    presets: [
      { id: 'codex', label: 'Codex', description: 'Direct coding-agent prompt.' },
      { id: 'claude-code', label: 'Claude Code', description: 'Concise pair-programming prompt.' },
      { id: 'custom', label: 'Custom', description: 'Editable prompt.' },
    ],
    customPrompt: 'Codex prompt\n\nWhen referencing a file, use [filename](path/to/this/file).',
    configPath: '<home>/.config/agent-kernel/agent.json',
  },
  paths: {
    claudeSettings: '<home>/.claude/settings.json',
    codexConfig: '<home>/.codex/config.toml',
    manualModels: '<home>/.config/agent-kernel/models.json',
    hooksConfig: '<home>/.config/agent-kernel/config.toml',
    sessionsDir: '<home>/.agent-kernel/sessions',
  },
  mcp: {
    supported: false,
    note: 'MCP runtime is not implemented yet — see docs/host/mcp.md for the planned design.',
  },
  socketAdmin: {
    active: true,
    initialized: true,
    path: '/admin/socket.io',
    username: 'admin',
    runtimeMode: 'production',
    configuredMode: 'production',
    configPath: '<home>/.config/agent-kernel/socket-admin.json',
    distSource: 'embedded',
    createdAt: '2026-07-20T00:00:00.000Z',
  },
}

async function waitForSettingsLoaded(): Promise<void> {
  await screen.findByText('Service endpoint')
}

describe('SettingsDialog', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not render when closed', () => {
    render(<SettingsDialog open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId('settings-dialog')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches /settings on open and shows connection settings by default', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings', { cache: 'no-store' })
    })

    await waitForSettingsLoaded()
    expect(screen.getByText('Override host endpoint')).toBeTruthy()
  })

  it('keeps connection help hidden but cross-origin requirements and failures visible', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    expect(screen.queryByText(i18n.t('settings.connection.priority'))).toBeNull()
    expect(screen.queryByText('AGENT_KERNEL_ALLOWED_ORIGINS')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Override host endpoint' }))
    expect(screen.getByRole('tooltip').textContent).toContain('AGENT_KERNEL_ALLOWED_ORIGINS')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.change(screen.getByTestId('settings-connection-endpoint'), { target: { value: 'https://other.example' } })
    expect(screen.getByText('AGENT_KERNEL_ALLOWED_ORIGINS').closest('[data-description-kind="notice"]')).toBeTruthy()
    fetchMock.mockRejectedValueOnce(new Error('Controlled connection failure'))
    fireEvent.click(screen.getByTestId('settings-connection-test'))
    expect((await screen.findByRole('alert')).textContent).toContain('Controlled connection failure')
    fireEvent.change(screen.getByTestId('settings-connection-endpoint'), { target: { value: 'invalid' } })
    expect(screen.queryByText('AGENT_KERNEL_ALLOWED_ORIGINS')).toBeNull()
  })

  it.each(['query', 'build'])('shows cross-origin requirements for the effective %s endpoint even with an empty draft', async (source) => {
    const previousUrl = window.location.href
    const remote = 'https://remote-host.example'
    if (source === 'query') window.history.replaceState(null, '', `?host=${encodeURIComponent(remote)}`)
    else vi.stubEnv('VITE_AGENT_KERNEL_HOST', remote)
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
    const view = render(<SettingsDialog open onOpenChange={() => {}} />)
    try {
      await waitForSettingsLoaded()
      expect(screen.getByText(remote)).toBeTruthy()
      expect((screen.getByTestId('settings-connection-endpoint') as HTMLInputElement).value).toBe('')
      expect(screen.getByText('AGENT_KERNEL_ALLOWED_ORIGINS').closest('[data-description-kind="notice"]')).toBeTruthy()
      fireEvent.change(screen.getByTestId('settings-connection-endpoint'), { target: { value: window.location.origin } })
      expect(screen.getByText('AGENT_KERNEL_ALLOWED_ORIGINS').closest('[data-description-kind="notice"]')).toBeTruthy()
    } finally {
      view.unmount()
      window.history.replaceState(null, '', previousUrl)
      vi.unstubAllEnvs()
    }
  })

  it('preserves full interface help, mobile section explanations and direct risk notices', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    fireEvent.change(screen.getByTestId('settings-mobile-section-select'), { target: { value: 'interface' } })
    const help = screen.getAllByRole('button', { name: 'About Interface' })[0]!
    expect(help.closest('label')).toBeNull()
    fireEvent.click(help)
    expect(screen.getByRole('tooltip').textContent).toContain(i18n.t('settings.interface.subtitle'))
    fireEvent.keyDown(document, { key: 'Escape' })
    for (const key of ['chatFontSize', 'fileViewFontSize', 'sessionExplorerFontSize', 'fileExplorerFontSize', 'chatContentWidth', 'chatSideSpace', 'chatLineHeight', 'chatMathScale']) {
      const description = i18n.t(`settings.interface.${key}Desc`)
      expect(screen.queryByText(description)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: `About ${i18n.t(`settings.interface.${key}`)}` }))
      expect(screen.getByRole('tooltip').textContent).toBe(description)
      fireEvent.keyDown(document, { key: 'Escape' })
    }
    expect(document.querySelector('button button')).toBeNull()
    fireEvent.click(screen.getByTestId('settings-tab-hooks'))
    expect(screen.getByText(i18n.t('settings.hooks.subtitle')).getAttribute('data-description-kind')).toBe('notice')
    fireEvent.click(screen.getByTestId('settings-tab-approvals'))
    expect(screen.getByText(i18n.t('settings.approvals.subtitle')).getAttribute('data-description-kind')).toBe('notice')
    expect(screen.getByText('AK_ALLOW_ALL_OK=1')).toBeTruthy()
  })

  it('configures, tests, and removes web search', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ configured: false, provider: 'serper' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-webSearch'))
    expect(await screen.findByText('Not configured')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/settings/web-search', { cache: 'no-store' })

    fireEvent.change(screen.getByTestId('settings-web-search-api-key'), { target: { value: 'serper-secret' } })
    fireEvent.click(screen.getByTestId('settings-web-search-save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/web-search', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ provider: 'serper', apiKey: 'serper-secret' }),
    })))

    fireEvent.click(await screen.findByTestId('settings-web-search-test'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/web-search/test', { method: 'POST' }))

    fireEvent.click(screen.getByTestId('settings-web-search-delete'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/web-search', { method: 'DELETE' }))
    expect(await screen.findByText('Web search configuration removed.')).toBeTruthy()
  })

  it('executes connection test, save, failure, and reset states', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    const endpoint = screen.getByTestId('settings-connection-endpoint') as HTMLInputElement
    fireEvent.change(endpoint, { target: { value: 'http://example.test:4000' } })
    fireEvent.click(screen.getByTestId('settings-connection-test'))
    await waitFor(() => expect(screen.getByTestId('settings-connection-result').textContent).toContain('reachable'))
    fireEvent.click(screen.getByTestId('settings-connection-save'))
    expect(localStorage.getItem('agent-kernel:host-endpoint')).toBe('http://example.test:4000')
    fireEvent.change(endpoint, { target: { value: 'http://broken.test:4000' } })
    fireEvent.click(screen.getByTestId('settings-connection-test'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HTTP 503'))
    fireEvent.click(screen.getByTestId('settings-connection-reset'))
    expect(localStorage.getItem('agent-kernel:host-endpoint')).toBeNull()
    expect(endpoint.value).toBe('')
  })

  it('keeps section content width-bounded instead of relying on horizontal scrolling', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    const content = screen.getByTestId('settings-responsive-content')
    expect(content.className).toContain('max-w-full')
    expect(content.className).toContain('overflow-x-hidden')

    fireEvent.click(screen.getByTestId('settings-tab-runtime'))
    const paths = await screen.findByTestId('settings-runtime-paths')
    expect(paths.querySelector('table')).toBeNull()
    expect(paths.className).not.toContain('overflow-x-auto')
  })

  it('uses a mobile-safe settings shell', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    const dialog = screen.getByTestId('settings-dialog')
    expect(dialog.className).toContain('!bottom-0')
    expect(dialog.className).toContain('max-h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-0.5rem)]')
    expect(dialog.className).toContain('w-screen')
    expect(dialog.className).toContain('rounded-t-2xl')
    expect(dialog.className).toContain('sm:max-w-5xl')
    expect(screen.getByTestId('settings-dialog-close').className).toContain('h-11')
    const mobileSelect = screen.getByTestId('settings-mobile-section-select') as HTMLSelectElement
    expect(mobileSelect.className).toContain('opacity-0')
    expect(screen.getByTestId('settings-mobile-section-picker').textContent).toContain('Connection')
    expect(mobileSelect.value).toBe('connection')
    fireEvent.change(mobileSelect, { target: { value: 'approvals' } })
    expect(await screen.findByRole('heading', { name: 'Approvals' })).toBeTruthy()
    expect(screen.getByTestId('settings-tab-connection').className).toContain('md:w-full')
  })

  it('shows current Socket.IO connection audit counts in deployment settings', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-deployment'))

    const panel = await screen.findByTestId('settings-socket-connections')
    expect(panel.textContent).toContain('Socket.IO connections')
    expect(panel.textContent).toContain('3 active sockets')
    expect(panel.textContent).toContain('/dashboard: 2 sockets')
    expect(panel.textContent).toContain('/executor: 1 sockets')
  })

  it('switches to Models tab and lists providers + default model', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))

    const anthropic = await screen.findByTestId('settings-provider-anthropic')
    expect(anthropic.textContent).toContain('Anthropic')
    expect(anthropic.textContent).toContain('claude-opus-4-7')
    expect(anthropic.textContent).toContain('claude-sonnet-4-6')
    expect(anthropic.textContent).toContain('claude-haiku-4-6')
    expect(anthropic.textContent).toContain('default provider')
    expect(anthropic.textContent).toContain('Claude Code')
    expect(anthropic.textContent).toContain('Manual')

    const other = screen.getByTestId('settings-provider-openai-compat')
    expect(other.textContent).toContain('No model attached')
  })

  it('shows the self-hosted Socket.IO Admin UI endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-socketAdmin'))

    expect(await screen.findByText('Admin UI endpoint')).toBeTruthy()
    expect(screen.getByText('/admin/socket.io')).toBeTruthy()
    expect(screen.getByText('admin')).toBeTruthy()
    expect(screen.getByText('embedded in host bundle')).toBeTruthy()
  })

  it('initializes the Socket.IO Admin UI password once', async () => {
    const uninitialized: ServerSettingsPayload = {
      ...payload,
      socketAdmin: {
        active: false,
        initialized: false,
        path: '/admin/socket.io',
        username: 'admin',
        runtimeMode: 'development',
        configuredMode: 'development',
        configPath: '<home>/.config/agent-kernel/socket-admin.json',
      },
    }
    const initialized: ServerSettingsPayload = {
      ...payload,
      socketAdmin: { ...payload.socketAdmin!, active: true },
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(uninitialized), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(initialized), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(initialized), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-socketAdmin'))
    fireEvent.change(await screen.findByLabelText('Initial password'), { target: { value: 'secret-password' } })
    fireEvent.change(screen.getByTestId('settings-socket-admin-initial-mode-select'), { target: { value: 'development' } })
    fireEvent.click(screen.getByText('Initialize password'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/socket-admin/init', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: 'secret-password', mode: 'development' }),
      }))
    })
    expect(await screen.findByText('Admin UI endpoint')).toBeTruthy()
    expect(screen.queryByText('Password initialized. Restart the host to enable Socket.IO Admin UI.')).toBeNull()
  })

  it('updates the Socket.IO Admin UI mode', async () => {
    const nextPayload: ServerSettingsPayload = {
      ...payload,
      socketAdmin: { ...payload.socketAdmin!, configuredMode: 'development', restartRequired: true },
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-socketAdmin'))
    fireEvent.change(await screen.findByTestId('settings-socket-admin-mode-select'), { target: { value: 'development' } })
    fireEvent.click(screen.getByTestId('settings-socket-admin-save-mode'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/socket-admin/mode', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'development' }),
      }))
    })
    expect(await screen.findByTestId('settings-socket-admin-restart-required')).toBeTruthy()
    expect(screen.getByTestId('settings-socket-admin-restart-required').textContent).toContain('Current host is running production')
    expect(screen.getByTestId('settings-socket-admin-restart-required').textContent).toContain('configured mode is development')
    expect(screen.getByTestId('settings-socket-admin-save-mode')).toBeTruthy()
  })

  it('updates the agent prompt preset', async () => {
    const nextPayload: ServerSettingsPayload = {
      ...payload,
      agentPrompt: payload.agentPrompt ? { ...payload.agentPrompt, selectedPreset: 'claude-code' } : undefined,
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-agent'))
    fireEvent.click(await screen.findByTestId('settings-agent-preset-claude-code'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/agent-prompt', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ preset: 'claude-code' }),
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('settings-agent-preset-claude-code').getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('edits and saves the custom system prompt', async () => {
    const customPayload: ServerSettingsPayload = {
      ...payload,
      agentPrompt: payload.agentPrompt ? { ...payload.agentPrompt, selectedPreset: 'custom' } : undefined,
    }
    const savedPayload: ServerSettingsPayload = {
      ...customPayload,
      agentPrompt: customPayload.agentPrompt ? { ...customPayload.agentPrompt, customPrompt: 'My custom prompt' } : undefined,
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(customPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(savedPayload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-agent'))
    const editor = await screen.findByTestId('settings-agent-custom-prompt')
    fireEvent.change(editor, { target: { value: 'My custom prompt' } })
    fireEvent.click(screen.getByTestId('settings-agent-custom-prompt-save'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/agent-prompt', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ preset: 'custom', customPrompt: 'My custom prompt' }),
      }))
    })
  })

  it('does not label missing source metadata as manual', async () => {
    const sourceLess: ServerSettingsPayload = {
      ...payload,
      providers: [
        {
          id: 'legacy-provider',
          label: 'legacy-provider',
          wire: 'openai',
          models: [{ id: 'gpt-legacy', label: 'gpt-legacy', provider: 'legacy-provider', providerId: 'legacy-provider' }],
        },
      ],
    }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(sourceLess), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    const provider = await screen.findByTestId('settings-provider-legacy-provider')
    expect(provider.textContent).toContain('Unknown')
    expect(provider.textContent).not.toContain('Manual')
    expect(screen.queryByLabelText('delete model gpt-legacy')).toBeNull()
  })

  it('adds and deletes manual models', async () => {
    const nextPayload: ServerSettingsPayload = {
      ...payload,
      providers: payload.providers.map((p) => p.id === 'openai-compat'
        ? {
            ...p,
            models: [{ ref: 'openai-compat:gpt-5.5-mini', id: 'gpt-5.5-mini', label: 'GPT 5.5 Mini', provider: p.label, providerId: p.id, source: 'manual', contextWindow: 123456 }],
          }
        : p),
    }
    const onModelsChanged = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} onModelsChanged={onModelsChanged} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    fireEvent.change(screen.getByTestId('settings-model-provider-select'), { target: { value: 'openai-compat' } })
    fireEvent.change(screen.getByTestId('settings-model-id-input'), { target: { value: 'gpt-5.5-mini' } })
    fireEvent.change(screen.getByTestId('settings-model-context-window-input'), { target: { value: '123456' } })
    fireEvent.click(screen.getByTestId('settings-model-add-button'))

    await screen.findByText('gpt-5.5-mini')
    expect(screen.getByTestId('settings-provider-openai-compat').textContent).toContain('123,456')
    expect(fetchMock).toHaveBeenCalledWith('/settings/models', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ providerId: 'openai-compat', id: 'gpt-5.5-mini', contextWindow: 123456 }),
    }))
    expect(onModelsChanged).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('delete model gpt-5.5-mini'))
    await screen.findByText(/No model attached/)
    expect(fetchMock).toHaveBeenCalledWith('/settings/models?providerId=openai-compat&id=gpt-5.5-mini', { method: 'DELETE' })
    expect(onModelsChanged).toHaveBeenCalledTimes(2)
  })

  it('sets the default model by provider-qualified ref', async () => {
    const modelPayload: ServerSettingsPayload = {
      ...payload,
      providers: payload.providers.map((p) => p.id === 'openai-compat'
        ? { ...p, models: [{ ref: 'openai-compat:gpt-shared', id: 'gpt-shared', label: 'GPT Shared', provider: p.label, providerId: p.id, source: 'manual' }] }
        : p),
    }
    const nextPayload: ServerSettingsPayload = { ...modelPayload, defaultModel: 'openai-compat:gpt-shared' }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(modelPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    fireEvent.click(await screen.findByRole('button', { name: 'set default model openai-compat:gpt-shared' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/default-model', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'openai-compat:gpt-shared' }),
      }))
    })
    expect(await screen.findByText('default')).toBeTruthy()
  })

  it('adds and deletes manual providers without rendering API keys', async () => {
    const withProvider: ServerSettingsPayload = {
      ...payload,
      providers: [
        ...payload.providers,
        {
          id: 'local-openai',
          label: 'Local OpenAI',
          wire: 'openai',
          source: 'manual',
          baseUrl: 'http://localhost:8000/v1',
          models: [],
        },
      ],
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(withProvider), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    fireEvent.change(screen.getByTestId('settings-provider-id-input'), { target: { value: 'local-openai' } })
    fireEvent.change(screen.getByTestId('settings-provider-label-input'), { target: { value: 'Local OpenAI' } })
    fireEvent.change(screen.getByTestId('settings-provider-base-url-input'), { target: { value: 'http://localhost:8000/v1' } })
    fireEvent.change(screen.getByTestId('settings-provider-api-key-input'), { target: { value: 'test-redacted-api-key' } })
    fireEvent.click(screen.getByRole('button', { name: /add provider/i }))

    const provider = await screen.findByTestId('settings-provider-local-openai')
    expect(provider.textContent).toContain('Local OpenAI')
    expect(provider.textContent).toContain('http://localhost:8000/v1')
    expect(screen.queryByText('test-redacted-api-key')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/settings/providers', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        id: 'local-openai',
        label: 'Local OpenAI',
        wire: 'openai',
        baseUrl: 'http://localhost:8000/v1',
        apiKey: 'test-redacted-api-key',
      }),
    }))

    fireEvent.click(screen.getByLabelText('delete provider local-openai'))
    await waitFor(() => {
      expect(screen.queryByTestId('settings-provider-local-openai')).toBeNull()
    })
    expect(fetchMock).toHaveBeenCalledWith('/settings/providers?providerId=local-openai', { method: 'DELETE' })
  })

  it('renders hooks table when hooks are configured', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-hooks'))
    await screen.findByText('/usr/local/bin/lint.sh')
    expect(screen.getByText('/usr/local/bin/log.sh')).toBeTruthy()
    expect(screen.getByText('pre_tool_use')).toBeTruthy()
    expect(screen.getByText('post_tool_use')).toBeTruthy()
  })

  it('flags MCP as not implemented', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-mcp'))
    await screen.findByText('Not implemented yet')
    expect(screen.getAllByText(/docs\/host\/mcp\.md/i).length).toBeGreaterThan(0)
  })

  it('surfaces a fetch failure without crashing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    render(<SettingsDialog open onOpenChange={() => {}} />)

    await screen.findByText(/network down/i)
  })

  it('configures desktop notification permission and per-kind toggles', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const NotificationMock = vi.fn()
    Object.assign(NotificationMock, { permission: 'default', requestPermission })
    vi.stubGlobal('Notification', NotificationMock)
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-notifications'))
    expect(screen.queryByText(/System notifications are automatically paused/)).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'About Notifications' }).at(-1)!)
    expect(screen.getByRole('tooltip').textContent).toContain('System notifications are automatically paused while Kala is actively being used on any device.')
    expect(screen.getByTestId('desktop-notification-permission').textContent).toContain('not requested')

    fireEvent.click(screen.getByTestId('settings-toggle-desktop-notifications'))
    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
    })
    expect(localStorage.getItem('ak-desktop-notifications-enabled')).toBe('1')

    fireEvent.click(screen.getByTestId('settings-toggle-notification-ak-desktop-notification-sound'))
    expect(localStorage.getItem('ak-desktop-notification-sound')).toBe('0')

    fireEvent.click(screen.getByTestId('settings-toggle-notification-ak-desktop-notification-session-error'))
    expect(localStorage.getItem('ak-desktop-notification-session-error')).toBe('0')
  })

  it('presents one product-level system notification control without Web Push implementation terms', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    const NotificationMock = vi.fn()
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-notifications'))
    expect(await screen.findByText('System notifications')).toBeTruthy()
    expect(screen.queryByText(/Desktop notifications/i)).toBeNull()
    expect(screen.queryByText(/Web Push/i)).toBeNull()
    expect(screen.queryByText(/VAPID/i)).toBeNull()
    expect(screen.getByText('Notify me about')).toBeTruthy()
    expect(screen.getByText('On this device')).toBeTruthy()
  })

  it('moves language selection into Interface settings', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    const language = await screen.findByTestId('settings-language') as HTMLSelectElement
    expect(language.value).toBe('en')
    fireEvent.change(language, { target: { value: 'zh' } })
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh'))
  })

  it('groups personal, workspace, agent, and administration settings', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    for (const group of ['personal', 'workspace', 'agent', 'administration']) expect(screen.getByTestId(`settings-group-${group}`)).toBeTruthy()
    expect(screen.getByTestId('settings-group-personal').textContent).toContain('Notifications')
    expect(screen.getByTestId('settings-group-workspace').textContent).toContain('Executor access')
    expect(screen.getByTestId('settings-group-administration').textContent).toContain('Connection')
  })

  it('offers follow system as a theme preference', async () => {
    localStorage.setItem('ak-theme', 'dark')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    await screen.findByTestId('settings-theme-toggle')
    expect(screen.getByTestId('settings-theme-system')).toBeTruthy()
    expect(screen.getByTestId('settings-theme-dark').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByTestId('settings-theme-system'))
    expect(screen.getByTestId('settings-theme-system').getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('ak-theme')).toBe('system')

    fireEvent.click(screen.getByTestId('settings-theme-light'))
    expect(localStorage.getItem('ak-theme')).toBe('light')
  })

  it('searches marketplace VS Code themes and stores selected raw theme JSON', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/settings') return new Response(JSON.stringify(payload), { status: 200 })
      if (url.startsWith('/themes/marketplace/search')) {
        return new Response(JSON.stringify({ results: [{ namespace: 'example', name: 'theme', displayName: 'Example Theme', description: 'Theme pack', version: '1.0.0', verified: true, downloadCount: 9 }] }), { status: 200 })
      }
      if (url === '/themes/marketplace/extensions/example/theme') {
        return new Response(JSON.stringify({ namespace: 'example', name: 'theme', displayName: 'Example Theme', description: 'Theme pack', version: '1.0.0', verified: true, downloadCount: 9, themes: [{ id: 'Example Dark', label: 'Example Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }] }), { status: 200 })
      }
      if (url === '/themes/marketplace/extensions/example/theme/themes/Example%20Dark') {
        return new Response(JSON.stringify({ extension: {}, theme: { name: 'Example Dark', type: 'dark', colors: { 'editor.background': '#101010', foreground: '#f0f0f0' } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    })

    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    fireEvent.click(screen.getByTestId('settings-tab-interface'))

    const marketplace = await screen.findByTestId('settings-vscode-marketplace')
    expect(marketplace.textContent).toContain('Theme list')
    const defaultThemeRow = await screen.findByTestId('settings-vscode-theme-agent-kernel-dark')
    expect(defaultThemeRow.textContent).toContain('Default Dark')
    expect(defaultThemeRow.textContent).not.toContain('Built in')
    await screen.findByText('Example Theme')
    fireEvent.click(screen.getByText('Example Theme'))
    const themeRow = await screen.findByTestId('settings-vscode-theme-example.theme:Example Dark')
    fireEvent.click(Array.from(themeRow.querySelectorAll('button')).at(0)!)
    await waitFor(() => {
      expect(themeRow.textContent).toContain('Previewing')
    })
    fireEvent.click(Array.from(themeRow.querySelectorAll('button')).at(-1)!)

    await waitFor(() => {
      expect(localStorage.getItem('ak-vscode-theme')).toContain('Example Dark')
    })
  })

  it('stores the live tool activity tail preference', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    await screen.findByTestId('settings-theme-toggle')
    const input = screen.getByTestId('settings-live-tool-activity-tail') as HTMLInputElement
    expect(input.value).toBe('3')

    fireEvent.change(input, { target: { value: '5' } })

    expect(localStorage.getItem('ak-live-tool-activity-tail-count')).toBe('5')
    expect(input.value).toBe('5')
  })

  it('stores the tool activity icon scale preference', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    const select = await screen.findByTestId('settings-tool-activity-icon-scale') as HTMLSelectElement
    expect(select.value).toBe('150')
    fireEvent.change(select, { target: { value: '175' } })
    expect(localStorage.getItem('ak-tool-activity-icon-scale')).toBe('175')
  })

  it('defaults navigation cleanup preferences on and persists opt-out choices', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    fireEvent.click(screen.getByTestId('settings-tab-interface'))

    const offline = await screen.findByTestId('settings-toggle-auto-hide-offline-workspaces')
    const subAgents = screen.getByTestId('settings-toggle-hide-sub-agent-sessions')
    expect(offline.getAttribute('aria-checked')).toBe('true')
    expect(subAgents.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(offline)
    fireEvent.click(subAgents)
    expect(localStorage.getItem('ak-auto-hide-offline-workspaces')).toBe('0')
    expect(localStorage.getItem('ak-hide-sub-agent-sessions')).toBe('0')
  })

  it('stores the session view cache memory limit preference', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    const input = await screen.findByTestId('settings-session-cache-max-mb') as HTMLInputElement
    expect(input.value).toBe('500')

    fireEvent.change(input, { target: { value: '750' } })

    expect(localStorage.getItem('ak-session-view-cache-max-mb')).toBe('750')
    expect(input.value).toBe('750')
  })

  it('exposes durable cache, wake lock, and app badge controls as progressive enhancements', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    expect(await screen.findByTestId('settings-toggle-durable-session-cache')).toBeTruthy()
    expect(screen.getByTestId('settings-session-cache-management')).toBeTruthy()
    expect(screen.getByTestId('settings-toggle-keep-screen-awake')).toBeTruthy()

    fireEvent.click(screen.getByTestId('settings-tab-notifications'))
    expect(await screen.findByTestId('settings-toggle-app-badge')).toBeTruthy()
  })

  it('stores chat and file view display preferences locally', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    await screen.findByTestId('settings-chat-font-size')

    fireEvent.change(screen.getByTestId('settings-chat-font-size'), { target: { value: '20' } })
    fireEvent.change(screen.getByTestId('settings-file-view-font-size'), { target: { value: '18' } })
    fireEvent.change(screen.getByTestId('settings-session-explorer-font-size'), { target: { value: '14' } })
    fireEvent.change(screen.getByTestId('settings-file-explorer-font-size'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('settings-chat-content-width-2'))
    fireEvent.click(screen.getByTestId('settings-chat-side-space-0'))
    fireEvent.click(screen.getByTestId('settings-chat-line-height-2'))
    fireEvent.click(screen.getByTestId('settings-chat-math-scale-4'))

    expect(localStorage.getItem('ak-chat-font-size')).toBe('6')
    expect(localStorage.getItem('ak-file-view-font-size')).toBe('4')
    expect(localStorage.getItem('ak-session-explorer-font-size')).toBe('3')
    expect(localStorage.getItem('ak-file-explorer-font-size')).toBe('2')
    expect(localStorage.getItem('ak-chat-content-width')).toBe('2')
    expect(localStorage.getItem('ak-chat-side-space')).toBe('0')
    expect(localStorage.getItem('ak-chat-line-height')).toBe('2')
    expect(localStorage.getItem('ak-chat-math-scale')).toBe('4')
  })

  it('keeps desktop notifications disabled when browser permission is denied', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    const NotificationMock = vi.fn()
    Object.assign(NotificationMock, { permission: 'denied', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-notifications'))
    expect(screen.queryByText(/System notifications are automatically paused/)).toBeNull()
    const toggle = screen.getByTestId('settings-toggle-desktop-notifications') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/Notifications are blocked/i)).toBeTruthy()
  })

  it('renders executor invites with stable ids and binding context', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        invites: [
          {
            id: 'invite-alpha-0001',
            label: 'Connect Workspace',
            createdAt: '2026-07-15T00:00:00.000Z',
            expiresAt: '2099-07-22T00:00:00.000Z',
            revoked: false,
          },
          {
            id: 'invite-beta-0002',
            label: 'Connect Workspace',
            workspaceId: 'ws-bound',
            createdAt: '2026-07-15T01:00:00.000Z',
            expiresAt: '2099-07-22T01:00:00.000Z',
            lastUsedAt: '2026-07-15T02:00:00.000Z',
            revoked: false,
          },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, id: 'invite-alpha-0001', deleted: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        invites: [{
          id: 'invite-beta-0002', label: 'Connect Workspace', workspaceId: 'ws-bound',
          createdAt: '2026-07-15T01:00:00.000Z', expiresAt: '2099-07-22T01:00:00.000Z',
          lastUsedAt: '2026-07-15T02:00:00.000Z', revoked: false,
        }],
      }), { status: 200 }))

    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-executorAccess'))

    await screen.findByTestId('executor-invite-list')
    expect(screen.getAllByTestId('executor-invite-row')).toHaveLength(2)
    expect(screen.getByText('Unbound invite')).toBeTruthy()
    expect(screen.getByText('invite-alpha')).toBeTruthy()
    expect(screen.getByText('invite-beta-')).toBeTruthy()
    expect(screen.getByText('Waiting for the first executor connection')).toBeTruthy()
    expect(screen.getByText('ws-bound')).toBeTruthy()
    expect(screen.queryByDisplayValue('Connect Workspace')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete invite' }))
    await waitFor(() => expect(screen.getAllByTestId('executor-invite-row')).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith('/auth/executor-invites/invite-alpha-0001', { method: 'DELETE' })
    expect(screen.getByRole('button', { name: 'Revoke invite' })).toBeTruthy()
  })

  it('shows deployment component inventory and executor build metadata', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith('/runtime/deployment/status')) return new Response(JSON.stringify({
        schemaVersion: 1, generatedAt: new Date().toISOString(), topology: 'dedicated-slots',
        services: { supervisor: { pid: 52 } }, writeLeaseOwnerPid: 42,
        route: { generation: 4, activeSlot: 'green', activeReleaseId: 'next' },
        slots: { blue: { pid: 0, active: false, releaseId: 'old' }, green: { pid: 42, active: true, releaseId: 'next' } },
        admission: { pending: 1, leased: 1, committed: 3, failed: 0, expired: 0, oldestAgeMs: 2500, capacity: 1000 },
        dashboard: { schemaVersion: 1, generation: 3, releaseId: 'dashboard-r3', releaseDigest: 'c'.repeat(64), assetDigest: 'd'.repeat(64), version: '0.1.10', protocol: { min: '1.0.0', max: '1.0.0' }, activatedAt: new Date().toISOString() },
        deployment: { deploymentId: 'deployment-0001', operationId: 'operation-0001', phase: 'completed', requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), releaseDigest: 'a'.repeat(64), sourceReleaseDigest: 'b'.repeat(64), candidateSlot: 'green', runtimeReadyAt: new Date().toISOString(), continuation: { participants: 2, completed: 2, failed: 0 }, controlPlane: { previousIngressPid: 31, ingressPid: 41, previousSupervisorPid: 32, supervisorPid: 52, activatedAt: new Date().toISOString(), readyAt: new Date().toISOString() } },
      }), { status: 200 })
      return new Response(JSON.stringify(payload), { status: 200 })
    })
    const executors: AttachedExecutor[] = [
      {
        executorId: 'exec-1',
        workspaceId: 'ws-1',
        workspaceName: 'example-executor',
        tools: ['bash'],
        runtime: 'node',
        runtimeVersion: 'v22.22.2',
        clientVersion: '1.0.0',
        executorVersion: '0.0.0',
        capabilities: {
          schemaVersion: 1,
          features: {
            backgroundShell: true,
            filePicker: true,
            overflowFiles: true,
            workspaceSandbox: false,
          },
        },
        hostname: 'example-executor-host',
        pid: 15372,
        build: {
          releaseTag: 'test-release',
          gitCommit: 'def456',
          builtAt: '2026-07-15T00:10:00.000Z',
          artifactKind: 'cjs',
          dashboardMode: 'none',
        },
      },
    ]
    render(<SettingsDialog open onOpenChange={() => {}} executors={executors} host="https://runlab.example" />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-deployment'))

    expect(screen.getByTestId('settings-deployment-overview')).toBeTruthy()
    expect(screen.getByText('Overall status')).toBeTruthy()
    expect(screen.getByText('Dashboard release')).toBeTruthy()
    expect(screen.getByText('Runtime release')).toBeTruthy()
    expect(await screen.findByTestId('settings-dedicated-deployment')).toBeTruthy()
    expect(screen.getByText('Current deployment')).toBeTruthy()
    expect(screen.getByText('example-executor')).toBeTruthy()
    expect(screen.getByText('example-executor-host · Node.js v22.22.2')).toBeTruthy()
    expect(screen.getByText('background shell, file picker, overflow files')).toBeTruthy()
    expect(screen.getByTestId('settings-deployment-diagnostics')).toBeTruthy()
    expect(screen.queryByText('Executor: example-executor')).toBeNull()
  })
})
