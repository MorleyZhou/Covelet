import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGitHubProvider, parseContributionCalendar, validateContributionDays } from './github-contributions.js';
import { createGitHubWasm } from './github-wasm.js';
import { normalizeGitHubUsername, validateWidgetConfig, GITHUB_WIDGET_ID } from './widget-model.js';
import { createEmptyState, createDemoState, configureGitHubWidget, validateState, migrateNavigationState, moveEntry, combineEntries, deleteEntry, searchEntries } from './model.js';
import { createReplica, recordChanges, materializeState, portableState, packReplica, readReplicas, syncConflicts } from './sync.js';

const days = [
  { date: '2026-10-17', count: 0, level: 0 },
  { date: '2026-10-18', count: 1234, level: 4 },
  { date: '2026-10-19', count: 2, level: 1 },
  { date: '2026-10-20', count: 0, level: 0 },
];
const calendarDays = Array.from({ length: 367 }, (_, index) => ({ date: new Date(Date.UTC(2025, 9, 19) + index * 86400000).toISOString().slice(0, 10), count: 0, level: 0 }));
calendarDays.splice(-days.length, days.length, ...days);
function markup(values = calendarDays) {
  return values.map((day, index) => `<td id="day-${index}" data-date="${day.date}" data-level="${day.level}"></td><tool-tip for="day-${index}">${day.count ? day.count.toLocaleString('en-US') : 'No'} contributions on October 20th.</tool-tip>`).join('');
}
const response = (text = markup(), status = 200) => new Response(text, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
function memory() {
  let value = {};
  return { read: async () => structuredClone(value), write: async (next) => { value = structuredClone(next); } };
}

test('sync invalidation prevents an older GitHub flight from overwriting imported calendar data', async () => {
  const store = memory(), now = Date.now();
  let release, started, requests = 0;
  const ready = new Promise((resolve) => { started = resolve; });
  const provider = createGitHubProvider({ store, now: () => now, canRead: async () => true, isPreview: false,
    request: async () => { requests++; started(); return new Promise((resolve) => { release = resolve; }); } });
  const old = provider.load('torvalds');
  await ready;
  const imported = structuredClone(calendarDays); imported[0] = { ...imported[0], count: 42, level: 2 };
  await store.write({ torvalds: { days: imported, fetchedAt: now, attemptedAt: now } });
  provider.invalidate(); release(response());
  await assert.rejects(old, (reason) => reason.code === 'GITHUB_STALE');
  assert.deepEqual((await provider.load('torvalds')).days, imported);
  assert.deepEqual((await store.read()).torvalds.days, imported);
  assert.equal(requests, 1);
});

test('GitHub usernames cannot become paths, query strings or additional origins', () => {
  assert.equal(normalizeGitHubUsername(' @Torvalds '), 'torvalds');
  for (const name of ['', '../x', 'x?token=secret', 'a/b', 'https://github.com/a', '-x', 'x-', 'a--b', 'x'.repeat(40)]) assert.throws(() => normalizeGitHubUsername(name));
  assert.throws(() => validateWidgetConfig(GITHUB_WIDGET_ID, { username: 'abc', size: 'medium', token: 'secret' }));
  for (const size of ['small', 'medium', 'large']) {
    assert.deepEqual(validateWidgetConfig(GITHUB_WIDGET_ID, { username: '@Torvalds', size }), { username: 'torvalds', size });
  }
  for (const size of ['compact', '', null, 2]) assert.throws(() => validateWidgetConfig(GITHUB_WIDGET_ID, { username: 'abc', size }));
  assert.throws(() => validateWidgetConfig('remote-module', { username: 'abc', size: 'medium' }));
});

test('calendar text parser reads exact day counts and levels without interpreting remote markup', () => {
  assert.deepEqual(parseContributionCalendar(`<script>throw Error('never run')</script><img src="https://elsewhere.test/x">${markup()}`), calendarDays);
  assert.deepEqual(parseContributionCalendar(markup([...calendarDays].reverse())), calendarDays);
  assert.throws(() => parseContributionCalendar(markup().replace('data-level="4"', 'data-level="5"')));
  assert.throws(() => parseContributionCalendar(markup().replace('1,234 contributions', '<b>1,234</b> contributions')));
  assert.throws(() => parseContributionCalendar(markup([...calendarDays, calendarDays[0]])), /重复/);
  assert.throws(() => parseContributionCalendar(markup(days)), /完整/);
  assert.throws(() => validateContributionDays([days[0], days[2]]), /缺失/);
  assert.throws(() => validateContributionDays([{ date: '2026-02-30', count: 0, level: 0 }]), /日期/);
  assert.throws(() => parseContributionCalendar('x'.repeat(524289)), /大小限制/);
  assert.throws(() => parseContributionCalendar('<html>sign in</html>'), /完整/);
});

test('GitHub requests use only the selected public calendar, check access, and omit cookies/referrers', async () => {
  const calls = [];
  const store = memory();
  const provider = createGitHubProvider({ store, isPreview: false, canRead: async () => true, request: async (...args) => { calls.push(args); return response(); } });
  const result = await provider.load('@Torvalds');
  assert.deepEqual(result.days, calendarDays);
  const [url, options] = calls[0];
  assert.equal(url, 'https://github.com/users/torvalds/contributions');
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.headers['Accept-Language'], 'en-US');
  await provider.load('torvalds'); assert.equal(calls.length, 1, 'fresh cache avoids another request');
  assert(!JSON.stringify(await store.read()).includes('<td'), 'only numeric calendar data is cached');
  const denied = createGitHubProvider({ store: memory(), canRead: async () => false, request: async () => { throw Error('must not fetch'); } });
  await assert.rejects(denied.load('abc'), { code: 'GITHUB_PERMISSION' });
});

