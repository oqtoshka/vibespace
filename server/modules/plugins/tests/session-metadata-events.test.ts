import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publishSessionMetadataChange,
  subscribeSessionMetadataChanges,
} from '@/modules/plugins/index.js';
import { resetSessionMetadataEventsForTests } from '@/modules/plugins/services/session-metadata-events.service.js';

test('publishes only meaningful session metadata changes', { concurrency: false }, () => {
  resetSessionMetadataEventsForTests();
  const received: string[] = [];
  const unsubscribe = subscribeSessionMetadataChanges((change) => received.push(change.title));
  const base = {
    sessionId: 'app-1',
    provider: 'codex',
    providerSessionId: 'provider-1',
    projectPath: '/project',
    transcriptPath: '/transcript.jsonl',
    title: 'First Title',
    recap: '',
    isPrivate: false,
  };

  publishSessionMetadataChange(base);
  publishSessionMetadataChange(base);
  publishSessionMetadataChange({ ...base, title: 'Generated Title' });
  unsubscribe();
  publishSessionMetadataChange({ ...base, title: 'Ignored Title' });

  assert.deepEqual(received, ['First Title', 'Generated Title']);
  resetSessionMetadataEventsForTests();
});
