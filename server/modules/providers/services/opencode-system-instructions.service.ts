import { readObjectRecord } from '../../../shared/index.js';

/**
 * The legacy OpenCode runner uses this to put launch overrides in the native
 * agent prompt before the first model call, including when resuming a session.
 * The durable HTTP engine's Prompt schema has no system-instruction field.
 */
export function applyOpenCodeSystemInstructions(
  env: NodeJS.ProcessEnv,
  systemInstructions: string | undefined,
  permissionMode: string | undefined,
): NodeJS.ProcessEnv {
  if (!systemInstructions?.trim()) return env;

  const config = env.OPENCODE_CONFIG_CONTENT
    ? readObjectRecord(JSON.parse(env.OPENCODE_CONFIG_CONTENT))
    : {};
  if (!config) throw new Error('OPENCODE_CONFIG_CONTENT must be a JSON object');
  const agents = readObjectRecord(config.agent) ?? {};
  const agentName = permissionMode === 'plan' ? 'plan' : 'build';
  const agent = readObjectRecord(agents[agentName]) ?? {};
  const priorPrompt = typeof agent.prompt === 'string' ? agent.prompt : '';
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      agent: {
        ...agents,
        [agentName]: {
          ...agent,
          prompt: [priorPrompt, systemInstructions].filter(Boolean).join('\n\n'),
        },
      },
    }),
  };
}
