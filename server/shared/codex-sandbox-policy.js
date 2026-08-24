/**
 * Convert the CLI/SDK sandbox spelling into Codex app-server's tagged policy.
 * `turn/start` owns the effective policy for that turn and subsequent turns;
 * passing the legacy string only to `thread/resume` is not enough.
 */
export function toCodexAppServerSandboxPolicy(sandboxMode) {
  switch (sandboxMode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly' };
    case 'workspace-write':
      return { type: 'workspaceWrite' };
    default:
      throw new Error(`Unsupported Codex sandbox mode: ${sandboxMode}`);
  }
}
