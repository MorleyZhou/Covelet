// Real R2 adapter verification. This does not launch a browser or prove UI acceptance.
// Credentials stay in the ignored local config; only synthetic encrypted data is uploaded.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { createCloudProvider, validateCloudConfig } from '../src/lib/cloud-providers.js';
import { createFullDataSync } from '../src/lib/full-data-sync.js';
import { createLocalData } from '../src/lib/local-data.js';
import { createEmptyState } from '../src/lib/model.js';
import { createSyncWasm } from '../src/lib/sync-wasm.js';

const configPath = fileURLToPath(new URL('../../output/playwright/covelet/live-config.local.json', import.meta.url));
const receiptPath = fileURLToPath(new URL('../../output/playwright/covelet/record-merge-r2.json', import.meta.url));
const TOOLS = 'covelet.tools.v1', NAV = 'owntab.local.v1', PREFS = 'covelet.content.preferences.v1';
const copy = (value) => structuredClone(value), encoder = new TextEncoder(), decoder = new TextDecoder();
const cleanCode = (error) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'VERIFICATION_FAILED';
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const placeholder = (value) => typeof value !== 'string' || !value.trim()
  || /(?:placeholder|replace[_ -]?me|your[_ -]|example|changeme|填写|待填|[<>]|\$\{|^x+$|^0+$)/i.test(value);
const progress = (stage) => process.stdout.write(`${JSON.stringify({ stage })}\n`);

async function loadConfig() {
  let parsed;
  try { parsed = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { fail('R2_CONFIG_REQUIRED'); }
  const config = parsed?.r2;
  if (!config || ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].some((key) => placeholder(config[key]))
    || config.sessionToken && placeholder(config.sessionToken)) fail('R2_CONFIG_REQUIRED');
  // Validate locally before constructing a provider or making any request.
  try { validateCloudConfig({ provider: 'r2', endpoint: config.endpoint, bucket: config.bucket, prefix: 'validation-only' }); }
  catch { fail('R2_CONFIG_INVALID'); }
  return config;
}

function memoryPersistence() {
  const records = new Map(); let deviceKey;
  const backend = {
    getKey: async () => deviceKey,
    ensureKey: async (candidate) => deviceKey ||= candidate,
    get: async (id) => copy(records.get(id)),
    entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map(copy),
    put: async (values) => { for (const value of values) records.set(value.id, copy(value)); },
    remove: async (ids) => { for (const id of ids) records.delete(id); },
    commit: async (values, ids) => {
      const next = new Map(records);
      for (const id of ids) next.delete(id);
      for (const value of values) next.set(value.id, copy(value));
      records.clear(); for (const [id, value] of next) records.set(id, value);
    },
    close: async () => { records.clear(); deviceKey = undefined; },
  };
  return createLocalData({ backend, databaseName: `r2-merge-${randomUUID()}`, crypto: webcrypto,
    legacyLocal: null, localStorage: null, broadcastChannel: null, locks: null });
}

async function makeDevice(persistence, remote, target, password, initial, language) {
  const { localData, syncDataStore } = persistence;
  for (const [key, value] of Object.entries(initial)) await localData.set({ [key]: value });
  await localData.set({ 'covelet.language.v1': language, 'covelet.privacy.lock.v1': { verifier: `synthetic-${language}-device-only` } });
  const api = createFullDataSync({ snapshotStore: syncDataStore, store: syncDataStore.syncMetadataStore, crypto: webcrypto,
    access: async () => ({ target, password, autoSync: false, ...remote, async check() {} }), currentTarget: () => target,
    pendingStore: persistence.createEncryptedStore('full-data-pending'),
    historyStore: { async read() { return (await localData.get('covelet.data-sync.runs.v1'))['covelet.data-sync.runs.v1'] || null; },
      async write(value) { await localData.set({ 'covelet.data-sync.runs.v1': value }); } },
    locks: null, eventWindow: null, eventDocument: null,
  });
  return { api, persistence,
    value: async (key) => (await localData.get(key))[key],
    async edit(key, update) { const value = (await localData.get(key))[key]; update(value); await localData.set({ [key]: value }); },
  };
}

async function sync(peer, expected = 'saved') {
  const status = await peer.api.syncFullDataNow();
  if (status.phase !== expected) fail(cleanCode(status));
}

const note = (id) => ({ id, title: id, body: id, pinned: false, revision: 1, createdAt: 1, updatedAt: 1 });
const site = (id, order = 0, parentId = null) => ({ id, type: 'site', name: id, url: `https://${id}.example/`, groupId: 'group-home', parentId,
  order, icon: { kind: 'letter', value: id } });
function initialData() {
  const navigation = createEmptyState(), folder = { ...site('folder', 1), type: 'folder' }; delete folder.url;
  navigation.entries = [site('shared-site'), folder, site('child', 0, 'folder')];
  return {
    [NAV]: { version: 1, state: navigation, snapshots: [] },
    [TOOLS]: { version: 3, revision: 0, notes: [note('shared-note'), note('different-fields')], reading: [], snapshots: [], trash: [] },
    [PREFS]: { version: 1, revision: 0, aliases: {}, privateKeys: [], library: { version: 1,
      tags: [{ id: 'stable-tag', name: 'Original tag' }], items: { 'note:shared-note': { description: 'Original description', tagIds: ['stable-tag'] } } } },
  };
}

async function run(config, receipt) {
  const started = Date.now(), deadline = started + 240_000;
  const signer = await createSyncWasm(await readFile(new URL('../src/wasm/sync-core.wasm', import.meta.url)));
  const prefix = `covelet-record-merge-qa/${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}`;
  const profile = validateCloudConfig({ provider: 'r2', endpoint: config.endpoint, bucket: config.bucket, prefix });
  const target = await signer.sha256(encoder.encode(JSON.stringify(profile)));
  const password = randomBytes(32).toString('base64url');
  const counters = { requests: 0, gets: 0, puts: 0, uploadedBytes: 0, statusCodes: {} };
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken && { sessionToken: config.sessionToken }) };
  const expectedPath = `/${encodeURIComponent(profile.bucket)}/${prefix}/`;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET';
    if (Date.now() >= deadline || ++counters.requests > 800) fail('R2_VERIFICATION_LIMIT');
    const listing = url.pathname === `/${encodeURIComponent(profile.bucket)}` && method === 'GET'
      && url.searchParams.get('list-type') === '2' && url.searchParams.get('prefix')?.startsWith(`${prefix}/`);
    if (url.origin !== profile.endpoint || !['GET', 'PUT'].includes(method) || !listing && !url.pathname.startsWith(expectedPath)) fail('R2_NAMESPACE_GUARD');
    if (method === 'PUT') {
      const bytes = init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body || []);
      counters.puts++; counters.uploadedBytes += bytes.length;
      if (counters.uploadedBytes > 8 * 1024 * 1024) fail('R2_VERIFICATION_LIMIT');
      const body = decoder.decode(bytes);
      if (['A shared body', 'B shared body', 'only-a', 'only-b', password, ...Object.values(credentials)].some((value) => value && body.includes(value))) fail('R2_PLAINTEXT_GUARD');
    } else counters.gets++;
    const response = await fetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
    counters.statusCodes[response.status] = (counters.statusCodes[response.status] || 0) + 1;
    return response;
  };
  const at = (path) => createCloudProvider({ ...profile, prefix: `${prefix}/${path}` }, credentials, { signer, fetcher, timeoutMs: 15000 });
  const remote = { provider: at('all-data-v1'), assetProvider: at('all-data-v1/blobs') };
  receipt.namespace = prefix; receipt.targetFingerprint = target; receipt.network = counters;
  const local = [memoryPersistence(), memoryPersistence()];
  try {
    const a = await makeDevice(local[0], remote, target, password, initialData(), 'zh-CN');
    const b = await makeDevice(local[1], remote, target, password, {}, 'en');
    progress(receipt.stage = 'establishing-shared-baseline');
    assert.deepEqual(await remote.provider.list(), [], 'A new generated namespace must start empty.');
    await sync(a); await sync(b); await sync(a);
    progress(receipt.stage = 'making-independent-offline-edits');
    await a.edit(TOOLS, (value) => { value.notes[0].title = 'A shared title'; value.notes[0].body = 'A shared body'; value.notes[1].title = 'A independent title'; value.notes.push(note('only-a')); });
    await b.edit(TOOLS, (value) => { value.notes[0].title = 'B shared title'; value.notes[0].body = 'B shared body'; value.notes[1].body = 'B independent body'; value.notes.push(note('only-b')); });
    await a.edit(NAV, (value) => { value.state.entries[0].name = 'A site'; value.state.entries[1].page = 1; value.state.entries[1].position = { row: 1, column: 2 }; value.state.entries.push(site('site-a', 2)); });
    await b.edit(NAV, (value) => { value.state.entries[0].name = 'B site'; value.state.entries[1].name = 'B folder name'; value.state.entries.push(site('site-b', 2)); });
    await a.edit(PREFS, (value) => { value.library.tags[0].name = 'A renamed tag'; });
    await b.edit(PREFS, (value) => { value.library.items['note:shared-note'].description = 'B description'; });
    await sync(a); await sync(b, 'conflict');
    progress(receipt.stage = 'previewing-and-applying-record-choices');
    const before = await local[1].syncDataStore.snapshot(), preview = await b.api.previewFullDataMerge();
    assert.deepEqual(await local[1].syncDataStore.snapshot(), before);
    const sharedNote = preview.rows.find((row) => row.kind === 'note' && row.local?.id === 'shared-note');
    const sharedSite = preview.rows.find((row) => row.kind === 'navigation' && row.local?.id === 'shared-site');
    const independent = preview.rows.find((row) => row.kind === 'note' && row.local?.id === 'different-fields');
    assert.ok(sharedNote?.conflict && sharedSite?.conflict); assert.equal(independent?.conflict, false);
    await b.api.applyFullDataMerge({ token: preview.token, choices: { [sharedNote.id]: 'remote', [sharedSite.id]: 'local' } });
    assert.equal(await b.api.getFullDataMergeRecovery(), true);
    assert.deepEqual((await local[1].syncDataStore.readMergeRecovery()).snapshot, before);
    receipt.preview = { records: preview.rows.length, bothChanged: preview.rows.filter((row) => row.status === 'both').length,
      oneChanged: preview.rows.filter((row) => row.status === 'one').length, deleted: preview.rows.filter((row) => row.status === 'deleted').length,
      explicitChoices: 2, recoveryStored: true };
    progress(receipt.stage = 'publishing-and-checking-two-device-convergence');
    await sync(b); await sync(a); await sync(b);
    const left = await local[0].syncDataStore.snapshot(), right = await local[1].syncDataStore.snapshot();
    assert.deepEqual(left.records, right.records); assert.equal(left.token, right.token);
    const tools = await b.value(TOOLS), navigation = await b.value(NAV), preferences = await b.value(PREFS);
    assert.deepEqual(tools.notes.map((item) => item.id).sort(), ['different-fields', 'only-a', 'only-b', 'shared-note']);
    const shared = tools.notes.find((item) => item.id === 'shared-note'), combined = tools.notes.find((item) => item.id === 'different-fields');
    assert.equal(shared.title, 'A shared title'); assert.equal(shared.body, 'A shared body');
    assert.equal(combined.title, 'A independent title'); assert.equal(combined.body, 'B independent body');
    assert.deepEqual(navigation.state.entries.map((item) => item.id).sort(), ['child', 'folder', 'shared-site', 'site-a', 'site-b']);
    assert.equal(navigation.state.entries.find((item) => item.id === 'shared-site').name, 'B site');
    const folder = navigation.state.entries.find((item) => item.id === 'folder');
    assert.equal(folder.name, 'B folder name'); assert.equal(folder.page, 1); assert.deepEqual(folder.position, { row: 1, column: 2 });
    assert.equal(navigation.state.entries.find((item) => item.id === 'child').parentId, 'folder');
    assert.deepEqual(preferences.library.tags, [{ id: 'stable-tag', name: 'A renamed tag' }]);
    assert.deepEqual(preferences.library.items['note:shared-note'], { description: 'B description', tagIds: ['stable-tag'] });
    assert.equal(await a.value('covelet.language.v1'), 'zh-CN'); assert.equal(await b.value('covelet.language.v1'), 'en');
    assert.ok(left.records.every((item) => !['covelet.language.v1', 'covelet.privacy.lock.v1', 'covelet.data-sync.recovery.v1'].includes(item.key)));
    const indexes = await remote.provider.list(), blobs = await remote.assetProvider.list();
    receipt.result = { converged: true, snapshotDigest: left.token, notes: tools.notes.length, navigationEntries: navigation.state.entries.length,
      independentIdsPreserved: true, tagIdentityPreserved: true, folderMovePreserved: true, devicePreferencesPreserved: true,
      indexes: indexes.length, blobs: blobs.length, encryptedUploadsOnly: true };
    receipt.status = 'passed'; receipt.stage = 'completed';
  } finally {
    // Local ephemeral keys and records are released. Remote evidence is retained;
    // this runner contains no DELETE request and never touches another prefix.
    await Promise.allSettled(local.map((persistence) => persistence.close()));
    receipt.durationMs = Date.now() - started;
  }
}

const receipt = { format: 'covelet-record-merge-r2-verification', version: 1, startedAt: new Date().toISOString(), status: 'not-run',
  scope: 'Real R2 adapter + packaged signing WASM + full-data encryption + two encrypted in-memory local stores. No browser UI acceptance.',
  remoteEvidenceRetained: true, stage: 'loading-local-config' };
try {
  const config = await loadConfig();
  if (process.argv.includes('--check-config')) progress('r2-config-ready-no-network-requested');
  else await run(config, receipt);
} catch (error) {
  receipt.status = error?.code === 'R2_CONFIG_REQUIRED' ? 'blocked' : 'failed';
  receipt.errorCode = cleanCode(error);
  process.exitCode = receipt.status === 'blocked' ? 2 : 1;
  progress(receipt.status === 'blocked' ? 'stopped-r2-config-missing-or-placeholder' : `stopped-${receipt.errorCode}`);
} finally {
  receipt.finishedAt = new Date().toISOString();
  if (!process.argv.includes('--check-config')) {
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: receipt.status, receipt: 'output/playwright/covelet/record-merge-r2.json' })}\n`);
  }
}
