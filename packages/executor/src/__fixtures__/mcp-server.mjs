import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'normal'
const toolName = process.argv[3] ?? 'echo'
const closeMarker = process.argv[4] ?? process.env.CLOSE_MARKER
const lines = createInterface({ input: process.stdin })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (mode === 'init-hang') return
    result(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'kala-test-fixture', version: '1.0.0' },
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    result(message.id, {
      tools: [{
        name: toolName,
        description: 'Fixture echo tool',
        inputSchema: mode === 'invalid-schema'
          ? { type: 'string' }
          : { type: 'object', properties: { value: { type: 'string' } } },
      }],
    })
    return
  }
  if (message.method === 'tools/call') {
    if (mode === 'hang') return
    if (mode === 'crash') {
      setTimeout(() => process.exit(17), 5)
      return
    }
    if (mode === 'error') {
      result(message.id, { content: [{ type: 'text', text: 'fixture rejected call' }], isError: true })
      return
    }
    if (mode === 'image') {
      result(message.id, { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] })
      return
    }
    result(message.id, { content: [{ type: 'text', text: String(message.params.arguments?.value ?? '') }] })
  }
})

lines.on('close', () => {
  if (closeMarker) appendFileSync(closeMarker, 'closed\n')
})
