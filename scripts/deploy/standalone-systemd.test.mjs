import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name) => readFileSync(new URL(`../../deploy/standalone-systemd/${name}`, import.meta.url), 'utf8')

describe('Standalone systemd packaging', () => {
  it('keeps Ingress, Unit, and Supervisor in independent services', () => {
    const ingress = read('agent-runlab-ingress.service')
    const unit = read('agent-runlab-unit@.service')
    const supervisor = read('agent-runlab-deploy-supervisor.service')
    expect(ingress).toContain('agent-runlab-standalone-ingress.cjs')
    expect(unit).toContain('bundle-dashboard-with-runtime.cjs --port 13001')
    expect(unit).toContain('/usr/bin/flock --exclusive --nonblock')
    expect(unit).toContain('Restart=always')
    expect(supervisor).toContain('agent-runlab-deploy-supervisor.cjs')
    expect(supervisor).toContain('InaccessiblePaths=/var/lib/agent-runlab/units')
    expect(supervisor).not.toContain('bundle-dashboard-with-runtime.cjs')
  })

  it('binds the Unit privately and preserves full Standalone profile', () => {
    const unit = read('agent-runlab-unit@.service')
    expect(unit).toContain('AGENT_KERNEL_DEPLOYMENT_MODE=standalone')
    expect(unit).toContain('HOST_LISTEN_HOST=127.0.0.1')
    expect(unit).toContain('SESSIONS_DIR=/var/lib/agent-runlab/units/%i/sessions')
  })
})
