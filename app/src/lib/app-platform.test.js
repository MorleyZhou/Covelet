import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { APP_IDS } from './app-catalog.js';
import { createLocalData, localData } from './local-data.js';
import { APP_KEY_PREFIX, updateAppData, loadAppData, validateAppDomainData } from './app-data.js';
import { appBackupDomain } from './app-backup.js';
import { createFullDataSync } from './full-data-sync.js';
import { TASK_DEFAULTS, SNIPPET_DEFAULTS, LANGUAGE_DEFAULTS, TRAVEL_DEFAULTS, MEAL_DEFAULTS } from './daily-apps.js';
import { MARKET_DEFAULTS } from './market-apps.js';
import { createRecoveryCenter } from './recovery-center.js';
import { createEmptyState } from './model.js';
import { validatePersonalTools } from './personal-tools.js';
import { validateContentPreferences } from './content-preferences.js';
import { validateSavedDesktopTemplates } from './desktop-templates.js';

const copy = (value) => structuredClone(value);
let sequence = 0;
function backend() {
  const records = new Map(); let key;
  return {
    records, failCommit: false,
    getKey: async () => key,
    ensureKey: async (candidate) => key ||= candidate,
    get: async (id) => copy(records.get(id)),
    entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map(copy),
    put: async (values) => { for (const value of values) records.set(value.id, copy(value)); },
    remove: async (ids) => { for (const id of ids) records.delete(id); },
    async commit(values, ids) {
      if (this.failCommit) throw Error('Synthetic quota failure');
      const next = new Map(records);
      for (const id of ids) next.delete(id);
      for (const value of values) next.set(value.id, copy(value));
      records.clear(); for (const [id, value] of next) records.set(id, value);
    },
  };
}
function device(options = {}) {
  const memory = options.backend || backend();
  return { ...createLocalData({ backend: memory, databaseName: `apps-platform-${++sequence}`, crypto: webcrypto, locks: null, legacyLocal: null, localStorage: null, broadcastChannel: null, ...options }), backend: memory };
}
function bind(t, subject) {
  for (const name of ['get', 'set', 'remove', 'update', 'updateMany']) t.mock.method(localData, name, subject.localData[name]);
  t.after(() => subject.close());
}
function defaults() {
  const result = {
    tasks: copy(TASK_DEFAULTS), snippets: copy(SNIPPET_DEFAULTS), language: copy(LANGUAGE_DEFAULTS), travel: copy(TRAVEL_DEFAULTS), meals: copy(MEAL_DEFAULTS),
    ...copy(MARKET_DEFAULTS),
    'online-tools': { text: '', right: '', mode: 'json', path: '$', expression: '', flags: 'g', replacement: '', history: [] },
    images: { outputs: [], settings: { width: '', height: '', quality: '0.85', format: 'image/webp', crop: false, watermark: '' } },
    pdf: { outputs: [] }, media: { outputs: [] }, canvas: { boards: [] },
    subscriptions: { sources: [], items: [], baselines: {} },
    'ai-chat': { sessions: [], config: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: '', models: [], systemPrompt: '', temperature: .7, key: 'PRIVATE-AI-KEY-SENTINEL' } },
  };
  result.stocks.settings.apiKey = 'PRIVATE-STOCK-KEY-SENTINEL';
  result.sports.settings.apiKey = 'PRIVATE-SPORTS-KEY-SENTINEL';
  result.orders.tracking.apiKey = 'PRIVATE-TRACKING-KEY-SENTINEL';
  result.pdf.outputs.push({ id: 'pdf-one', name: 'PRIVATE-RECEIPT-SENTINEL.pdf', blob: new Blob([new Uint8Array([37, 80, 68, 70, 0, 255, 128, 13, 10])], { type: 'application/pdf' }), pages: 1, createdAt: 100 });
  return result;
}
const records = () => Object.fromEntries(Object.entries(defaults()).map(([id, data]) => [APP_KEY_PREFIX + id, { version: 1, revision: 1, data }]));

