/**
 * Turns an in-flight tool call into the one-line "what's happening right now"
 * label the chat activity indicator shows while a turn runs.
 *
 * Distinct from `describeTool` in notification-content.js: that one names a
 * pending action awaiting approval ("$ npm test"), this one narrates work
 * already underway ("Running npm test"), and it is short enough to sit in a
 * single composer-width line.
 */

const MAX_STATUS = 60;
const MAX_PATH_SEGMENTS = 2;

function clip(value, max = MAX_STATUS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Paths are usually long and only the tail is recognizable. */
function shortenPath(filePath) {
  const segments = String(filePath ?? '').split(/[\\/]/).filter(Boolean);
  if (!segments.length) return '';
  return clip(segments.slice(-MAX_PATH_SEGMENTS).join('/'), 40);
}

export function describeToolActivity(name, input = {}) {
  if (!name) return null;

  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return input.command ? `Running ${clip(input.command)}` : 'Running a command';
    case 'Read':
      return input.file_path ? `Reading ${shortenPath(input.file_path)}` : 'Reading a file';
    case 'Write':
      return input.file_path ? `Writing ${shortenPath(input.file_path)}` : 'Writing a file';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return input.file_path ? `Editing ${shortenPath(input.file_path)}` : 'Editing a file';
    case 'Grep':
      return input.pattern ? `Searching for ${clip(input.pattern, 40)}` : 'Searching the code';
    case 'Glob':
      return input.pattern ? `Finding ${clip(input.pattern, 40)}` : 'Finding files';
    case 'WebFetch':
      return input.url ? `Fetching ${clip(input.url, 40)}` : 'Fetching a page';
    case 'WebSearch':
      return input.query ? `Searching the web for ${clip(input.query, 40)}` : 'Searching the web';
    case 'Task':
    case 'Agent':
      return input.description ? `Running agent: ${clip(input.description, 40)}` : 'Running an agent';
    case 'TodoWrite':
      return 'Updating the plan';
    case 'AskUserQuestion':
      return 'Waiting on your answer';
    default:
      // MCP tools arrive as mcp__<server>__<tool>; the bare tool name reads
      // better than the wire name.
      return `Running ${clip(String(name).split('__').pop(), 40)}`;
  }
}

/**
 * Picks the label for one assistant message: the last tool it invoked, or null
 * when it only produced prose (the indicator then falls back to its own
 * rotating "Thinking / Working / …" words, which is the honest description of
 * a model that is writing rather than acting).
 */
export function describeAssistantActivity(message) {
  const blocks = message?.message?.content;
  if (!Array.isArray(blocks)) return null;

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type === 'tool_use' && block.name) {
      return describeToolActivity(block.name, block.input || {});
    }
  }

  return null;
}
