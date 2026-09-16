import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WorkspacePolicy } from '../workspace-policy.service.js';

test('managed paths reject descendants, ancestor mutations, nested projects and symlink aliases', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-policy-'));
  try {
    const root = path.join(directory, 'workspace');
    await mkdir(path.join(root, 'system/core'), {recursive:true});
    await writeFile(path.join(root, 'system/core/SKILL.md'), 'managed');
    await symlink(path.join(root, 'system'), path.join(root, 'alias'));
    const filename = path.join(directory, 'policy.json');
    await writeFile(filename, JSON.stringify({version:1, root, rules:[{path:'system/core',readOnly:true,hidden:true,displayName:'Core skills'}]}));
    const policy = new WorkspacePolicy(() => filename);
    for (const target of ['system/core', 'system/core/SKILL.md', 'system/core/new/file.md', 'system', 'alias/core/SKILL.md', 'alias']) {
      await assert.rejects(policy.assertWritable(path.join(root,target)), {code:'EACCES'}, target);
    }
    await policy.assertWritable(path.join(root,'system/core-personal/SKILL.md'));
    await policy.assertWritable(path.join(root,'report.html'));
    await assert.rejects(policy.assertWritable(root), {code:'EACCES'});
    assert.equal((await policy.read())?.rules[0].displayName, 'Core skills');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('configured policy fails closed when missing, invalid or traversing; unconfigured local mode works', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-policy-invalid-'));
  try {
    const filename = path.join(directory, 'policy.json');
    const policy = new WorkspacePolicy(() => filename);
    await assert.rejects(policy.assertWritable(directory), {code:'WORKSPACE_POLICY_UNAVAILABLE'});
    for (const document of ['broken', JSON.stringify({version:1,root:directory,rules:[{path:'../escape',readOnly:true}]}), JSON.stringify({version:1,root:directory,rules:[{path:'core',readOnly:'false'}]})]) {
      await writeFile(filename,document);
      await assert.rejects(policy.assertWritable(directory), {code:'WORKSPACE_POLICY_UNAVAILABLE'});
    }
    const local = new WorkspacePolicy(() => undefined);
    await local.assertWritable('/does/not/exist');
    assert.equal(await local.read(), null);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('policy changes apply without restart and protected symlink targets cannot be edited by real path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-policy-reload-'));
  try {
    await mkdir(path.join(directory,'actual'));
    await symlink(path.join(directory,'actual'),path.join(directory,'managed'));
    const filename=path.join(directory,'policy.json');
    const policy=new WorkspacePolicy(()=>filename);
    await writeFile(filename,JSON.stringify({version:1,root:directory,rules:[]}));
    await policy.assertWritable(path.join(directory,'actual/new'));
    await writeFile(filename,JSON.stringify({version:1,root:directory,rules:[{path:'managed',readOnly:true}]}));
    await assert.rejects(policy.assertWritable(path.join(directory,'actual/new')), {code:'EACCES'});
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('admin edits are authorized, validated, audited and reject stale revisions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'workspace-policy-admin-'));
  try {
    const filename=path.join(directory,'policy.json');
    await writeFile(filename,JSON.stringify({version:1,root:directory,rules:[]}));
    const policy=new WorkspacePolicy(()=>filename,['operator']);
    const before=await policy.snapshot();
    await assert.rejects(policy.save('ordinary',[],before.revision),{code:'EACCES'});
    await assert.rejects(policy.save('operator',[{path:'../secret'}],before.revision),{code:'INVALID_POLICY'});
    const after=await policy.save('operator',[{path:'SOUL.md',hidden:true,readOnly:true}],before.revision);
    assert.notEqual(after.revision,before.revision);
    await assert.rejects(policy.save('operator',[],before.revision),{code:'POLICY_CONFLICT'});
    const competing=await Promise.allSettled([
      policy.save('operator',[{path:'first'}],after.revision),
      policy.save('operator',[{path:'second'}],after.revision),
    ]);
    assert.equal(competing.filter(value=>value.status==='fulfilled').length,1);
    const {readFile}=await import('node:fs/promises');
    const audit=(await readFile(`${filename}.audit.jsonl`,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(audit.filter(value=>value.state==='committed').length,2);
    assert.equal(audit[0].actor,'operator');
    assert.deepEqual(audit[0].before.rules,[]);
  } finally {await rm(directory,{recursive:true,force:true});}
});
