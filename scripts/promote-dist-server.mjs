#!/usr/bin/env node
// The server build stages into dist-server.next and this script promotes it
// into place. The live dist-server must never be deleted before the new build
// is complete: an interrupted build would otherwise leave the installation
// without a server entrypoint, crash-looping on MODULE_NOT_FOUND at every
// start until someone rebuilds it by hand.
import fs from 'node:fs';

const NEXT = 'dist-server.next';
const LIVE = 'dist-server';
const OLD = 'dist-server.old';
const ENTRY = 'server/index.js';

const mode = process.argv[2] ?? 'promote';

if (mode === 'recover') {
  // Ran before every server start: if a promotion was interrupted between the
  // two renames, put the previous build back so the server can boot.
  if (!fs.existsSync(`${LIVE}/${ENTRY}`) && fs.existsSync(`${OLD}/${ENTRY}`)) {
    console.error('promote-dist-server: restoring previous dist-server after an interrupted promotion.');
    fs.rmSync(LIVE, { recursive: true, force: true });
    fs.renameSync(OLD, LIVE);
  }
  process.exit(0);
}

if (mode !== 'promote') {
  console.error(`promote-dist-server: unknown mode "${mode}" (expected "promote" or "recover").`);
  process.exit(64);
}

/**
 * A `foo.ts` sitting next to a `foo.js` is not a build error: TypeScript treats
 * them as one module, silently emits the `.ts` and drops the `.js`. The v1.37.2
 * upstream merge left upstream's `server/index.ts` next to ours, so the shipped
 * entrypoint was upstream's — with none of our routes and no mid-turn message
 * injection — while every check (tsc, lint, tests, the tarball listing) stayed
 * green. Fail the build instead of shipping the wrong file.
 */
function findTypeScriptTwins(directory) {
  const twins = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      twins.push(...findTypeScriptTwins(full));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    if (fs.existsSync(`${full.slice(0, -3)}.js`)) twins.push(full.slice(0, -3));
  }
  return twins;
}

const twins = findTypeScriptTwins('server');
if (twins.length > 0) {
  console.error(
    `promote-dist-server: ${twins.length} source file(s) exist as BOTH .ts and .js — ` +
      'TypeScript emits only the .ts and the .js is silently dropped:\n  ' +
      twins.map((name) => `${name}.ts / ${name}.js`).join('\n  ') +
      '\nDelete whichever one is not the real implementation, then rebuild.',
  );
  process.exit(1);
}

if (!fs.existsSync(`${NEXT}/${ENTRY}`)) {
  console.error(`promote-dist-server: ${NEXT}/${ENTRY} is missing; leaving the current ${LIVE} untouched.`);
  process.exit(1);
}

fs.rmSync(OLD, { recursive: true, force: true });
if (fs.existsSync(LIVE)) {
  fs.renameSync(LIVE, OLD);
}
try {
  fs.renameSync(NEXT, LIVE);
} catch (error) {
  // Put the previous build back before failing so the installation still boots.
  if (fs.existsSync(OLD) && !fs.existsSync(LIVE)) {
    fs.renameSync(OLD, LIVE);
  }
  throw error;
}
fs.rmSync(OLD, { recursive: true, force: true });
