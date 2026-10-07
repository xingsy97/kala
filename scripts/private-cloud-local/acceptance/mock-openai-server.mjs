#!/usr/bin/env node
import { createServer } from 'node:http'

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
  let raw = ''; for await (const chunk of request) raw += String(chunk)
  const body = JSON.parse(raw)
  const prompt = JSON.stringify(body.messages ?? body.input ?? body)
  const markdownAcceptance = prompt.includes('MARKDOWN_RENDER_ACCEPTANCE')
  const exactMarker = prompt.match(/Reply with exactly ([A-Z0-9_-]+) and nothing else\./u)?.[1]
  const workspaceWrite = prompt.match(/Use the write_file tool to create (\/[^\s"\\]+) containing exactly ([A-Z0-9_-]+)\. Then reply exactly \2\./u)
  const availableTools = new Set((body.tools ?? []).map((entry) => entry.function?.name))
  const priorCalls = (body.messages ?? []).filter((entry) => entry.role === 'assistant').flatMap((entry) => entry.tool_calls ?? [])
  const writeAlreadyRequested = priorCalls.some((call) => call.function?.name === 'write_file')
  const searchAlreadyRequested = priorCalls.some((call) => call.function?.name === 'tool_search')
  const writeCall = workspaceWrite && !writeAlreadyRequested
    ? availableTools.has('write_file')
      ? { id: 'call_private_cloud_write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: workspaceWrite[1], content: workspaceWrite[2] }) } }
      : !searchAlreadyRequested && availableTools.has('tool_search')
        ? { id: 'call_private_cloud_discover', type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: 'create a UTF-8 file with write_file', limit: 5, activate: true, _intent: 'Find and activate the file-writing tool so the isolated workspace can create the requested marker.' }) } }
        : undefined
    : undefined
  const text = markdownAcceptance
    ? 'Stable intro.\n\n```typescript\nconst stable = true\n```\n\nAfter code.\n\n```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```\n\nFinal marker MARKDOWN_RENDER_COMPLETE.'
    : workspaceWrite && !writeAlreadyRequested && !writeCall ? 'Required write_file tool unavailable.' : workspaceWrite?.[2] ?? exactMarker ?? 'Private Cloud tenant agent response verified.'
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    if (writeCall) {
      response.write(`data: ${JSON.stringify({ id: 'acceptance', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...writeCall }] }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'acceptance', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n'); return
    }
    const tokens = markdownAcceptance
      ? ['Stable intro.\n\n```typescript\n', 'const stable = true\n```\n\n', 'After code.\n\n', '```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```\n\n', 'Final marker MARKDOWN_RENDER_COMPLETE.']
      : workspaceWrite || exactMarker ? [text] : ['Private Cloud tenant ', 'agent response ', 'verified.']
    for (const token of tokens) {
      response.write(`data: ${JSON.stringify({ id: 'acceptance', choices: [{ index: 0, delta: { content: token }, finish_reason: null }] })}\n\n`)
      if (markdownAcceptance) await new Promise(resolve => setTimeout(resolve, token.includes('stable = true') ? 1_200 : 300))
    }
    response.write(`data: ${JSON.stringify({ id: 'acceptance', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6 } })}\n\n`)
    response.end('data: [DONE]\n\n'); return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ id: 'acceptance', choices: [{ index: 0, message: writeCall ? { role: 'assistant', content: null, tool_calls: [writeCall] } : { role: 'assistant', content: text }, finish_reason: writeCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6 } }))
})
server.listen(8080, '0.0.0.0')