test('concurrent loads share a request and failures preserve validated cached data with a persisted retry delay', async () => {
  const store = memory(); let time = 1700000000000, calls = 0, fail = false;
  const provider = createGitHubProvider({ store, now: () => time, canRead: async () => true, request: async () => {
    calls++; if (fail) throw Error('transport URL contains a secret'); return response();
  } });
  await Promise.all([provider.load('abc'), provider.load('abc')]); assert.equal(calls, 1);
  time += 3600001; fail = true;
  const stale = await provider.load('abc');
  assert.equal(stale.stale, true); assert.deepEqual(stale.days, calendarDays); assert(!stale.error.includes('secret'));
  await provider.load('abc', { force: true }); assert.equal(calls, 2, 'retry delay survives cached errors');
  time += 60001; fail = false;
  assert.equal((await provider.load('abc', { force: true })).stale, false); assert.equal(calls, 3);
});

test('GitHub transport rejects redirects, excessive bodies, bad MIME and missing accounts without producing zero calendars', async () => {
  const cases = [
    () => response('not found', 404),
    () => new Response(markup(), { headers: { 'content-type': 'application/json' } }),
    () => response('x'.repeat(524289)),
    () => { const result = response(); Object.defineProperty(result, 'url', { value: 'https://elsewhere.test/' }); return result; },
    () => { const result = response(); Object.defineProperty(result, 'redirected', { value: true }); return result; },
  ];
  for (const make of cases) {
    const provider = createGitHubProvider({ store: memory(), canRead: async () => true, request: async () => make() });
    await assert.rejects(provider.load('abc'));
  }
  const provider = createGitHubProvider({ store: memory(), canRead: async () => true, timeout: 10, request: async () => new Promise(() => {}) });
  await assert.rejects(provider.load('abc'), /超时/);
});

