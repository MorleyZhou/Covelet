import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { observeCachedIconSources } from './navigation-icon-selection.js';
import { navigationIconDisplaySources } from './site-icons.js';

const base = 'https://icons.example/base.png', light = 'https://icons.example/light.png', dark = 'https://icons.example/dark.png';
const site = { id: 'site', type: 'site', url: 'https://site.example/', icon: { kind: 'url', value: base }, iconUrl: base,
  iconVariants: { light: { url: light, fit: 'cover' }, dark: { url: dark, fit: 'contain' } } };
const image = (url, version = 1) => ({ url, version, blob: new Blob([String(version)], { type: 'image/png' }) });
function harness({ records = [], warm = [], read } = {}) {
  const stored = new Map(records.map((item) => [item.url, item])), prepared = new Map(warm.map((item) => [item.url, item]));
  const listeners = new Set(), reads = [], ready = [], missing = [];
  const io = {
    peek: (url) => prepared.get(url),
    read: async (url) => { reads.push(url); return read ? read(url) : stored.get(url); },
    subscribe: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
    onReady: (source, item) => ready.push({ source, item }), onMissing: () => missing.push(true),
  };
  return { io, reads, ready, missing, listeners, publish(item) { for (const listener of listeners) listener(item); } };
}
const settled = () => setImmediate();

test('display sources keep selected theme separate from a valid base fallback and ignore themes when enhancements are off', () => {
  assert.deepEqual(navigationIconDisplaySources(site, 'dark'), { primary: dark, fallback: base, localAssetId: '', explicitFallback: '' });
  assert.equal(navigationIconDisplaySources(site, 'light').primary, light);
  assert.deepEqual(navigationIconDisplaySources(site, 'dark', false), { primary: base, fallback: '', localAssetId: '', explicitFallback: '' });
  assert.equal(navigationIconDisplaySources({ ...site, iconVariants: { light: { url: base }, dark: { url: base } } }, 'dark').fallback, '');
});

test('uploaded/native assets expose only explicitly configured URL fallbacks and never a guessed site favicon', () => {
  const asset = { ...site, icon: { kind: 'image', value: 'asset-id' } };
  assert.deepEqual(navigationIconDisplaySources(asset), { primary: '', fallback: '', localAssetId: 'asset-id', explicitFallback: base });
  assert.equal(navigationIconDisplaySources({ ...asset, iconUrl: undefined }).explicitFallback, '');
  assert.equal(navigationIconDisplaySources({ ...asset, iconUrl: 'file:///private/image.png' }).explicitFallback, '');
  assert.equal(navigationIconDisplaySources({ type: 'folder', iconUrl: base }).primary, '');
});

test('a valid selected theme is adopted synchronously without reading or leasing the alternate', () => {
  const selected = image(dark), alternate = image(base), h = harness({ warm: [selected, alternate] });
  const selection = observeCachedIconSources(dark, base, h.io);
  assert.deepEqual(h.reads, []); assert.equal(h.ready.length, 1); assert.equal(h.ready[0].item, selected);
  selection.stop(); assert.equal(h.listeners.size, 0);
});

test('a missing or corrupt selected theme uses its already saved base image and exposes the actual selected source', async () => {
  const alternate = image(base), h = harness({ records: [alternate] });
  const selection = observeCachedIconSources(dark, base, h.io);
  await settled();
  assert.deepEqual(h.reads, [dark, base]); assert.deepEqual(h.missing, []);
  assert.equal(h.ready[0].source, base); assert.equal(h.ready[0].item, alternate);
  h.publish(image(dark, 2));
  assert.equal(h.ready.at(-1).source, dark);
  h.publish(image(base, 3));
  assert.equal(h.ready.at(-1).source, dark, 'later fallback updates cannot hide a now-valid selected theme');
  selection.stop();
});

test('a selected theme notification supersedes an older alternate read still in progress', async () => {
  let complete;
  const h = harness({ read: (url) => url === dark ? null : new Promise((resolve) => { complete = resolve; }) });
  const selection = observeCachedIconSources(dark, base, h.io);
  await settled();
  const selected = image(dark, 2); h.publish(selected); complete(image(base)); await settled();
  assert.equal(h.ready.length, 1); assert.equal(h.ready[0].item, selected); assert.deepEqual(h.missing, []);
  selection.stop();
});

test('an alternate update cannot be overwritten by its stale in-flight cache read', async () => {
  let complete;
  const h = harness({ read: (url) => url === dark ? null : new Promise((resolve) => { complete = resolve; }) });
  const selection = observeCachedIconSources(dark, base, h.io); await settled();
  const latest = image(base, 3); h.publish(latest); complete(image(base, 1)); await settled();
  assert.equal(h.ready.at(-1).item, latest); assert.deepEqual(h.missing, []); selection.stop();
});

test('missing is published only after both local sources are unavailable and deferred work stops after disposal', async () => {
  const h = harness(), selection = observeCachedIconSources(dark, base, { ...h.io, defer: true });
  await settled(); assert.deepEqual(h.reads, []); selection.start(); await settled();
  assert.deepEqual(h.reads, [dark, base]); assert.equal(h.missing.length, 1); selection.stop();
  h.publish(image(dark)); assert.deepEqual(h.ready, []);
  let complete;
  const held = harness({ read: () => new Promise((resolve) => { complete = resolve; }) });
  const disposed = observeCachedIconSources(dark, base, held.io); await settled(); disposed.stop(); complete(image(dark)); await settled();
  assert.deepEqual(held.ready, []); assert.deepEqual(held.missing, []);
});
