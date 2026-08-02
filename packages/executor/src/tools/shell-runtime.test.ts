import { describe, expect, it } from 'vitest'
import { inferShellFamily, selectShell, shellArgv } from './shell-runtime.js'

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
})
