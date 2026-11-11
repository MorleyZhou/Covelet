import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { useLocalDateKey } from './use-local-date.js';

test('the local day hook refreshes at midnight and after focus or visibility clock changes', async (t) => {
  const dom = new JSDOM('<div id="root"></div>'), previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 10, 11, 23, 59, 59, 900) });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.querySelector('#root'));
  function CurrentDay() { return React.createElement('span', null, useLocalDateKey()); }
  await act(async () => root.render(React.createElement(CurrentDay)));
  assert.equal(document.querySelector('span').textContent, '2026-11-11');
  await act(async () => t.mock.timers.tick(150));
  assert.equal(document.querySelector('span').textContent, '2026-11-12');
  t.mock.timers.setTime(new Date(2026, 10, 14, 12).getTime());
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(document.querySelector('span').textContent, '2026-11-14');
  t.mock.timers.setTime(new Date(2026, 10, 15, 12).getTime());
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  assert.equal(document.querySelector('span').textContent, '2026-11-15');
  await act(async () => root.unmount());
});
