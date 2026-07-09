import { describe, expect, it } from 'vitest'

import { rewriteHostWorkspacePathForContainer } from './programbench-bash.js'

describe('ProgramBench container bash helpers', () => {
  it('maps host workspace paths in model-generated commands to /workspace', () => {
    const workspace = '/tmp/portfolio/artifacts/program-bench/run/agent-runlab/case/workspace'
    const command = `cd ${workspace} && test -x ./compile.sh && ${workspace}/compile.sh`

    expect(rewriteHostWorkspacePathForContainer(command, workspace)).toBe(
      'cd /workspace && test -x ./compile.sh && /workspace/compile.sh',
    )
  })
})
