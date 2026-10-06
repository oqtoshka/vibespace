import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const root=new URL('../../',import.meta.url);
test('production package retains executable diagnostic assets and its runtime parser',()=>{
 const pkg=JSON.parse(readFileSync(new URL('package.json',root),'utf8'));
 const lock=JSON.parse(readFileSync(new URL('package-lock.json',root),'utf8'));
 assert.equal(pkg.dependencies.typescript,lock.packages[''].dependencies.typescript);
 assert.equal(typeof pkg.dependencies.typescript,'string');
 assert.equal(pkg.devDependencies.typescript,undefined);
 assert.notEqual(lock.packages['node_modules/typescript'].dev,true);
 const [packed]=JSON.parse(execFileSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:root,timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 for(const name of ['codex-report-whitespace.mjs','codex-report-whitespace-proxy.mjs']) {
  const asset=packed.files.find(f=>f.path===`scripts/diagnostics/${name}`);
  assert.ok(asset,`${name} must be in release tarball`);
  if(name.includes('proxy'))assert.ok(asset.mode&0o111,'proxy must remain executable');
 }
});
