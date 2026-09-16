import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWorkspaceOriginAllowed } from '../workspace-origin.service.js';

test('workspace write/upgrade boundary rejects sibling same-site apps and opaque origins', () => {
  const workspace = 'https://workspace.example.com';
  assert.equal(isWorkspaceOriginAllowed('https://a-random.apps.example.com', 'same-site', workspace), false);
  assert.equal(isWorkspaceOriginAllowed('null', 'same-site', workspace), false);
  assert.equal(isWorkspaceOriginAllowed(undefined, 'cross-site', workspace), false);
  assert.equal(isWorkspaceOriginAllowed([workspace], undefined, workspace), false);
  assert.equal(isWorkspaceOriginAllowed(workspace, 'same-origin', workspace), true);
  assert.equal(isWorkspaceOriginAllowed(undefined, undefined, workspace), true);
});