test('local model connection settings remain encrypted and do not cross the portable snapshot boundary', async (t) => {
  const source = device(), target = device(); t.after(() => Promise.all([source.close(), target.close()]));
  const before = await source.syncDataStore.snapshot();
  await source.localData.set({ 'covelet.ai.connection.v1': { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'device-a', key: 'PRIVATE-MODEL-KEY' } });
  assert.equal((await source.syncDataStore.snapshot()).token, before.token);
  assert.doesNotMatch(Buffer.from([...source.backend.records.values()][0].ciphertext).toString('utf8'), /PRIVATE-MODEL|localhost/);
  await source.localData.set(records());
  const portable = await source.syncDataStore.snapshot();
  assert.equal(portable.records.some((row) => row.key === 'covelet.ai.connection.v1'), false);
  await target.localData.set({ 'covelet.ai.connection.v1': { model: 'device-b' } });
  await target.syncDataStore.apply(portable, { expectedToken: (await target.syncDataStore.snapshot()).token });
  assert.equal((await target.localData.get('covelet.ai.connection.v1'))['covelet.ai.connection.v1'].model, 'device-b');
});

test('all 17 app documents and binary outputs survive encrypted cross-device snapshot transfer', async (t) => {
  const source = device(), destination = device(); t.after(() => Promise.all([source.close(), destination.close()]));
  const initial = records(); assert.equal(Object.keys(initial).length, 17);
  for (const [key, envelope] of Object.entries(initial)) await validateAppDomainData(key.slice(APP_KEY_PREFIX.length), envelope.data);
  await source.localData.set(initial);
  for (const row of source.backend.records.values()) {
    assert.equal(row.iv.byteLength, 12);
    assert.doesNotMatch(Buffer.from(row.ciphertext).toString('utf8'), /PRIVATE-|covelet\.app/);
    assert.deepEqual(Object.keys(row).sort(), ['ciphertext', 'id', 'iv', 'space', 'version']);
  }
  const portable = await source.syncDataStore.snapshot();
  assert.equal(portable.records.length, APP_IDS.length);
  const before = await destination.syncDataStore.snapshot();
  const applied = await destination.syncDataStore.apply(portable, { expectedToken: before.token });
  assert.equal(applied.changed, 17);
  assert.equal(applied.token, portable.token);
  const restored = (await destination.localData.get(APP_KEY_PREFIX + 'pdf'))[APP_KEY_PREFIX + 'pdf'].data.outputs[0];
  assert.equal(restored.blob.type, 'application/pdf');
  assert.deepEqual([...new Uint8Array(await restored.blob.arrayBuffer())], [37, 80, 68, 70, 0, 255, 128, 13, 10]);
  assert.equal((await destination.localData.get(APP_KEY_PREFIX + 'stocks'))[APP_KEY_PREFIX + 'stocks'].data.settings.apiKey, 'PRIVATE-STOCK-KEY-SENTINEL');
  assert.equal((await destination.syncDataStore.apply(portable, { expectedToken: applied.token })).changed, 0);
});

test('concurrent local updates serialize across clients and failed transforms preserve stored values', async (t) => {
  const memory = backend(), name = `concurrent-apps-${++sequence}`, first = device({ backend: memory, databaseName: name }), second = device({ backend: memory, databaseName: name });
  t.after(() => Promise.all([first.close(), second.close()]));
  await first.localData.set({ counter: { value: 0 } });
  await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? first : second).localData.update('counter', async (current) => {
    await Promise.resolve(); return { value: current.value + 1 };
  })));
  assert.equal((await first.localData.get('counter')).counter.value, 30);
  await assert.rejects(first.localData.update('counter', (current) => { current.value = -1; throw Error('Synthetic transform failure'); }));
  assert.equal((await first.localData.get('counter')).counter.value, 30);
});

test('atomic multi-app restore validates writes before commit and preserves deletions on storage failure', async (t) => {
  const subject = device(); t.after(() => subject.close());
  await subject.localData.set({ a: { keep: 1 }, b: { keep: 2 } });
  const before = await subject.syncDataStore.snapshot();
  subject.backend.failCommit = true;
  await assert.rejects(subject.localData.updateMany(['a', 'b'], () => ({ writes: { a: { keep: 99 } }, removals: ['b'] })), /quota/);
  assert.equal((await subject.syncDataStore.snapshot()).token, before.token);
  subject.backend.failCommit = false;
  await assert.rejects(subject.localData.updateMany(['a', 'b'], () => ({ writes: { a: { unsupported: undefined } }, removals: ['b'] })));
  assert.equal((await subject.syncDataStore.snapshot()).token, before.token);
  await assert.rejects(subject.localData.updateMany(['a', 'b'], () => ({ writes: { outside: 1 }, removals: [] })));
  await subject.localData.updateMany(['a', 'b'], (current) => ({ writes: { a: { keep: current.a.keep + 1 } }, removals: ['b'] }));
  assert.deepEqual(await subject.localData.get(['a', 'b']), { a: { keep: 2 } });
});

