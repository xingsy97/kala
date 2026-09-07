import { describe, expect, it } from 'vitest'
import { inferShellFamily, selectShell, shellArgv, shellResourceLimitsFromEnv } from './shell-runtime.js'

describe('shell runtime',()=>{
  it('constructs PowerShell, cmd, and POSIX argv without an implicit shell',()=>{
    expect(shellArgv({family:'powershell',executable:'pwsh.exe'},'Write-Output "✓"')).toEqual(['-NoLogo','-NoProfile','-NonInteractive','-Command',expect.stringContaining('Write-Output "✓"')])
    expect(shellArgv({family:'cmd',executable:'cmd.exe'},'echo ok')).toEqual(['/d','/s','/c','echo ok'])
    expect(shellArgv({family:'bash',executable:'/bin/bash'},'echo ok')).toEqual(['-lc','echo ok'])
    expect(shellArgv({family:'sh',executable:'/bin/sh'},'echo ok')).toEqual(['-c','echo ok'])
  })
  it('classifies executables and selects explicit families',()=>{
    expect(inferShellFamily('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell')
    expect(selectShell('cmd',[{family:'powershell',executable:'pwsh'},{family:'cmd',executable:'cmd.exe'}])).toEqual({family:'cmd',executable:'cmd.exe'})
    expect(()=>selectShell('zsh',[{family:'cmd',executable:'cmd.exe'}])).toThrow('requested shell is unavailable')
  })
  it('adds POSIX resource-limit prelude without changing Windows shells',()=>{
    const limited = shellArgv({family:'bash',executable:'/bin/bash'},'echo ok',{
      cpuSeconds: 2,
      memoryMb: 128,
      fileBytes: 1025,
      maxProcesses: 32,
    })
    expect(limited).toEqual(['-lc','set -e; ulimit -t 2; ulimit -v 131072; ulimit -f 3; ulimit -u 32; set +e; echo ok'])
    expect(shellArgv({family:'cmd',executable:'cmd.exe'},'echo ok',{cpuSeconds:2})).toEqual(['/d','/s','/c','echo ok'])
  })
  it('parses shell resource limits from the executor environment',()=>{
    expect(shellResourceLimitsFromEnv({
      AGENT_RUNLAB_SHELL_CPU_SECONDS: '2',
      AGENT_RUNLAB_SHELL_MEMORY_MB: '128',
      AGENT_RUNLAB_SHELL_FILE_BYTES: '1024',
      AGENT_RUNLAB_SHELL_MAX_PROCESSES: '32',
    })).toEqual({cpuSeconds:2,memoryMb:128,fileBytes:1024,maxProcesses:32})
    expect(()=>shellResourceLimitsFromEnv({AGENT_RUNLAB_SHELL_CPU_SECONDS:'0'})).toThrow('AGENT_RUNLAB_SHELL_CPU_SECONDS')
  })
})
