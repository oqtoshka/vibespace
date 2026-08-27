import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Shimmer } from '../../../../shared/view/ui/Shimmer';
import ActivityIndicator from './ActivityIndicator';

// Regression guard for the idle-tab repaint loop: an infinite CSS animation
// (`animate-pulse`, `animate-shimmer`) that outlives the work it signals keeps
// the compositor presenting a frame every vsync — measured at ~1.4 CPU cores
// for a static tab on a 144 Hz display. Nothing may animate when idle.

test('Shimmer renders static text when inactive', () => {
  const html = renderToStaticMarkup(React.createElement(Shimmer, { active: false }, 'Thinking…'));
  assert.doesNotMatch(html, /animate-shimmer/);
  assert.doesNotMatch(html, /bg-clip-text/);
  assert.match(html, /Thinking…/);
});

test('Shimmer animates by default (while generating)', () => {
  const html = renderToStaticMarkup(React.createElement(Shimmer, null, 'Thinking…'));
  assert.match(html, /animate-shimmer/);
});

test('ActivityIndicator renders nothing — no animation — without live activity', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, { activity: null }));
  assert.equal(html, '');
});

test('ActivityIndicator animates only while a request is in flight', () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityIndicator, {
      activity: { statusText: null, canInterrupt: true, startedAt: 0 },
    }),
  );
  assert.match(html, /animate-pulse/);
  assert.match(html, /animate-shimmer/);
  assert.match(html, /chat-activity-enter/);
});
