#!/usr/bin/env node
// Regression against compiled server + client artifacts, without production state or agent runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(process.argv[2] || '.');
const require = createRequire(path.join(root, 'package.json'));
const { WebSocket } = require('ws');
const Database = require('better-sqlite3');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-v2-artifact-'));
fs.mkdirSync(path.join(home, '.vibespace'));
const database = path.join(home, '.vibespace', 'auth.db');
fs.writeFileSync(database, '');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
// Isolate application paths without replacing the shell's HOME or inheriting
// production tokens. Sync named builtin exports before loading server modules.
const preload = path.join(home, 'isolate-paths.mjs');
fs.writeFileSync(preload, `import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
os.homedir = () => ${JSON.stringify(home)};
syncBuiltinESMExports();
`);
const child = spawn(process.execPath, ['--import', preload, path.join(root, 'dist-server/server/index.js')], {
  cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
  env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', DATABASE_PATH: database, HOST: '127.0.0.1',
    SERVER_PORT: String(port), VIBESPACE_SESSION_RESTORE: '0', VS_OIDC_ISSUER: ' ',
    ANTHILL_RUNNER: 'false', VIBESPACE_MODE: 'local' },
});
// A separate watchdog survives the test driver disappearing. Stdin closure also
// ends it immediately on normal cleanup, instead of leaving a two-minute sleeper.
const watchdog = spawn(process.execPath, ['-e', `
 const pid=Number(process.argv[1]);
 const timer=setTimeout(()=>{try{process.kill(pid,'SIGKILL')}catch{};process.exit(1)},120000);
 let confirmed=false;process.stdin.on('data',data=>{if(data.toString()==='done')confirmed=true});
 process.stdin.on('end',()=>{clearTimeout(timer);if(!confirmed){try{process.kill(pid,'SIGKILL')}catch{}};process.exit(0)});
`, String(child.pid)], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
watchdog.unref();
const sockets = new Set();
let db;
const origin = `http://127.0.0.1:${port}`;
const federation = 'f'.repeat(40);
const key = 'b'.repeat(128);
function mint(id, issued = Math.floor(Date.now() / 1000), secret = key) {
  const expires = issued + 900;
  const signature = createHmac('sha256', secret)
    .update(`mission-control:vibespace-session:v2:${id}:${issued}:${expires}`).digest('base64url');
  return `v2.${issued}.${expires}.${signature}`;
}
function open(id, credential) {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/native-chat/' + id,
    { headers: { 'x-vibespace-session-capability': credential }, handshakeTimeout: 3000 });
  sockets.add(ws); ws.on('close', () => sockets.delete(ws));
  return ws;
}
function closed(ws) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { ws.terminate(); reject(new Error('Socket close deadline')); }, 5000);
    ws.once('close', code => { clearTimeout(deadline); resolve(code); });
    ws.once('error', error => { clearTimeout(deadline); reject(error); });
  });
}
function hello(ws) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Hello deadline')), 5000);
    ws.once('message', raw => {
      clearTimeout(deadline);
      try { assert.equal(JSON.parse(raw).kind, 'native.hello'); resolve(); } catch (e) { reject(e); }
    });
    ws.once('error', error => { clearTimeout(deadline); reject(error); });
  });
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error('Compiled server exited before readiness');
    try {
      const page = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      if (page.status === 200 && /<script[^>]+src="\/assets\//.test(await page.text())) { ready = true; break; }
    } catch { /* Bounded boot observation, never a missing-session result. */ }
    await delay(250);
  }
  assert.ok(ready, 'compiled client bundle served');
  const registration = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fixture', password: 'fixture-only-password-9Hd' }) });
  assert.ok(registration.ok);
  db = new Database(database);
  const put = (name, value) => db.prepare('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)').run(name, value);
  put('mc_federation_token', federation); put('mc_session_capability_secret_v2', key);
  const ids = { active: 'ses_legacy-test', archived: 'archived', private: 'private', side: 'side', missing: 'missing' };
  for (const [kind, id] of Object.entries(ids)) if (kind !== 'missing') {
    db.prepare('INSERT INTO sessions(session_id,provider,isArchived,is_private,is_side) VALUES (?,?,?,?,?)')
      .run(id, 'codex', Number(kind === 'archived'), Number(kind === 'private'), Number(kind === 'side'));
  }
  for (const [kind, id] of Object.entries(ids)) {
    const response = await fetch(origin + '/api/native-control/sessions/' + id + '/owner-capability', { headers: { 'x-mc-federation-token': federation } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    if (kind === 'private' || kind === 'side') { assert.equal(response.status, 400); assert.equal(body.capability, undefined); }
    else {
      assert.equal(response.status, 200); assert.equal(body.state, kind); assert.equal(body.sessionId, id);
      if (kind !== 'missing') {
        assert.match(body.capability, /^v2\./);
        const parts = body.capability.split('.');
        assert.equal(Number(parts[2]) - Number(parts[1]), 900);
        assert.equal(body.capability, mint(id, Number(parts[1])));
      } else assert.equal(body.capability, undefined);
    }
  }
  assert.equal((await fetch(origin + '/api/native-control/sessions/archived/owner-capability')).status, 403);
  const jwt = db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get().value;
  const v1 = createHmac('sha256', jwt).update('mission-control:vibespace-session:v1:' + ids.active).digest('base64url');
  for (const credential of [v1, 'é'.repeat(43), mint(ids.active, Math.floor(Date.now() / 1000) - 901), mint('other')]) {
    assert.equal(await closed(open(ids.active, credential)), 4403);
  }
  assert.equal(await closed(open('missing', mint('missing'))), 4404);
  console.log('ARTIFACT_OWNER_PRIVACY_LEGACY_IDS_V1_REJECTION_AND_900S_TTL_PASS');
  const issued = Math.floor(Date.now() / 1000) - 898;
  const idle = open(ids.active, mint(ids.active, issued));
  const idleClosed = closed(idle); await hello(idle); assert.equal(await idleClosed, 1012);
  const renewing = open(ids.active, mint(ids.active, Math.floor(Date.now() / 1000) - 898));
  await hello(renewing);
  renewing.send(JSON.stringify({ type: 'native.renew', capability: mint(ids.active) }));
  await delay(2500); assert.equal(renewing.readyState, WebSocket.OPEN);
  put('jwt_secret', 'rotated-browser-fixture');
  const independent = open(ids.active, mint(ids.active)); await hello(independent); independent.close();
  db.prepare('UPDATE sessions SET is_private=1 WHERE session_id=?').run(ids.active);
  const revoked = closed(renewing); renewing.send('{"type":"native.history","requestId":"privacy-probe"}');
  assert.equal(await revoked, 1012);
  db.prepare('UPDATE sessions SET is_private=0 WHERE session_id=?').run(ids.active);
  const rotation = open(ids.active, mint(ids.active)); await hello(rotation);
  put('mc_session_capability_secret_v2', 'c'.repeat(128));
  const rotated = closed(rotation); rotation.send('{"type":"native.history","requestId":"rotation-probe"}');
  assert.equal(await rotated, 1012);
  assert.equal((await fetch(origin)).status, 200);
  console.log('ARTIFACT_IDLE_EXPIRY_SEAMLESS_RENEWAL_JWT_INDEPENDENCE_PRIVACY_AND_ROTATION_PASS');
} finally {
  for (const ws of sockets) ws.terminate();
  db?.close();
  child.kill('SIGTERM');
  if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(4000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  watchdog.stdin.end('done');
  fs.rmSync(home, { recursive: true, force: true });
}
