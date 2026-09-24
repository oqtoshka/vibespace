import assert from 'node:assert/strict';
import test from 'node:test';

import type { Plugin } from '../contexts/PluginsContext';

import { findLaunchOptionBannerAction, sessionLaunchOptionsWith } from './launchOptionMarks';

const declarations = [
  { id: 'acme.review', label: 'review', marker: { label: 'review' }, banner: { text: 'Read it on the board.' }, inertWhenPrivate: true },
  { id: 'acme.quiet', label: 'quiet' },
];

test('only options the session was started with, and only those that ask for the field', () => {
  assert.deepEqual(sessionLaunchOptionsWith(declarations, null, 'marker'), []);
  assert.deepEqual(sessionLaunchOptionsWith(declarations, {}, 'marker'), []);
  assert.deepEqual(sessionLaunchOptionsWith(declarations, { 'acme.review': false }, 'marker'), []);
  assert.deepEqual(
    sessionLaunchOptionsWith(declarations, { 'acme.review': { needsPlan: true }, 'acme.quiet': true }, 'marker').map((option) => option.id),
    ['acme.review'],
  );
  assert.deepEqual(
    sessionLaunchOptionsWith(declarations, { 'acme.quiet': true }, 'banner'),
    [],
  );
  assert.deepEqual(
    sessionLaunchOptionsWith(declarations, { 'acme.review': true, 'unknown.option': true }, 'banner').map((option) => option.id),
    ['acme.review'],
  );
  assert.deepEqual(sessionLaunchOptionsWith(declarations, { 'acme.review': true }, 'marker', true), [], 'inert on a private session');
});

const action = { id: 'open-board', label: 'Open the board', endpoint: '/api/acme/sessions/{sessionId}/board' };
const plugin = { name: 'acme', enabled: true, sessionActions: [action] } as unknown as Plugin;
const option = { id: 'acme.review', label: 'review', pluginName: 'acme', banner: { text: 'Read it on the board.', actionId: 'open-board' } };

test('a banner links only to a session action of the enabled plugin that declared it', () => {
  assert.equal(findLaunchOptionBannerAction([plugin], option), action);
  assert.equal(findLaunchOptionBannerAction([{ ...plugin, enabled: false }], option), null);
  assert.equal(findLaunchOptionBannerAction([{ ...plugin, name: 'other' }], option), null);
  assert.equal(findLaunchOptionBannerAction([plugin], { ...option, pluginName: undefined }), null);
  assert.equal(findLaunchOptionBannerAction([plugin], { ...option, banner: { text: 'No link.' } }), null);
  assert.equal(findLaunchOptionBannerAction([plugin], { ...option, banner: { text: 'x', actionId: 'missing' } }), null);
});
