// Run after npm run build:native-viewer. PLAYWRIGHT_MODULE may point at an installed Playwright.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../dist-native-viewer/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!['index.html', 'viewer.js', 'viewer.css'].includes(name)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(name === 'index.html'
      ? '<html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="viewer.css"></head><body><div id="root"></div><script src="viewer.js"></script></body></html>'
      : await readFile(root + (name === 'viewer.css' ? 'vibespace.css' : name)));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
  await page.addInitScript(() => { window.webkit = { messageHandlers: { workspace: { postMessage: async payload => payload.op === 'html'
    ? { entryUrl: 'data:text/html,<h1>Native HTML fixture</h1>', resourceRoots: [] } : {} } } }; });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.mcOpen === 'function');
  const content = '# Native Markdown\n\n**Rendered bold**\n\n- First item\n- Second item\n\n| Name | Value |\n| --- | --- |\n| Answer | 42 |\n\n```js\nconst answer = 42;\n```';
  const document = { projectId: 'fixture', path: 'README.md', name: 'README.md', content, source: false, version: '1' };
  await page.evaluate(document => window.mcOpen(document), document);
  await page.locator('h1').filter({ hasText: 'Native Markdown' }).waitFor();
  assert.equal(await page.locator('strong').filter({ hasText: 'Rendered bold' }).count(), 1);
  assert.equal(await page.locator('table td').filter({ hasText: '42' }).count(), 1);
  assert.equal(await page.locator('li').filter({ hasText: 'First item' }).count(), 1);
  assert.equal(await page.getByText('Preview failed.', { exact: false }).count(), 0);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.locator('h1').filter({ hasText: 'Native Markdown' }).waitFor();
  await page.evaluate(document => window.mcOpen(document), { ...document, source: true });
  assert.equal(await page.locator('.native-source').textContent(), content);
  await page.evaluate(() => window.mcSuspend());
  await page.getByText('Choose a file from the project tree or chat.').waitFor();
  assert.equal(await page.locator('.native-source').count(), 0);
  await page.evaluate(document => window.mcOpen(document), { ...document, path: 'fixture.html', name: 'fixture.html', content: '<h1>Native HTML fixture</h1>' });
  await page.getByTitle('Zoom in', { exact: true }).waitFor();
  assert.equal(await page.getByTitle('Fullscreen', { exact: true }).count(), 0, 'Native HTML expansion belongs to the host toolbar, not a CSS overlay');
  await page.getByTitle('Zoom in', { exact: true }).click();
  await page.getByTitle('Reset zoom (100%)', { exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 1);
  await page.screenshot({ path: '/private/tmp/mc-native-html-controls.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: native Markdown, table, list, light theme, source toggle and empty state');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