test('actual packaged GitHub WASM aligns UTC weekdays and computes totals and streaks with fixed import-free memory', async () => {
  const binary = await readFile(new URL('../wasm/github-core.wasm', import.meta.url));
  const module = new WebAssembly.Module(binary);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const instance = new WebAssembly.Instance(module);
  assert.equal(instance.exports.memory.buffer.byteLength, 524288);
  assert.throws(() => instance.exports.memory.grow(1), RangeError);
  const core = await createGitHubWasm(binary);
  const result = core.analyze(days);
  assert.equal(result.total, 1236); assert.equal(result.activeDays, 2); assert.equal(result.longestStreak, 2); assert.equal(result.currentStreak, 0);
  assert.equal(result.cells[6].date, '2026-10-17', 'Saturday is row six');
  assert.equal(result.cells[7].date, '2026-10-18', 'Sunday starts another column');
  assert.throws(() => core.analyze([days[0], days[2]]));
  assert.throws(() => core.analyze([{ ...days[0], count: 1, level: 0 }]));
  assert.throws(() => core.analyze(Array(379).fill(days[0])));
  assert.deepEqual(core.analyze(days), result, 'failed calls do not leak stale buffers');
  await assert.rejects(createGitHubWasm('https://example.com/core.wasm'));
});

test('widget configuration persists as a desktop entry, reorders with sites and cannot enter or form folders', () => {
  const before = createDemoState();
  const state = configureGitHubWidget(before, { username: '@Torvalds', size: 'medium' });
  const widget = state.entries.find((entry) => entry.type === 'widget');
  assert.equal(widget.config.username, 'torvalds'); assert.equal(before.entries.some((entry) => entry.type === 'widget'), false);
  const moved = moveEntry(state, widget.id, { index: 0 });
  assert.equal(moved.entries.find((entry) => entry.id === widget.id).order, 0);
  assert.throws(() => moveEntry(state, widget.id, { parentId: 'folder-docs' }));
  assert.throws(() => combineEntries(state, 'site-github', widget.id, { folderId: 'bad-folder' }));
  assert.equal(searchEntries(state, 'GitHub').some((entry) => entry.type === 'widget'), false);
  assert.deepEqual(migrateNavigationState(state).entries, state.entries);
  const edited = configureGitHubWidget(moved, { username: 'github', size: 'large' }, widget.id);
  assert.equal(edited.entries.find((entry) => entry.id === widget.id).order, 0);
  const smaller = configureGitHubWidget(edited, { username: 'github', size: 'small' }, widget.id);
  assert.equal(smaller.entries.length, edited.entries.length);
  assert.deepEqual(smaller.entries.find((entry) => entry.id === widget.id), { ...edited.entries.find((entry) => entry.id === widget.id), config: { username: 'github', size: 'small' } });
  assert.equal(deleteEntry(smaller, widget.id).entries.some((entry) => entry.type === 'widget'), false);
  assert.throws(() => configureGitHubWidget(before, widget.config, widget.id), /移除/);
  const invalid = structuredClone(state); invalid.entries.find((entry) => entry.id === widget.id).config.code = 'bad';
  assert.throws(() => validateState(invalid));
});

test('widget layout and config round trip through native-sync packing, merge independently and preserve conflicts', async () => {
  const initial = createEmptyState();
  const state = configureGitHubWidget(initial, { username: 'torvalds', size: 'medium' });
  const a = recordChanges(createReplica('widget-a'), initial, state);
  const packed = await packReplica(a);
  const restored = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  const remote = materializeState(restored.documents);
  assert.deepEqual(portableState(remote), portableState(state));
  const id = state.entries[0].id;
  for (const size of ['small', 'large']) {
    const resized = configureGitHubWidget(state, { username: 'torvalds', size }, id);
    const replica = recordChanges(a, state, resized);
    const resizedPack = await packReplica(replica);
    const decoded = await readReplicas({ ...resizedPack.chunks, [resizedPack.key]: resizedPack.head });
    assert.deepEqual(portableState(materializeState(decoded.documents)), portableState(resized));
  }
  const b = recordChanges(createReplica('widget-b'), initial, state);
  const first = recordChanges(a, state, configureGitHubWidget(state, { username: 'github', size: 'medium' }, id));
  const second = recordChanges(b, state, configureGitHubWidget(state, { username: 'torvalds', size: 'large' }, id));
  assert.equal(syncConflicts({ a: first, b: second }).length, 1);
  assert.equal(materializeState({ a: first, b: second }).entries.length, 1);
});
