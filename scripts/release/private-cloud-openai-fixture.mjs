#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const TOOL_CALL_ID = 'call_kala_private_cloud_write_file'
const TOOL_SEARCH_CALL_ID = 'call_kala_private_cloud_tool_search'
const MAX_REQUEST_BYTES = 4 * 1024 * 1024

export function createFixtureCompletion({ method, path, authorization, body }, expectedToken) {
  if (method !== 'POST' || path !== '/v1/chat/completions') return { status: 404, json: { error: { message: 'not found' } } }
  if (typeof expectedToken !== 'string' || expectedToken.length < 32 || authorization !== `Bearer ${expectedToken}`) return { status: 401, json: { error: { message: 'unauthorized' } } }
  if (!body || typeof body !== 'object' || body.stream !== true || !Array.isArray(body.messages)) return { status: 400, json: { error: { message: 'streaming chat request required' } } }
  const availableTools = new Set((body.tools ?? []).filter((tool) => tool?.type === 'function').map((tool) => tool.function?.name))
  const instruction = [...body.messages].reverse().find((message) => message?.role === 'user')
  const prompt = messageText(instruction?.content)
  // A real authenticated model turn stays in flight across the Runtime stop.
  // The queued follow-up receives a real model response after reconnect.
  const hold = prompt.match(/^rc-hold-[0-9a-f]{12}$/u)
  if (hold) return { status: 200, sse: finalEvents(hold[0]), delayMs: 90_000 }
  const recovered = prompt.match(/^rc-recovered-[0-9a-f]{12}$/u)
  if (recovered) return { status: 200, sse: finalEvents(recovered[0]) }
  const match = prompt.match(/Use the write_file tool to create (\/[^\r\n]+?) containing exactly ([A-Z0-9_-]+)\. Then reply exactly \2\./u)
  if (!match) return { status: 400, json: { error: { message: 'expected acceptance instruction' } } }
  const [, targetPath, marker] = match
  const priorCalls = body.messages.filter((message) => message?.role === 'assistant').flatMap((message) => message.tool_calls ?? [])
  const priorWrite = priorCalls.find((call) => call?.id === TOOL_CALL_ID && call.function?.name === 'write_file')
  const writeResult = body.messages.find((message) => message?.role === 'tool' && message.tool_call_id === TOOL_CALL_ID)
  if (priorWrite) return writeResult ? { status: 200, sse: finalEvents(marker) } : { status: 400, json: { error: { message: 'write_file result required' } } }

  const priorSearch = priorCalls.find((call) => call?.id === TOOL_SEARCH_CALL_ID && call.function?.name === 'tool_search')
  const searchResult = body.messages.find((message) => message?.role === 'tool' && message.tool_call_id === TOOL_SEARCH_CALL_ID)
  if (priorSearch && !searchResult) return { status: 400, json: { error: { message: 'tool_search result required' } } }
  if (availableTools.has('write_file')) return { status: 200, sse: writeEvents(targetPath, marker) }
  if (!priorSearch && availableTools.has('tool_search')) return { status: 200, sse: searchEvents() }
  return { status: 400, json: { error: { message: 'write_file tool unavailable after disclosure' } } }
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
}

function writeEvents(path, marker) {
  return toolEvents(TOOL_CALL_ID, 'write_file', { path, content: marker })
}

function searchEvents() {
  return toolEvents(TOOL_SEARCH_CALL_ID, 'tool_search', { query: 'create a UTF-8 file with write_file', limit: 5, activate: true, _intent: 'Find and activate the file-writing tool so the isolated workspace can create the requested marker.' })
}

function toolEvents(callId, name, input) {
  return [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }),
    chunk({}, 'tool_calls'),
    usageChunk(16, 8),
    'data: [DONE]\n\n',
  ]
}

function finalEvents(marker) {
  return [
    chunk({ role: 'assistant', content: marker }),
    chunk({}, 'stop'),
    usageChunk(20, 4),
    'data: [DONE]\n\n',
  ]
}

function chunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-kala-private-cloud-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

function usageChunk(promptTokens, completionTokens) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-kala-private-cloud-fixture', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } })}\n\n`
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

if (isMainModule()) {
  const tokenFile = process.env.KALA_FIXTURE_BEARER_TOKEN_FILE
  if (typeof tokenFile !== 'string' || !tokenFile) throw new Error('KALA_FIXTURE_BEARER_TOKEN_FILE is required')
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (token.length < 32) throw new Error('The fixture bearer token must contain at least 32 characters')
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunkValue) => {
      raw += chunkValue
      if (raw.length > MAX_REQUEST_BYTES) request.destroy()
    })
    request.on('end', () => {
      let body
      try { body = JSON.parse(raw) } catch { body = undefined }
      const result = createFixtureCompletion({ method: request.method, path: request.url, authorization: request.headers.authorization, body }, token)
      if (result.sse) {
        response.writeHead(result.status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
        if (result.delayMs) {
          response.flushHeaders()
          response.write(': authenticated recovery turn held in flight\n\n')
          const timer = setTimeout(() => response.end(result.sse.join('')), result.delayMs)
          response.on('close', () => clearTimeout(timer))
        } else {
          response.end(result.sse.join(''))
        }
      } else {
        response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(`${JSON.stringify(result.json)}\n`)
      }
    })
  })
  server.listen(3000, '0.0.0.0', () => process.stdout.write('{"ready":true}\n'))
}
