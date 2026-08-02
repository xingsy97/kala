# Cross-platform shell tool

**Status:** accepted implementation contract.

## Goal

Expose one model-facing `shell` tool that executes native commands on Linux, macOS, and Windows without requiring Git Bash. Preserve `bash` as a wire-compatible alias while existing sessions and integrations migrate.

## Shell discovery

The Executor resolves an optional operator override first, then:

- Windows: `pwsh`, `powershell.exe`, Git Bash, `%COMSPEC%`, `cmd.exe`;
- macOS: login/configured shell, `zsh`, `bash`, `sh`;
- Linux: login/configured shell, `bash`, `sh`.

Discovery returns a shell family and executable. The Executor announces its default and available shell families. Failure must identify the requested family and remediation.

## Invocation

Commands are spawned as an executable plus argv; generic `shell: true` is forbidden.

- PowerShell: `-NoLogo -NoProfile -NonInteractive -Command SCRIPT`, with UTF-8 console output initialization;
- cmd: `/d /s /c SCRIPT`;
- bash/zsh: `-lc SCRIPT`;
- sh: `-c SCRIPT`.

`cwd` is resolved by the Executor sandbox. Environment variables are inherited from the Executor with explicit overrides only. Command text remains a single argv element.

## Tool contract

```typescript
{
  command: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  shell?: 'auto' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh'
}
```

The model-facing name is `shell`. `bash` invokes the same implementation with `shell: auto` for compatibility. Background output and cancellation continue through `bash_output` and `kill_shell` during the compatibility period.

## Process lifecycle

- Unix uses a detached process group; cancellation sends SIGTERM and escalates to SIGKILL.
- Windows is not detached and cancellation terminates the complete tree with `taskkill /PID PID /T /F`.
- stdout/stderr are decoded as UTF-8 and bounded by the existing overflow mechanism.
- timeout, abort, background IDs, and receipts are shell-independent.

## Model context

The Host adds the selected Workspace OS, default shell family, and available families to the execution instructions. The model must generate PowerShell syntax for PowerShell, cmd syntax for cmd, and POSIX syntax only for bash/zsh/sh.

## Security

Approval policy applies to the normalized `shell` operation. Shell family is audit metadata. Commands never pass through an additional implicit shell. Cwd remains sandbox validated. Operator shell overrides must resolve to an executable and are never accepted from browser-controlled authority headers.

## Acceptance

Required coverage includes PowerShell/cmd/bash argv, Unicode, paths with spaces, cwd, timeout, background output, process-tree cancellation, explicit shell selection, fallback behavior, legacy `bash`, announce metadata, and real Windows Executor execution through the public Host.
