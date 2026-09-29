import test from 'node:test'
import assert from 'node:assert/strict'

import { parsePublicListeners, planLxdPublicListeners } from './configure-lxd-public-listeners.mjs'

test('parses literal public listeners and rejects hostnames', () => {
  assert.deepEqual(parsePublicListeners('127.0.0.1:13000,192.0.2.10:13000,[::1]:13000'), [
    { host: '127.0.0.1', port: 13000, endpoint: 'tcp:127.0.0.1:13000' },
    { host: '192.0.2.10', port: 13000, endpoint: 'tcp:192.0.2.10:13000' },
    { host: '::1', port: 13000, endpoint: 'tcp:[::1]:13000' },
  ])
  assert.throws(() => parsePublicListeners('box.local:13000'), /literal address/u)
})

test('plans only missing Kala-managed LXD proxy devices', () => {
  const existing = {
    'dashboard-loopback-13000': { type: 'proxy', listen: 'tcp:127.0.0.1:13000', connect: 'tcp:127.0.0.1:13000' },
    'kala-public-obsolete': { type: 'proxy', listen: 'tcp:192.0.2.20:13000', connect: 'tcp:127.0.0.1:13000' },
    root: { type: 'disk', path: '/' },
  }
  const plan = planLxdPublicListeners(existing, '127.0.0.1:13000,192.0.2.10:13000')

  assert.equal(plan.add.length, 1)
  assert.equal(plan.add[0][1].listen, 'tcp:192.0.2.10:13000')
  assert.deepEqual(plan.remove, ['kala-public-obsolete'])
})
