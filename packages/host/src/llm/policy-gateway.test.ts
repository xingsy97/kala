import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { liftJsonToolCallsFromContent, policyGatewayAdapter } from './policy-gateway.js'

describe('liftJsonToolCallsFromContent', () => {
  const tools = new Set(['write', 'bash', 'read'])
  it('lifts <tool_call> wrapped JSON', () => {
    const { toolCalls, residualText } = liftJsonToolCallsFromContent(
      '<tool_call>\n{"name":"write","arguments":{"path":"a"}}\n</tool_call>',
      tools,
    )
    expect(toolCalls).toEqual([{ name: 'write', arguments: { path: 'a' } }])
    expect(residualText).toBe('')
  })
  it('lifts ```json fenced JSON', () => {
    const { toolCalls } = liftJsonToolCallsFromContent(
      '```json\n{"name":"bash","arguments":{"cmd":"ls"}}\n```',
      tools,
    )
    expect(toolCalls).toEqual([{ name: 'bash', arguments: { cmd: 'ls' } }])
  })
  it('lifts bare JSON tool call', () => {
    const { toolCalls, residualText } = liftJsonToolCallsFromContent(
      'I will call write. {"name":"write","arguments":{"path":"x","content":"y"}}',
      tools,
    )
    expect(toolCalls).toEqual([{ name: 'write', arguments: { path: 'x', content: 'y' } }])
    expect(residualText).toContain('I will call write')
  })
  it('ignores JSON that is not a tool call', () => {
    const { toolCalls, residualText } = liftJsonToolCallsFromContent(
      '{"foo":"bar"}',
      tools,
    )
    expect(toolCalls).toEqual([])
    expect(residualText).toBe('{"foo":"bar"}')
  })
  it('rejects tool names not in whitelist', () => {
    const { toolCalls } = liftJsonToolCallsFromContent(
      '{"name":"eval","arguments":{}}',
      tools,
    )
    expect(toolCalls).toEqual([])
  })
})

describe('policyGatewayAdapter', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-policy-gateway-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('captures generation-time token ids and logprobs from an SGLang native generate response', async () => {
    const adapter = policyGatewayAdapter({
      baseUrl: 'http://sglang.test',
      artifactRoot: dir,
      model: 'fake-policy',
      rolloutId: 'rollout-1',
      sessionId: 'session-1',
      routeKey: 'rollout-1',
      weightVersion: 'step-1',
      requireLogprobs: true,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('http://sglang.test/generate')
        expect((init?.headers as Record<string, string>)['X-SMG-Routing-Key']).toBe('rollout-1')
        return jsonResponse({
          text: 'done',
          output_ids: [21, 22],
          meta_info: {
            prompt_tokens: 3,
            completion_tokens: 2,
            weight_version: 'step-remote',
            finish_reason: { type: 'stop' },
            input_token_logprobs: [[null, 11, null], [-1.1, 12, null], [-1.2, 13, null]],
            output_token_logprobs: [[-0.1, 21, null], [-0.2, 22, null]],
          },
        })
      },
    })

    const result = await adapter.call({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })

    expect(result.message.content).toEqual([{ type: 'text', text: 'done' }])
    const rolloutDirs = await readdir(join(dir, 'rl-token-captures'))
    expect(rolloutDirs).toEqual(['rollout-1'])
    const files = await readdir(join(dir, 'rl-token-captures', 'rollout-1'))
    const capture = JSON.parse(await readFile(join(dir, 'rl-token-captures', 'rollout-1', files[0]!), 'utf8'))
    expect(capture).toMatchObject({
      schemaVersion: 'agent.policy_token_capture.v1',
      promptIds: [11, 12, 13],
      outputIds: [21, 22],
      outputLogProbs: [-0.1, -0.2],
      responseMask: [1, 1],
      weightVersion: 'step-1',
    })
  })

  it('can use chat-completions when provider-native token ids are available', async () => {
    const adapter = policyGatewayAdapter({
      baseUrl: 'http://sglang.test',
      artifactRoot: dir,
      model: 'fake-policy',
      endpoint: 'chat-completions',
      rolloutId: 'rollout-chat',
      requireLogprobs: true,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('http://sglang.test/v1/chat/completions')
        const body = JSON.parse(String(init?.body))
        expect(body.max_tokens).toBeUndefined()
        return jsonResponse({
          prompt_token_ids: [11, 12, 13],
          choices: [{
            message: { content: 'done' },
            finish_reason: 'stop',
            logprobs: { content: [
              { token: 'd', token_id: 21, logprob: -0.1 },
              { token: 'one', token_id: 22, logprob: -0.2 },
            ] },
          }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        })
      },
    })

    const result = await adapter.call({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })

    expect(result.message.content).toEqual([{ type: 'text', text: 'done' }])
    const files = await readdir(join(dir, 'rl-token-captures', 'rollout-chat'))
    const capture = JSON.parse(await readFile(join(dir, 'rl-token-captures', 'rollout-chat', files[0]!), 'utf8'))
    expect(capture.outputIds).toEqual([21, 22])
  })

  it('fails closed when training token ids are missing', async () => {
    const adapter = policyGatewayAdapter({
      baseUrl: 'http://sglang.test',
      artifactRoot: dir,
      model: 'fake-policy',
      requireLogprobs: true,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'done' } }] }),
    })

    await expect(adapter.call({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })).rejects.toThrow('token ids required')
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  })
}
