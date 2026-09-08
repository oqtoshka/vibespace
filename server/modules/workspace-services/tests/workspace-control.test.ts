import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WorkspaceControl } from '../workspace-control.service.js';

test('invitations bind to a recipient; owner chooses access and outsiders cannot revoke', () => {
  const links = new Map(['alice','bob','eve'].map(user => [user, { enabled: true, workspace_id: 'agent-'+user }]));
  const control = new WorkspaceControl(':memory:', links);
  try {
    const invite = control.share('alice', { recipient: 'bob', path: 'reports', kind: 'folder', access: 'write' }) as { id: string; invitation: string };
    const token = new URL(invite.invitation, 'http://test').searchParams.get('workspaceShare')!;
    assert.throws(() => control.accept('eve', token), /unavailable/);
    assert.throws(() => control.revoke('eve', invite.id), /not found/);
    control.accept('bob', token);
    assert.throws(() => control.accept('bob', token), /unavailable/);
    const list = control.list('alice') as { shares: Array<{ access: string; status: string }> };
    assert.equal(list.shares[0].access,'write');
    assert.equal(list.shares[0].status,'requested');
    control.revoke('alice', invite.id);
    for (const folder of ['../other','/etc','safe/../other','safe//other','safe\\other']) {
      assert.throws(() => control.share('alice', { recipient: 'bob', path: folder, kind: 'folder', access: 'read' }), /folder/);
    }
    assert.throws(() => control.share('alice', { recipient: 'bob', path: 'reports', kind: 'skill', access: 'read' }), /skill/);
    assert.throws(() => control.backup('alice','somebody-elses-snapshot'),/not found/);
    control.backup('alice',null);
    assert.throws(() => control.backup('alice',null),/already running/);
    links.delete('bob');
    assert.throws(() => control.list('bob'),/unavailable/);
  } finally { control.close(); }
});
