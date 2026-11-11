// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright, or install it locally.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const markdown = '# Heading\n\n**Bold** and [link](https://example.com)\n\n```js\nconst value = 42;\n```';
const plain = 'Heading\n\nBold and link\n\nconst value = 42;';
const userText = '  file_name_with_underscores <value> **literal**\n';
const bundle = await build({
  stdin: {
    contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import i18next from 'i18next';
      import { initReactI18next } from 'react-i18next';
      import MessageCopyControl from './src/components/chat/view/subcomponents/MessageCopyControl';
      await i18next.use(initReactI18next).init({lng:'en', resources:{en:{chat:{copyMessage:{copy:'Copy',copied:'Copied'}}}}, defaultNS:'chat'});
      createRoot(document.getElementById('root')).render(<>
        <section id="assistant"><MessageCopyControl messageType="assistant" content={${JSON.stringify(markdown)}} /></section>
        <section id="user"><MessageCopyControl messageType="user" content={${JSON.stringify(userText)}} /></section>
      </>);`,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true, write: false, format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const server = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle.outputFiles[0].text);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      isMobile: mobile, hasTouch: mobile, permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const assistant = page.locator('#assistant');
    const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await assistant.getByRole('button', { name: 'Copy', exact: true }).click();
    assert.equal(await readClipboard(), markdown, 'Main button copies raw Markdown');
    await assistant.getByRole('button', { name: 'Select copy format' }).click();
    await page.getByRole('button', { name: 'Copy as text', exact: true }).click();
    assert.equal(await readClipboard(), plain, 'Copy as text must write immediately');
    await page.waitForFunction(() => !document.querySelector('#assistant button[aria-label="Copied"]'));
    await assistant.getByRole('button', { name: 'Copy', exact: true }).click();
    assert.equal(await readClipboard(), plain, 'Main button remembers selected format');
    await assistant.getByRole('button', { name: 'Select copy format' }).click();
    await page.getByRole('button', { name: 'Copy as markdown', exact: true }).click();
    assert.equal(await readClipboard(), markdown, 'Copy as Markdown must write immediately');
    await page.locator('#user').getByRole('button', { name: 'Copy', exact: true }).click();
    assert.equal(await readClipboard(), userText, 'User text must be preserved literally');

    // Exercise the real legacy clipboard path when the modern API is unavailable.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.waitForFunction(() => !document.querySelector('#assistant button[aria-label="Copied"]'));
    await assistant.getByRole('button', { name: 'Copy', exact: true }).click();
    await assistant.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    await page.evaluate(() => delete navigator.clipboard);
    assert.equal(await readClipboard(), markdown, 'Legacy fallback copies to the real clipboard');

    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('Denied')) },
    }));
    await assistant.getByRole('button', { name: 'Select copy format' }).click();
    await page.getByRole('button', { name: 'Copy as text', exact: true }).click();
    await page.evaluate(() => delete navigator.clipboard);
    assert.equal(await readClipboard(), plain, 'Rejected modern API falls back to legacy copy');

    // Neither failed clipboard path may report success.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Denied')) } });
      window.failedCopyAttempts = 0;
      document.execCommand = () => { window.failedCopyAttempts++; return false; };
    });
    await page.waitForFunction(() => !document.querySelector('#assistant button[aria-label="Copied"]'));
    await assistant.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.waitForFunction(() => window.failedCopyAttempts === 1);
    assert.equal(await assistant.getByRole('button', { name: 'Copied', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS: ${mobile ? 'mobile' : 'desktop'} message copy, both formats, literal user text, fallback and denied clipboard`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