test('app CAS refuses stale drafts and domain errors without publishing partial changes', async (t) => {
  const subject = device(); bind(t, subject);
  const id = 'currency', base = copy(MARKET_DEFAULTS.currency);
  const first = await updateAppData(id, base, (current) => ({ ...current, amount: '2' }));
  const second = await updateAppData(id, base, (current) => ({ ...current, amount: '3' }), { expectedRevision: first.revision });
  assert.equal(second.revision, 2);
  await assert.rejects(updateAppData(id, base, (current) => ({ ...current, amount: '100' }), { expectedRevision: first.revision }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(updateAppData(id, base, (current) => ({ ...current, favorites: ['not-a-currency'] })));
  assert.equal((await loadAppData(id, base)).data.amount, '3');
});

test('ordinary app saves cannot replace a stored domain document that failed to load', async (t) => {
  const subject = device(); bind(t, subject);
  const original = { version: 1, revision: 8, data: { ...copy(MARKET_DEFAULTS.currency), favorites: 'corrupt-but-preserved' } };
  await subject.localData.set({ [APP_KEY_PREFIX + 'currency']: original });
  await assert.rejects(loadAppData('currency', MARKET_DEFAULTS.currency));
  await assert.rejects(updateAppData('currency', MARKET_DEFAULTS.currency, () => copy(MARKET_DEFAULTS.currency)));
  assert.deepEqual((await subject.localData.get(APP_KEY_PREFIX + 'currency'))[APP_KEY_PREFIX + 'currency'], original);
});

test('plain app backups redact provider keys and restore exact Blob bytes while retaining device credentials', async (t) => {
  const subject = device(); bind(t, subject);
  await subject.localData.set(records());
  const before = await appBackupDomain.read(), encoded = await appBackupDomain.encode(before.records), serialized = JSON.stringify(encoded);
  assert.doesNotMatch(serialized, /PRIVATE-(AI|STOCK|SPORTS|TRACKING)-KEY-SENTINEL/);
  const decoded = appBackupDomain.decode(JSON.parse(serialized));
  assert.equal(decoded.stocks.data.settings.apiKey, '');
  assert.equal(decoded['ai-chat'].data.config.key, '');
  assert.deepEqual([...new Uint8Array(await decoded.pdf.data.outputs[0].blob.arrayBuffer())], [37, 80, 68, 70, 0, 255, 128, 13, 10]);
  decoded.stocks.data.settings.colors = 'green-up';
  decoded.stocks.data.settings.apiKey = 'UNTRUSTED-BACKUP-KEY';
  const restored = await appBackupDomain.write(decoded, { expectedRevision: before.revision });
  assert.equal(restored.records.stocks.data.settings.colors, 'green-up');
  assert.equal(restored.records.stocks.data.settings.apiKey, 'PRIVATE-STOCK-KEY-SENTINEL');
  assert.equal(restored.records['ai-chat'].data.config.key, 'PRIVATE-AI-KEY-SENTINEL');
});

test('backup CAS also rejects a deleted-and-recreated document with a reused numeric revision', async (t) => {
  const subject = device(); bind(t, subject);
  await subject.localData.set({ [APP_KEY_PREFIX + 'currency']: { version: 1, revision: 1, data: copy(MARKET_DEFAULTS.currency) } });
  const preview = await appBackupDomain.read();
  await subject.localData.remove(APP_KEY_PREFIX + 'currency');
  await subject.localData.set({ [APP_KEY_PREFIX + 'currency']: { version: 1, revision: 1, data: { ...copy(MARKET_DEFAULTS.currency), amount: 'NEWER-CONTENT' } } });
  await assert.rejects(appBackupDomain.write(preview.records, { expectedRevision: preview.revision }), { code: 'REVISION_CONFLICT' });
  assert.equal((await subject.localData.get(APP_KEY_PREFIX + 'currency'))[APP_KEY_PREFIX + 'currency'].data.amount, 'NEWER-CONTENT');
});

test('bad data in any app stops the entire synchronized snapshot before existing apps are removed', async (t) => {
  const subject = device(); t.after(() => subject.close()); await subject.localData.set(records());
  const before = await subject.syncDataStore.snapshot(), incoming = copy(before);
  incoming.records.find((row) => row.key === APP_KEY_PREFIX + 'currency').value.data.favorites = ['NOTVALID'];
  incoming.records = incoming.records.filter((row) => row.key !== APP_KEY_PREFIX + 'pdf');
  await assert.rejects(subject.syncDataStore.apply(incoming, { expectedToken: before.token }));
  assert.equal((await subject.syncDataStore.snapshot()).token, before.token);
});

function stateStore() { let value; return { read: async () => copy(value), write: async (next) => { value = copy(next); } }; }
function pendingStore() { const values = new Map(); return { get: async (key) => copy(values.get(key)), set: async (key, value) => values.set(key, copy(value)), remove: async (key) => values.delete(key), entries: async () => copy([...values]) }; }
function remoteObjects() {
  const indexes = new Map(), chunks = new Map();
  const adapter = (values) => ({ list: async () => [...values].map(([name, bytes]) => ({ name, size: bytes.length })), read: async (name) => values.get(name)?.slice(), write: async (name, bytes) => values.set(name, bytes.slice()) });
  return { indexes, chunks, provider: adapter(indexes), assetProvider: adapter(chunks) };
}
test('all 17 app documents use encrypted remote chunks and can be downloaded by a second device', async (t) => {
  const source = device(), destination = device(), remote = remoteObjects();
  t.after(() => Promise.all([source.close(), destination.close()])); await source.localData.set(records());
  const make = (subject, actor) => createFullDataSync({ snapshotStore: subject.syncDataStore, store: stateStore(), pendingStore: pendingStore(), locks: null, eventDocument: null, eventWindow: null, uuid: () => actor.repeat(32),
    access: async () => ({ target: 'f'.repeat(64), password: 'synthetic-app-platform-password', autoSync: false, provider: remote.provider, assetProvider: remote.assetProvider, check: async () => {} }) });
  const sender = make(source, 'a'), receiver = make(destination, 'b');
  const sent = await sender.syncFullDataNow(); assert.equal(sent.phase, 'saved', `${sent.code}: ${sent.message}`);
  assert.ok(remote.indexes.size > 0 && remote.chunks.size > 0);
  for (const bytes of [...remote.indexes.values(), ...remote.chunks.values()]) assert.doesNotMatch(Buffer.from(bytes).toString('utf8'), /PRIVATE-|covelet\.app\.v1|RECEIPT-SENTINEL/);
  const received = await receiver.syncFullDataNow(); assert.equal(received.phase, 'saved', `${received.code}: ${received.message}`);
  const restored = await destination.localData.get(APP_IDS.map((id) => APP_KEY_PREFIX + id)); assert.equal(Object.keys(restored).length, 17);
  assert.equal(restored[APP_KEY_PREFIX + 'stocks'].data.settings.apiKey, 'PRIVATE-STOCK-KEY-SENTINEL');
  assert.deepEqual([...new Uint8Array(await restored[APP_KEY_PREFIX + 'pdf'].data.outputs[0].blob.arrayBuffer())], [37, 80, 68, 70, 0, 255, 128, 13, 10]);
});

function recoveryHarness() {
  let state = createEmptyState(), checkpoint = null, failComplete = false;
  const nav = {
    loadState: async () => copy(state), exportBackup: async () => new Blob([JSON.stringify(state)]),
    inspectBackup: async (file) => ({ state: JSON.parse(await file.text()), assets: new Map(), icons: new Map() }),
    validateBackupPlan: async (value) => value,
    restoreBackup: async (plan, expectedRevision) => { if (state.revision !== expectedRevision) throw Object.assign(Error('navigation CAS'), { code: 'REVISION_CONFLICT' }); state = { ...copy(plan.state), revision: state.revision + 1 }; return copy(state); },
  };
  const domain = (validate) => {
    let value = validate(null);
    return { validate, read: async () => copy(value), write: async (next, { expectedRevision }) => { if (value.revision !== expectedRevision) throw Object.assign(Error('domain CAS'), { code: 'REVISION_CONFLICT' }); value = validate({ ...copy(next), revision: value.revision + 1 }); return copy(value); } };
  };
  const points = { read: async () => copy(checkpoint), write: async (value) => { if (failComplete && value.status === 'complete') { failComplete = false; throw Error('Synthetic complete-marker failure'); } checkpoint = copy(value); } };
  const center = createRecoveryCenter({ nav, tools: domain(validatePersonalTools), preferences: domain(validateContentPreferences), templates: domain(validateSavedDesktopTemplates), apps: appBackupDomain, points, locks: { request: (_key, action) => action() } });
  return { center, failCompletion: () => { failComplete = true; } };
}

test('complete backup v2 previews app counts, restores Blob documents and keeps a usable pre-restore point', async (t) => {
  const subject = device(); bind(t, subject); await subject.localData.set(records());
  const { center } = recoveryHarness(), file = await center.exportCompleteBackup(), json = JSON.parse(await file.text());
  assert.equal(json.version, 2); assert.doesNotMatch(JSON.stringify(json.apps), /PRIVATE-STOCK-KEY/);
  await updateAppData('currency', MARKET_DEFAULTS.currency, (current) => ({ ...current, amount: '23' }));
  const plan = await center.preview(file); assert.equal(plan.summary.apps, 17); assert.ok(plan.categories.includes('apps'));
  await center.restore(plan, { selected: ['apps'] });
  assert.equal((await loadAppData('currency', MARKET_DEFAULTS.currency)).data.amount, '1');
  const previous = await center.previewRecoveryPoint(); assert.equal(previous.apps.currency.data.amount, '23');
  assert.deepEqual([...new Uint8Array(await (await loadAppData('pdf', { outputs: [] })).data.outputs[0].blob.arrayBuffer())], [37, 80, 68, 70, 0, 255, 128, 13, 10]);
});

test('a completion-marker failure rolls back the complete app domain without resetting revisions', async (t) => {
  const subject = device(); bind(t, subject); await subject.localData.set(records());
  const { center, failCompletion } = recoveryHarness(), file = await center.exportCompleteBackup();
  await updateAppData('currency', MARKET_DEFAULTS.currency, (current) => ({ ...current, amount: '9' }));
  const before = await loadAppData('currency', MARKET_DEFAULTS.currency), plan = await center.preview(file); failCompletion();
  await assert.rejects(center.restore(plan, { selected: ['apps'] }), /恢复失败|Restore failed/i);
  const after = await loadAppData('currency', MARKET_DEFAULTS.currency); assert.equal(after.data.amount, '9'); assert.ok(after.revision > before.revision);
  assert.equal((await center.getRecoveryPoint()).status, 'rolled-back');
});

test('invalid domain contents in backup v2 are rejected during preview', async (t) => {
  const subject = device(); bind(t, subject); await subject.localData.set(records());
  const { center } = recoveryHarness(), raw = JSON.parse(await (await center.exportCompleteBackup()).text());
  const incoming = await appBackupDomain.decode(raw.apps); incoming.currency.data.favorites = ['NOTVALID'];
  raw.apps = await appBackupDomain.encode(incoming);
  await assert.rejects(center.preview(new Blob([JSON.stringify(raw)], { type: 'application/json' })));
});

test('append backup adds missing records inside an existing app while retaining same-ID local edits', async (t) => {
  const subject = device(); bind(t, subject); const initial = records();
  const account = { id: 'account-shared', name: 'Main', currency: 'CNY', opening: 0 };
  const transaction = (id, amount, note) => ({ id, accountId: account.id, currency: 'CNY', kind: 'expense', category: 'Food', amount, note, date: '2026-10-30' });
  initial[APP_KEY_PREFIX + 'ledger'].data = { accounts: [account], transactions: [transaction('shared', 100, 'backup old'), transaction('incoming-only', 200, 'incoming')], budgets: [], bills: [] };
  await subject.localData.set(initial);
  const { center } = recoveryHarness(), file = await center.exportCompleteBackup();
  await updateAppData('ledger', MARKET_DEFAULTS.ledger, (current) => ({ ...current, accounts: [{ ...account, name: 'Keep local name' }], transactions: [transaction('shared', 999, 'keep local edit'), transaction('local-only', 300, 'keep local record')] }));
  const plan = await center.preview(file); await center.restore(plan, { selected: ['apps'], mode: 'append' });
  const restored = (await loadAppData('ledger', MARKET_DEFAULTS.ledger)).data;
  assert.equal(restored.accounts[0].name, 'Keep local name');
  assert.equal(restored.transactions.length, 3);
  assert.equal(restored.transactions.find((row) => row.id === 'shared').amount, 999);
  assert.equal(restored.transactions.find((row) => row.id === 'incoming-only').amount, 200);
  assert.equal(restored.transactions.find((row) => row.id === 'local-only').amount, 300);
});
