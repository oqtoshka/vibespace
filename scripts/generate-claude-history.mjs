import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const syntheticSessionId = '11111111-1111-4111-8111-111111111111';

/** Deterministic, installation-independent Claude transcript rows for benchmarks and differential tests. */
export function syntheticTurn(turn, outputBytes = 32_768) {
  const timestamp = new Date(Date.UTC(2026, 0, 1) + turn * 1000).toISOString();
  const row = (suffix, role, content, extra = {}) => ({
    sessionId: syntheticSessionId, uuid: `turn-${turn}-${suffix}`, timestamp,
    type: role, message: { role, content }, ...extra,
  });
  return [
    row('prompt', 'user', [{ type: 'text', text: `Inspect example ${turn}` },
      ...(turn % 79 === 0 ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }] : [])]),
    row('call', 'assistant', [
      { type: 'thinking', thinking: `Consider example ${turn}.` },
      { type: 'tool_use', id: `tool-${turn}`, name: turn % 41 === 0 ? 'Task' : 'Read', input: { file_path: '/Users/dev/example.txt' } },
    ]),
    row('result', 'user', [{ type: 'tool_result', tool_use_id: `tool-${turn}`, content: `Output ${turn}: ` + 'sample output\n'.repeat(Math.ceil(outputBytes / 14)) }],
      turn % 41 === 0 ? { toolUseResult: { agentId: 'example-agent' } } : {}),
    row('answer', 'assistant', [{ type: 'text', text: `Finished example ${turn}.` }]),
    ...(turn % 37 === 0 ? [row('internal', 'user', '<system-reminder>Internal metadata</system-reminder>')] : []),
    ...(turn % 43 === 0 ? [row('sidechain', 'user', 'Subagent prompt', { isSidechain: true })] : []),
    ...(turn % 47 === 0 ? [row('retry', 'user', 'Retry now <!-- vibespace-retry:example-retry -->')] : []),
  ];
}

/** Writes at least the requested size without holding the generated transcript in memory. */
export async function generateClaudeHistory(directory, megabytes = 320) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${syntheticSessionId}.jsonl`);
  const handle = await open(file, 'w');
  let bytes = 0;
  let turns = 0;
  try {
    while (bytes < megabytes * 1024 * 1024) {
      const chunk = syntheticTurn(turns++).map(row => JSON.stringify(row)).join('\n') + '\n';
      await handle.write(chunk);
      bytes += Buffer.byteLength(chunk);
    }
    await handle.write('malformed JSON\n{"unfinished":');
  } finally { await handle.close(); }
  const agents = path.join(directory, syntheticSessionId, 'subagents');
  await mkdir(agents, { recursive: true });
  const agent = await open(path.join(agents, 'agent-example-agent.jsonl'), 'w');
  try {
    for (let i = 0; i < 20; i++) {
      await agent.write(syntheticTurn(i, 4096).map(row => JSON.stringify({ ...row, isSidechain: true })).join('\n') + '\n');
    }
  } finally { await agent.close(); }
  return { file, bytes, turns };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await generateClaudeHistory(process.argv[2], Number(process.argv[3] || 320));
  console.log(JSON.stringify({ bytes: result.bytes, turns: result.turns }));
}
