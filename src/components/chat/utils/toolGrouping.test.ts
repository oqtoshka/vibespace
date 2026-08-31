import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { toolGroupHasImages, type ToolGroupItem } from './toolGrouping';

function groupWith(messages: ChatMessage[]): ToolGroupItem {
  return {
    _isGroup: true,
    toolName: 'exec',
    messages,
    timestamp: messages[0]?.timestamp,
  };
}

test('tool groups auto-expand only when a result contains images', () => {
  const plainMessage = {
    id: 'plain',
    type: 'tool',
    content: '',
    timestamp: new Date(),
    toolResult: { content: 'ok', isError: false },
  } as ChatMessage;
  const imageMessage = {
    ...plainMessage,
    id: 'image',
    toolResult: {
      content: '',
      isError: false,
      images: [{ data: 'data:image/png;base64,aGVsbG8=' }],
    },
  } as ChatMessage;

  assert.equal(toolGroupHasImages(groupWith([plainMessage])), false);
  assert.equal(toolGroupHasImages(groupWith([plainMessage, imageMessage])), true);
});
