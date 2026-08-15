/**
 * A tool call the CLI closed out because it was being shut down.
 *
 * When the Claude Code CLI is killed with a tool in flight it writes its
 * ordinary refusal result — "The user doesn't want to proceed with this tool
 * use…" — and marks the transcript row `interruptedByShutdown`. Read literally,
 * the transcript accuses the reader of rejecting a prompt they never saw (and
 * on vs.dudin.net the killer is usually the health-check watchdog restarting a
 * momentarily unresponsive server). The flag is the only thing that separates
 * this from a real denial, so the UI keys off it rather than the text.
 */
export const SHUTDOWN_INTERRUPTION_NOTE =
  'The server restarted while this tool was running, so it was cut short. Nobody rejected it — Claude Code writes its "user rejected" result whenever it is shut down mid-tool.';

export function isShutdownInterrupted(toolResult: unknown): boolean {
  return Boolean((toolResult as { interruptedByShutdown?: unknown } | null | undefined)?.interruptedByShutdown);
}
