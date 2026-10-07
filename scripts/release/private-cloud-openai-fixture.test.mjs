import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixtureCompletion } from './private-cloud-openai-fixture.mjs'

const TOKEN = 'fixture-token-with-more-than-thirty-two-characters'
const MARKER = 'RC_TEST_MARKER'
const TARGET = '/workspace/marker-RC_TEST_MARKER.txt'
const instruction = `Use the write_file tool to create ${TARGET} containing exactly ${MARKER}. Then reply exactly ${MARKER}.`
const writeTool = { type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }

function request(messages, authorization = `Bearer ${TOKEN}`) {
  return createFixtureCompletion({
    method: 'POST', path: '/v1/chat/completions', authorization,
    body: { model: 'kala-deterministic', stream: true, messages, tools: [writeTool] },
  }, TOKEN)
}

function events(result) {
  return result.sse.filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
}

test('requires the random bearer credential and a real write_file tool declaration', () => {
  assert.equal(request([{ role: 'user', content: instruction }], 'Bearer wrong').status, 401)
  const missingTool = createFixtureCompletion({ method: 'POST', path: '/v1/chat/completions', authorization: `Bearer ${TOKEN}`, body: { stream: true, messages: [{ role: 'user', content: instruction }], tools: [] } }, TOKEN)
  assert.equal(missingTool.status, 400)
})

test('streams a faithful OpenAI tool call with the exact requested path and marker', () => {
  const result = request([{ role: 'user', content: instruction }])
  assert.equal(result.status, 200)
  const streamed = events(result)
  const call = streamed[0].choices[0].delta.tool_calls[0]
  assert.equal(call.id, 'call_kala_private_cloud_write_file')
  assert.equal(call.function.name, 'write_file')
  assert.deepEqual(JSON.parse(call.function.arguments), { path: TARGET, content: MARKER })
  assert.equal(streamed[1].choices[0].finish_reason, 'tool_calls')
  assert.equal(result.sse.at(-1), 'data: [DONE]\n\n')
})

test('uses tool_search disclosure before write_file when the Runtime initially hides the file tool', () => {
  const first = createFixtureCompletion({
    method: 'POST', path: '/v1/chat/completions', authorization: `Bearer ${TOKEN}`,
    body: { stream: true, messages: [{ role: 'user', content: instruction }], tools: [{ type: 'function', function: { name: 'tool_search' } }] },
  }, TOKEN)
  const search = events(first)[0].choices[0].delta.tool_calls[0]
  assert.equal(search.function.name, 'tool_search')
  assert.equal(JSON.parse(search.function.arguments).activate, true)

  const second = request([
    { role: 'user', content: instruction },
    { role: 'assistant', content: null, tool_calls: [{ id: search.id, type: 'function', function: search.function }] },
    { role: 'tool', tool_call_id: search.id, content: 'write_file activated' },
  ])
  assert.equal(events(second)[0].choices[0].delta.tool_calls[0].function.name, 'write_file')
})

test('emits the final marker only after the matching tool result is present', () => {
  const first = request([{ role: 'user', content: instruction }])
  const call = events(first)[0].choices[0].delta.tool_calls[0]
  const incomplete = request([
    { role: 'user', content: instruction },
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] },
  ])
  assert.equal(incomplete.status, 400)

  const final = request([
    { role: 'user', content: instruction },
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] },
    { role: 'tool', tool_call_id: call.id, content: 'write completed' },
  ])
  const streamed = events(final)
  assert.equal(streamed[0].choices[0].delta.content, MARKER)
  assert.equal(streamed[1].choices[0].finish_reason, 'stop')
})
