import assert from 'node:assert/strict';
import test from 'node:test';

import { ATTACHMENT_LINK_ATTRIBUTE, remarkWorkspaceFileLinks } from './remarkWorkspaceFileLinks';

type Node = { type: string; value?: string; url?: string; children?: Node[]; data?: any };

const paragraph = (...children: Node[]): Node => ({ type: 'root', children: [{ type: 'paragraph', children }] });
const text = (value: string): Node => ({ type: 'text', value });
const run = (tree: Node, projectRoot: string | null = '/workspace') => {
  remarkWorkspaceFileLinks({ projectRoot })(tree as any);
  return tree.children![0].children!;
};

test('turns a MEDIA line into an attachment link named after the file', () => {
  const nodes = run(paragraph(text('Готово.\nMEDIA:/workspace/out/report.xlsx')));
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0], text('Готово.\n'));
  assert.equal(nodes[1].type, 'link');
  assert.equal(nodes[1].url, '/workspace/out/report.xlsx');
  assert.equal(nodes[1].children![0].value, 'report.xlsx');
  assert.equal(nodes[1].data.hProperties[ATTACHMENT_LINK_ATTRIBUTE], 'true');
});

test('accepts relative MEDIA targets and a space after the colon', () => {
  const nodes = run(paragraph(text('MEDIA: ./out/a.pdf')));
  assert.equal(nodes[0].url, './out/a.pdf');
});

test('links bare paths under the project root and drops sentence punctuation', () => {
  const nodes = run(paragraph(text('Файл лежит в /workspace/out/итог.docx.')));
  assert.equal(nodes.length, 3);
  assert.equal(nodes[1].url, '/workspace/out/итог.docx');
  assert.equal(nodes[1].data, undefined);
  assert.deepEqual(nodes[2], text('.'));
});

test('leaves paths outside the project root, bare roots and code alone', () => {
  const code: Node = { type: 'inlineCode', value: 'MEDIA:/workspace/out/x.txt' };
  const nodes = run(paragraph(text('see /etc/passwd and /workspace/ and /workspaces/x.txt'), code));
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].type, 'text');
  assert.equal(nodes[1], code);
});

test('does not rewrite text inside existing links', () => {
  const link: Node = { type: 'link', url: 'out/a.txt', children: [text('/workspace/out/a.txt')] };
  const nodes = run(paragraph(link));
  assert.equal(nodes[0].children![0].type, 'text');
});

test('without a project root only MEDIA lines are linked', () => {
  const nodes = run(paragraph(text('/workspace/out/a.txt MEDIA:/tmp/b.txt')), null);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].url, '/tmp/b.txt');
});
