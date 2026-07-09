export function rewriteHostWorkspacePathForContainer(command: string, workspaceRoot: string): string {
  return command.split(workspaceRoot).join('/workspace')
}
