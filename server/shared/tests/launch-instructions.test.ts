import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAUNCH_INSTRUCTIONS_BEGIN,
  LAUNCH_INSTRUCTIONS_END,
  prependLaunchInstructions,
  stripLaunchInstructions,
} from '@/shared/utils.js';

const BRIEFING = [
  '# Briefing mode (Mission Control)',
  '',
  'This session is read from a structured card on Mission Control, not from this chat.',
  ...Array.from({ length: 400 }, (_, i) => `- rule ${i}: declare as you go`),
].join('\n');

test('prependLaunchInstructions fences the instructions and keeps the prompt last', () => {
  const prompt = prependLaunchInstructions(BRIEFING, 'Fix the login page');
  assert.ok(prompt.startsWith(`${LAUNCH_INSTRUCTIONS_BEGIN}\n# Briefing mode`));
  assert.ok(prompt.includes(`${LAUNCH_INSTRUCTIONS_END}\n\n---\n\nFix the login page`));
  assert.equal(prependLaunchInstructions('  ', 'Fix it'), 'Fix it');
});

test('stripLaunchInstructions returns the user words of a marked prompt', () => {
  assert.equal(stripLaunchInstructions(prependLaunchInstructions(BRIEFING, 'Fix the login page')), 'Fix the login page');
  // The user's own rule or front matter after the separator survives.
  assert.equal(stripLaunchInstructions(prependLaunchInstructions('Be brief.', '---\ntitle: x\n---\nbody')), '---\ntitle: x\n---\nbody');
  // A message cut inside the preamble carries no user words.
  assert.equal(stripLaunchInstructions(prependLaunchInstructions(BRIEFING, 'Fix it').slice(0, 2_000)), '');
});

test('stripLaunchInstructions sees past an unmarked briefing preamble from older rollouts', () => {
  assert.equal(stripLaunchInstructions(`${BRIEFING}\n\n---\n\nПогаси VS Code в браузере`), 'Погаси VS Code в браузере');
  assert.equal(stripLaunchInstructions(`Other plugin block\n\n${BRIEFING}\n\n---\n\nFix it`), 'Fix it');
  assert.equal(stripLaunchInstructions(BRIEFING.slice(0, 2_000)), '');
});

test('stripLaunchInstructions leaves ordinary messages alone', () => {
  const plain = '# Plan\n\nFirst part\n\n---\n\nSecond part';
  assert.equal(stripLaunchInstructions(plain), plain);
  assert.equal(stripLaunchInstructions('Fix the login page'), 'Fix the login page');
  assert.equal(stripLaunchInstructions(''), '');
});
