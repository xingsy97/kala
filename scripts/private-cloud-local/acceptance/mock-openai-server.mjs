#!/usr/bin/env node
import { createServer } from 'node:http'

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
  let raw = ''; for await (const chunk of request) raw += String(chunk)
  const body = JSON.parse(raw)
  const prompt = JSON.stringify(body.messages ?? body.input ?? body)
  const markdownAcceptance = prompt.includes('MARKDOWN_RENDER_ACCEPTANCE')
  const exactMarker = prompt.match(/Reply with exactly ([A-Z0-9_-]+) and nothing else\./u)?.[1]
  const text = markdownAcceptance
    ? 'Stable intro.\n\n```typescript\nconst stable = true\n```\n\nAfter code.\n\n```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```\n\nFinal marker MARKDOWN_RENDER_COMPLETE.'
    : exactMarker ?? 'Private Cloud tenant agent response verified.'
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const tokens = markdownAcceptance
      ? ['Stable intro.\n\n```typescript\n', 'const stable = true\n```\n\n', 'After code.\n\n', '```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```\n\n', 'Final marker MARKDOWN_RENDER_COMPLETE.']
      : exactMarker ? [exactMarker] : ['Private Cloud tenant ', 'agent response ', 'verified.']
    for (const token of tokens) {
      response.write(`data: ${JSON.stringify({ id: 'acceptance', choices: [{ index: 0, delta: { content: token }, finish_reason: null }] })}\n\n`)
      if (markdownAcceptance) await new Promise(resolve => setTimeout(resolve, token.includes('stable = true') ? 1_200 : 300))
    }
    response.write(`data: ${JSON.stringify({ id: 'acceptance', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6 } })}\n\n`)
    response.end('data: [DONE]\n\n'); return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ id: 'acceptance', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 6 } }))
})
server.listen(8080, '0.0.0.0')
