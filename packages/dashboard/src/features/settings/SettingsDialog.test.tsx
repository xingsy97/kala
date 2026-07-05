import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSettingsPayload } from '@agent-kernel/shared'

import { SettingsDialog } from './SettingsDialog.js'

const payload: ServerSettingsPayload = {
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic',
      wire: 'anthropic',
      baseUrl: 'http://proxy.local/v1',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
    },
    {
      id: 'openai-compat',
      label: 'internal-router',
      wire: 'openai',
      models: [],
    },
  ],
  defaultModel: 'claude-opus-4-7',
  hooks: [
    { event: 'pre_tool_use', match: 'bash', command: '/usr/local/bin/lint.sh' },
    { event: 'post_tool_use', command: '/usr/local/bin/log.sh' },
  ],
  paths: {
    claudeSettings: '<home>/.claude/settings.json',
    codexConfig: '<home>/.codex/config.toml',
    hooksConfig: '<home>/.config/agent-kernel/config.toml',
    sessionsDir: '<home>/.agent-kernel/sessions',
  },
  mcp: {
    supported: false,
    note: 'MCP runtime is not implemented yet  -  declaring servers in session config is a no-op.',
  },
}

describe('SettingsDialog', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not render when closed', () => {
    render(<SettingsDialog open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId('settings-dialog')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches /settings on open and shows runtime paths by default', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings', { cache: 'no-store' })
    })

    await screen.findByText('<home>/.claude/settings.json')
    expect(screen.getByText('<home>/.codex/config.toml')).toBeTruthy()
    expect(screen.getByText('<home>/.agent-kernel/sessions')).toBeTruthy()
  })

  it('switches to Models tab and lists providers + default model', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-models'))

    const anthropic = await screen.findByTestId('settings-provider-anthropic')
    expect(anthropic.textContent).toContain('Anthropic')
    expect(anthropic.textContent).toContain('claude-opus-4-7')
    expect(anthropic.textContent).toContain('claude-sonnet-4-6')
    expect(anthropic.textContent).toContain('default provider')

    const other = screen.getByTestId('settings-provider-openai-compat')
    expect(other.textContent).toContain('No model attached')
  })

  it('renders hooks table when hooks are configured', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-hooks'))
    await screen.findByText('/usr/local/bin/lint.sh')
    expect(screen.getByText('/usr/local/bin/log.sh')).toBeTruthy()
    expect(screen.getByText('pre_tool_use')).toBeTruthy()
    expect(screen.getByText('post_tool_use')).toBeTruthy()
  })

  it('flags MCP as not implemented', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-mcp'))
    await screen.findByText('Not implemented yet')
    expect(screen.getAllByText(/no-op/i).length).toBeGreaterThan(0)
  })

  it('surfaces a fetch failure without crashing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    render(<SettingsDialog open onOpenChange={() => {}} />)

    await screen.findByText(/network down/i)
  })
})
