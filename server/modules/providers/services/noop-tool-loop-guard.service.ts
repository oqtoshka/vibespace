/**
 * Consecutive no-op tool calls that stop an OpenCode turn.
 *
 * Three, because one no-op can be an accident and two in a row already repeat
 * it, while the third is never progress: nothing between them changed the
 * workspace or the card. The loop this exists for (2026-11-08) alternated a
 * reasoning step with bash `true` for 90+ steps over eight minutes; at three it
 * costs three cheap steps. OpenCode's own doom-loop check never fires there,
 * because `--auto` allows every permission it would have asked about.
 * Consumed by `server/opencode-cli.js` and this module's tests.
 */
export const NOOP_TOOL_LOOP_LIMIT = 3;

type ToolMessage = { kind?: string; toolName?: unknown; toolInput?: unknown; toolId?: unknown; toolResult?: unknown };

/** Shell tools whose command we can read. OpenCode names its own `bash`. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'exec', 'run_shell_command']);
/**
 * A command that does nothing: empty, or only `true`, `:`, `exit [0]`, a bare
 * `echo`, `sleep 0`, joined by `;`/`&&`/`||`.
 */
const NOOP_STATEMENT = /^(?:true|:|\/usr\/bin\/true|\/bin\/true|exit(?: 0)?|echo(?: (?:""|''))?|sleep 0)?$/;

function isNoopCommand(command: string) {
  return command.split(/;|&&|\|\||\n/).every(part => NOOP_STATEMENT.test(part.trim().replace(/\s+/g, ' ')));
}
/** Briefing card tools (`mc.*`), which answer an unchanged repeat with "nothing recorded". */
const CARD_TOOL = /^mc[._]/;

function readCommand(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.script;
  return typeof command === 'string' ? command : null;
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Watches one OpenCode run's normalized messages and says when the model is
 * only making no-op tool calls. A no-op is a shell call whose command does
 * nothing (`true`, `:`, empty), or a card tool called again with the same input
 * and the same answer as the call right before it. Any other tool call resets
 * the count; reasoning and text between calls do not, since the observed loop
 * reasoned before every `true`. Each tool call id counts once, so a part
 * re-published on completion is not a second call.
 * Consumed by `server/opencode-cli.js`, one instance per spawned run.
 */
export class NoopToolLoopGuard {
  private streak = 0;
  private previousKey = '';
  private readonly seen = new Set<string>();
  private trippedReason: string | null = null;

  constructor(private readonly limit = NOOP_TOOL_LOOP_LIMIT) {}

  /** Returns the stop reason once, on the call that reaches the limit; null otherwise. */
  observe(message: ToolMessage): string | null {
    if (message.kind !== 'tool_use' || this.trippedReason) return null;
    const toolId = typeof message.toolId === 'string' ? message.toolId : '';
    if (toolId) {
      if (this.seen.has(toolId)) return null;
      this.seen.add(toolId);
    }
    const toolName = typeof message.toolName === 'string' ? message.toolName : '';
    const key = `${toolName}\u0000${stableKey(message.toolInput)}\u0000${stableKey(message.toolResult)}`;
    const command = SHELL_TOOLS.has(toolName.toLowerCase()) ? readCommand(message.toolInput) : null;
    const noop = (command !== null && isNoopCommand(command))
      || (CARD_TOOL.test(toolName) && key === this.previousKey);
    this.previousKey = key;
    this.streak = noop ? this.streak + 1 : 0;
    if (this.streak < this.limit) return null;
    const what = command !== null ? `${toolName} \`${command.trim() || '(empty)'}\`` : `${toolName} repeated unchanged`;
    this.trippedReason = `Stopped this turn after ${this.streak} consecutive no-op tool calls (last: ${what}). `
      + 'The model kept calling tools that change nothing instead of ending its turn. The session stays open; send a message to continue.';
    return this.trippedReason;
  }

  /** The reason this run was stopped, or null while it was not. */
  get reason() {
    return this.trippedReason;
  }
}
