import assert from 'node:assert/strict';
import test from 'node:test';

import { trackAppViewport } from './appViewport';

function setup(height = 800, offsetTop = 0) {
  const viewport = Object.assign(new EventTarget(), { height, offsetTop, scale: 1 });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const target = Object.assign(new EventTarget(), {
    innerHeight: 800,
    visualViewport: viewport,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  const values = new Map<string, string>();
  const style = {
    setProperty: (key: string, value: string) => { values.set(key, value); },
    removeProperty: (key: string) => { values.delete(key); },
  };
  const cleanup = trackAppViewport(target as unknown as Window, style as unknown as CSSStyleDeclaration);
  return {
    viewport, target, values, frames, cleanup,
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
    bounds() {
      const top = Number.parseFloat(values.get('--app-viewport-top')!);
      const height = Number.parseFloat(values.get('--app-viewport-height')!);
      return { top, bottom: top + height, height };
    },
  };
}

test('keeps the full visible area after Safari pans to the caret following keyboard resize', () => {
  const app = setup();
  app.viewport.height = 360;
  app.viewport.dispatchEvent(new Event('resize'));
  app.flush();
  assert.deepEqual(app.bounds(), { top: 0, bottom: 360, height: 360 });

  app.viewport.offsetTop = 220;
  app.viewport.dispatchEvent(new Event('scroll'));
  app.flush();
  assert.deepEqual(app.bounds(), { top: 220, bottom: 580, height: 360 });
  assert.equal(app.values.get('--app-viewport-height'), '360px');

  app.viewport.height = 800;
  app.viewport.offsetTop = 0;
  app.viewport.dispatchEvent(new Event('resize'));
  app.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(app.frames.size, 1);
  app.flush();
  assert.deepEqual(app.bounds(), { top: 0, bottom: 800, height: 800 });
  app.cleanup?.();
});

test('initializes with an already open keyboard and cancels pending updates on unmount', () => {
  const app = setup(360, 100);
  assert.deepEqual(app.bounds(), { top: 100, bottom: 460, height: 360 });
  app.viewport.dispatchEvent(new Event('resize'));
  app.cleanup?.();
  app.viewport.dispatchEvent(new Event('scroll'));
  app.target.dispatchEvent(new Event('pageshow'));
  assert.equal(app.frames.size, 0);
  assert.equal(app.values.size, 0);
});

test('does not subtract a keyboard twice when the layout viewport itself shrinks', () => {
  const app = setup();
  app.target.innerHeight = 360;
  app.viewport.height = 360;
  app.target.dispatchEvent(new Event('resize'));
  app.flush();
  assert.deepEqual(app.bounds(), { top: 0, bottom: 360, height: 360 });
  app.cleanup?.();
});

test('visible bounds do not depend on a stale layout viewport height', () => {
  const app = setup(360, 100);
  app.target.innerHeight = 1200;
  app.viewport.dispatchEvent(new Event('resize'));
  app.flush();
  assert.deepEqual(app.bounds(), { top: 100, bottom: 460, height: 360 });
  app.target.innerHeight = 360;
  app.viewport.dispatchEvent(new Event('scroll'));
  app.flush();
  assert.deepEqual(app.bounds(), { top: 100, bottom: 460, height: 360 });
  app.cleanup?.();
});

test('preserves layout during pinch zoom and resyncs on restored page visibility', () => {
  const app = setup();
  app.viewport.scale = 2;
  app.viewport.height = 400;
  app.viewport.offsetTop = 100;
  app.viewport.dispatchEvent(new Event('resize'));
  app.flush();
  assert.deepEqual(app.bounds(), { top: 0, bottom: 800, height: 800 });
  app.viewport.scale = 1;
  app.viewport.height = 360;
  app.target.dispatchEvent(new Event('pageshow'));
  app.flush();
  assert.deepEqual(app.bounds(), { top: 100, bottom: 460, height: 360 });
  app.cleanup?.();
});
