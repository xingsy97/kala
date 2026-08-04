import assert from 'node:assert/strict'
import test from 'node:test'

import { lockedEndpointDestinations, providerRootUrl } from './locked-endpoint.mjs'

test('normalizes provider URLs without duplicating /v1', () => {
  assert.equal(providerRootUrl('https://provider.example/v1/'), 'https://provider.example')
  assert.equal(providerRootUrl('http://192.0.2.1:3000/'), 'http://192.0.2.1:3000')
  assert.throws(() => providerRootUrl('https://provider.example/custom'), /empty or \/v1/u)
})

test('locks a hostname to unique IPv4 ACL destinations and preserves its TLS name', async () => {
  const destinations = await lockedEndpointDestinations('https://provider.example/v1', async () => [
    { address: '203.0.113.8', family: 4 },
    { address: '203.0.113.8', family: 4 },
    { address: '203.0.113.9', family: 4 },
  ])
  assert.deepEqual(destinations, ['provider.example=203.0.113.8:443', 'provider.example=203.0.113.9:443'])
})

test('uses the declared or protocol-default port for literal IPv4', async () => {
  assert.deepEqual(await lockedEndpointDestinations('http://192.0.2.1:3000'), ['192.0.2.1:3000'])
  assert.deepEqual(await lockedEndpointDestinations('https://192.0.2.1'), ['192.0.2.1:443'])
})

test('rejects a resolver that returns no IPv4 records', async () => {
  await assert.rejects(lockedEndpointDestinations('https://provider.example', async () => []), /did not resolve to IPv4/u)
})
