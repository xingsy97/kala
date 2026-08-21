#!/usr/bin/env node
import { createServer } from 'node:http'

const command = process.env.RUNLAB_ACCEPTANCE_DEPLOY_COMMAND
if (!command) throw new Error('RUNLAB_ACCEPTANCE_DEPLOY_COMMAND is required')

createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(404).end(); return }
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  const body = JSON.parse(raw)
  const text = JSON.stringify(body.messages ?? [])
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  if (text.includes('SELF_DEPLOY_ACCEPTANCE') && !text.includes('operation-self-deploy-acceptance')) {
    event(response, { type: 'message_start', message: { id: 'acceptance-deploy', usage: { input_tokens: 8, output_tokens: 0 } } })
    event(response, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'acceptance-deploy-call', name: 'shell', input: {} } })
    event(response, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, timeout_ms: 30_000, _intent: 'Submit the candidate to the external Deploy Supervisor without waiting inside the Runtime process.' }) } })
    event(response, { type: 'content_block_stop', index: 0 })
    event(response, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })
  } else {
    event(response, { type: 'message_start', message: { id: 'acceptance-continued', usage: { input_tokens: 8, output_tokens: 0 } } })
    event(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'SELF_DEPLOY_CONTINUED' } })
    event(response, { type: 'content_block_stop', index: 0 })
    event(response, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
  }
  event(response, { type: 'message_stop' })
  response.end()
}).listen(18080, '127.0.0.1')

function event(response, value) { response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n') }
