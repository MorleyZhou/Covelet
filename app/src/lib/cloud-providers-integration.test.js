import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createCloudProvider, cloudOrigin } from './cloud-providers.js';
import { createFullDataSync } from './full-data-sync.js';
import { createCloudSync } from './cloud-sync.js';
import { createEmptyState } from './model.js';

// These are synthetic HTTP protocol fixtures, not real-service acceptance.
// They exercise the actual adapters, encryption and full-data engine together.
const encoder = new TextEncoder(), decoder = new TextDecoder();
const clone = (value) => structuredClone(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const signer = { sha256: async (value) => hash(value), hmacSha256: async (key, value) => new Uint8Array(createHmac('sha256', key).update(value).digest()) };
const credentials = { token: 'SYNTHETIC-TOKEN', accessKeyId: 'SYNTHETIC-ACCESS', secretAccessKey: 'SYNTHETIC-SECRET' };
const profiles = [
  { provider: 'github', owner: 'fixture-owner', repo: 'fixture-repo', branch: 'qa/sync', prefix: 'qa' },
  { provider: 'gitlab', endpoint: 'https://git.example.test', project: 'fixture/project', branch: 'qa/sync', prefix: 'qa' },
  { provider: 'r2', endpoint: 'https://account.r2.example.test', bucket: 'qa-bucket', prefix: 'qa' },
  { provider: 'oss', endpoint: 'https://qa-bucket.oss.example.test', bucket: 'qa-bucket', region: 'cn-hangzhou', prefix: 'qa' },
];
const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
const xml = (value) => new Response(value, { headers: { 'content-type': 'application/xml' } });
const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function protocolFixture(profile, { emptyTreeStatus = 404, timeoutMs } = {}) {
  const objects = new Map(), calls = [], writes = [];
  let unknownWrite, readStatus, readFault, delayedWrite;
  const readObject = (path) => readFault?.path === path ? readFault.respond() : objects.has(path) ? new Response(objects.get(path)) : json({}, 404);
  const directChildren = (prefix) => {
    const items = new Map();
    for (const [path, bytes] of objects) {
      if (!path.startsWith(`${prefix}/`)) continue;
      const tail = path.slice(prefix.length + 1), name = tail.split('/')[0];
      if (tail.includes('/')) items.set(name, { name, path: `${prefix}/${name}`, type: 'tree', mode: '040000' });
      else items.set(name, { name, path, type: 'blob', mode: '100644', size: bytes.length });
    }
    return [...items.values()].sort((a, b) => a.path.localeCompare(b.path));
  };
  const commit = (path, bytes) => {
    if (objects.has(path)) return json({}, profile.provider === 'gitlab' ? 400 : profile.provider === 'github' ? 422 : profile.provider === 'oss' ? 409 : 412);
    objects.set(path, bytes.slice()); writes.push({ path, bytes: bytes.slice() });
    const area = path.includes('/blobs/') ? 'chunk' : 'index';
    if (delayedWrite?.area === area) {
      const gate = delayedWrite; delayedWrite = null; gate.started.resolve(); return gate.response.promise;
    }
    if (unknownWrite === area) { unknownWrite = null; throw new TypeError('SYNTHETIC lost response after commit'); }
    return json({}, ['github', 'gitlab'].includes(profile.provider) ? 201 : 200);
  };
  async function fetcher(address, request) {
    const url = new URL(address), headers = new Headers(request.headers);
    assert.equal(url.origin, cloudOrigin(profile));
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
    assert.equal(request.referrer, ''); assert.equal(request.referrerPolicy, 'no-referrer');
    calls.push({ address, method: request.method });
    if (readStatus && request.method === 'GET') return json({ message: 'SYNTHETIC PRIVATE SERVER DETAILS' }, readStatus);
    if (profile.provider === 'github') {
      assert.equal(headers.get('authorization'), `Bearer ${credentials.token}`);
      assert.equal(headers.get('x-github-api-version'), '2026-03-10');
      const base = `/repos/${profile.owner}/${profile.repo}`;
      if (url.pathname.startsWith(`${base}/branches/`)) return json({ name: decodeURIComponent(url.pathname.slice(`${base}/branches/`.length)) });
      assert.ok(url.pathname.startsWith(`${base}/contents/`));
      const path = decodeURIComponent(url.pathname.slice(`${base}/contents/`.length));
      if (request.method === 'PUT') {
        const body = JSON.parse(decoder.decode(request.body));
        assert.equal(body.branch, profile.branch); assert.equal(body.sha, undefined, 'only create, never update existing Git files');
        return commit(path, new Uint8Array(Buffer.from(body.content, 'base64')));
      }
      assert.equal(url.searchParams.get('ref'), profile.branch);
      if (objects.has(path)) { assert.equal(headers.get('accept'), 'application/vnd.github.raw+json'); return readObject(path); }
      const children = directChildren(path);
      return children.length ? json(children.map(item => ({ ...item, type: item.type === 'tree' ? 'dir' : 'file' }))) : json({}, 404);
    }
    if (profile.provider === 'gitlab') {
      assert.equal(headers.get('private-token'), credentials.token);
      const base = `/api/v4/projects/${encodeURIComponent(profile.project)}/repository/`;
      assert.ok(url.pathname.startsWith(base));
      const resource = url.pathname.slice(base.length);
      if (resource.startsWith('branches/')) return json({ name: decodeURIComponent(resource.slice('branches/'.length)) });
      if (resource === 'tree') {
        assert.equal(request.method, 'GET'); assert.equal(url.searchParams.get('ref'), profile.branch);
        assert.equal(url.searchParams.get('recursive'), 'false');
        const children = directChildren(url.searchParams.get('path'));
        if (!children.length && emptyTreeStatus === 404) return json({}, 404);
        const page = Number(url.searchParams.get('page')), count = Number(url.searchParams.get('per_page'));
        return json(children.slice((page - 1) * count, page * count), 200, {
          'x-page': String(page), 'x-next-page': page * count < children.length ? String(page + 1) : '',
          'x-total': String(children.length), 'x-total-pages': String(Math.ceil(children.length / count)),
        });
      }
      assert.ok(resource.startsWith('files/'));
      const raw = resource.endsWith('/raw'), path = decodeURIComponent(resource.slice('files/'.length, raw ? -'/raw'.length : undefined));
      if (request.method === 'POST') {
        assert.equal(raw, false);
        const body = JSON.parse(decoder.decode(request.body));
        assert.equal(body.branch, profile.branch); assert.equal(body.encoding, 'base64');
        return commit(path, new Uint8Array(Buffer.from(body.content, 'base64')));
      }
      assert.ok(raw); assert.equal(url.searchParams.get('ref'), profile.branch);
      return readObject(path);
    }
    assert.match(headers.get('authorization'), profile.provider === 'r2' ? /^AWS4-HMAC-SHA256 / : /^OSS4-HMAC-SHA256 /);
    const path = decodeURIComponent(url.pathname).slice(profile.provider === 'r2' ? profile.bucket.length + 2 : 1);
    if (profile.provider === 'oss' && url.searchParams.has('versioning')) return xml('<VersioningConfiguration/>');
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix'), offset = Number(url.searchParams.get('continuation-token') || 0);
      const matches = [...objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      // A server may return fewer than max-keys; continue until IsTruncated=false.
      const page = matches.slice(offset, offset + 2), more = offset + page.length < matches.length;
      return xml(`<ListBucketResult><IsTruncated>${more}</IsTruncated><EncodingType>url</EncodingType><KeyCount>${page.length}</KeyCount>${page.map(([key, bytes]) => `<Contents><Key>${escapeXml(encodeURIComponent(key))}</Key><Size>${bytes.length}</Size></Contents>`).join('')}${more ? `<NextContinuationToken>${offset + page.length}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    if (request.method === 'PUT') {
      assert.equal(headers.get(profile.provider === 'r2' ? 'if-none-match' : 'x-oss-forbid-overwrite'), profile.provider === 'r2' ? '*' : 'true');
      return commit(path, new Uint8Array(request.body));
    }
    assert.equal(request.method, 'GET');
    return readObject(path);
  }
  const factory = (profile, secrets, options = {}) => createCloudProvider(profile, secrets, { ...options, signer, fetcher, timeoutMs });
  const at = (suffix) => factory({ ...profile, prefix: `${profile.prefix}/${suffix}` }, credentials);
  return { provider: at('all-data-v1'), assetProvider: at('all-data-v1/blobs'), objects, calls, writes,
    factory, set unknownWrite(area) { unknownWrite = area; }, set readStatus(status) { readStatus = status; },
    set readFault(value) { readFault = value; }, set delayedWrite(value) { delayedWrite = value; } };
}
function memory(initial = null) {
  let current = clone(initial);
  return { async read() { return clone(current); }, async write(next) { current = clone(next); }, async clear() { current = null; }, get value() { return clone(current); } };
}
function device(remote, actor, initial = []) {
  let records = clone(initial), revision = 0, applied = 0;
  const store = memory(), pending = new Map();
  const pendingStore = { async get(key) { return clone(pending.get(key)); }, async set(key, value) { pending.set(key, clone(value)); },
    async remove(key) { pending.delete(key); }, async entries() { return clone([...pending]); } };
  const snapshotStore = { async snapshot() { return { version: 1, records: clone(records), token: String(revision) }; },
    async apply(next, { expectedToken }) { assert.equal(expectedToken, String(revision)); records = clone(next.records); revision++; applied++; return snapshotStore.snapshot(); } };
  const make = () => createFullDataSync({ store, pendingStore, snapshotStore, uuid: () => actor.repeat(32), locks: null, eventWindow: null, eventDocument: null,
    access: async () => ({ target: 'a'.repeat(64), password: 'synthetic provider integration password', autoSync: false, ...remote, check: async () => {} }) });
  return { api: make(), make, store, pending, pendingStore, snapshotStore, get applied() { return applied; }, get records() { return clone(records); },
    edit(change) { change(records); revision++; } };
}
const record = (key, value, namespace = 'preferences') => ({ namespace, key, value });
const tools = (body) => ({ version: 3, revision: 0, notes: [{ id: 'note-a', title: 'QA note', body, pinned: false, revision: 1, createdAt: 1, updatedAt: 1 }], reading: [], snapshots: [], trash: [] });
const saved = async (client) => { const result = await client.api.syncFullDataNow(); assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`); };
const valueOf = (client, key) => client.records.find(record => record.key === key)?.value;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const profile of profiles) {
  test(`${profile.provider} full-data engine keeps actionable adapter HTTP errors, retains local data and can retry`, async () => {
    const remote = protocolFixture(profile), original = [record('covelet.tools.v1', tools('LOCAL-UNSYNCED'))], a = device(remote, 'a', original);
    for (const [status, code] of [[401, 'CLOUD_AUTH'], [403, 'CLOUD_AUTH'], [404, 'CLOUD_NOT_FOUND'], [429, 'CLOUD_RATE_LIMIT'], [503, 'CLOUD_REQUEST_FAILED']]) {
      remote.readStatus = status;
      const result = await a.api.syncFullDataNow();
      assert.equal(result.code, code); assert.equal(result.phase, 'error');
      assert.doesNotMatch(result.message, /SYNTHETIC|PRIVATE|SERVER DETAILS/);
      assert.deepEqual(a.records, original); assert.equal(remote.writes.length, 0);
    }
    remote.readStatus = null; await saved(a);
    const b = device(remote, 'b'); await saved(b);
    assert.deepEqual(valueOf(b, 'covelet.tools.v1'), valueOf(a, 'covelet.tools.v1'));
  });

  test(`${profile.provider} synthetic protocol: two clients exchange full records/images, repeat sync and whole-record conflict choice`, async () => {
    const remote = protocolFixture(profile), image = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
    const a = device(remote, 'a', [record('owntab.local.v1', { version: 1, state: createEmptyState(), snapshots: [] }), record('covelet.tools.v1', tools('PRIVATE-NOTE-SENTINEL')),
      record('qa-image', { id: 'qa-image', blob: image }, 'assets'), record('covelet.qa.large.v1', { text: 'PRIVATE-LARGE-SENTINEL'.repeat(18000) })]);
    const b = device(remote, 'b');
    await saved(a); await saved(b); await saved(a);
    assert.deepEqual(b.records, a.records);
    assert.deepEqual(new Uint8Array(await valueOf(b, 'qa-image').blob.arrayBuffer()), new Uint8Array(await image.arrayBuffer()));
    const writes = remote.writes.length;
    await saved(a); await saved(b);
    assert.equal(remote.writes.length, writes, 'repeat sync must not upload unchanged ciphertext');
    a.edit(records => { records.find(record => record.key === 'covelet.tools.v1').value.notes[0].body = 'A changed the group'; });
    b.edit(records => { const value = records.find(record => record.key === 'covelet.tools.v1').value; value.notes[0].body = 'B changed the group'; value.reading.push({ id: 'b-only', title: 'B saved link', url: 'https://b-only.example.test/', status: 'unread', revision: 1, createdAt: 1, updatedAt: 1 }); });
    await saved(a); await saved(b); await saved(a);
    assert.equal(valueOf(b, 'covelet.tools.v1').notes[0].body, 'B changed the group', 'local content stays until a choice');
    const conflicts = await b.api.getFullDataConflicts(), chosen = conflicts.find(item => item.actor === 'a'.repeat(32));
    assert.ok(chosen, 'both versions of the tools record must remain available');
    await b.api.restoreFullDataConflict(chosen.id); await saved(b); await saved(a);
    assert.equal(valueOf(a, 'covelet.tools.v1').notes[0].body, 'A changed the group');
    assert.deepEqual(valueOf(a, 'covelet.tools.v1').reading, [], 'choosing one whole group must not silently merge the other version');
    assert.deepEqual(valueOf(b, 'covelet.tools.v1'), valueOf(a, 'covelet.tools.v1'));
    for (const bytes of remote.objects.values()) assert.doesNotMatch(decoder.decode(bytes), /PRIVATE-NOTE-SENTINEL|PRIVATE-LARGE-SENTINEL|A changed the group|B changed the group/);
  });

  test(`${profile.provider} synthetic protocol: committed write with lost response survives restart and retries exact persisted ciphertext`, async () => {
    for (const area of ['chunk', 'index']) {
      const remote = protocolFixture(profile), a = device(remote, 'a', [record('covelet.tools.v1', tools(`retry-${area}`))]);
      remote.unknownWrite = area;
      assert.equal((await a.api.syncFullDataNow()).phase, 'error');
      const pending = a.store.value.metadata.pending;
      assert.ok(pending); assert.ok(a.pending.size);
      a.api = a.make(); await saved(a);
      const retried = remote.objects.get(`${profile.prefix}/all-data-v1/${pending.name}`);
      assert.deepEqual(retried, encoder.encode(pending.body));
      const paths = remote.writes.map(item => item.path);
      assert.equal(new Set(paths).size, paths.length, 'the retry may read committed objects but must not create a second payload at the same name');
      assert.equal(a.store.value.metadata.pending, null);
      const b = device(remote, 'b'); await saved(b);
      assert.deepEqual(valueOf(b, 'covelet.tools.v1'), valueOf(a, 'covelet.tools.v1'));
    }
  });

  test(`${profile.provider} image pull faults reject the entire batch, preserve local records and allow an explicit retry`, async () => {
    const remote = protocolFixture(profile, { timeoutMs: 100 });
    const bytes = Uint8Array.from({ length: 340 * 1024 }, (_, index) => index % 251);
    const a = device(remote, 'a', [record('remote-image', { blob: new Blob([bytes], { type: 'image/png' }) }, 'assets')]);
    await saved(a);
    // Fail the second image chunk after a full first chunk has been received.
    const imagePath = remote.writes.filter(item => item.path.includes('/blobs/'))[1].path;
    const original = remote.objects.get(imagePath), corrupt = original.slice(); corrupt[0] ^= 1;
    const b = device(remote, 'b', [record('covelet.local-note.v1', { body: 'local unsynced note' }),
      record('local-image', { blob: new Blob(['local image'], { type: 'image/webp' }) }, 'assets')]);
    const before = b.records, writes = remote.writes.length;
    let streamController;
    const faults = [
      ['CLOUD_NETWORK', () => { throw new TypeError('SYNTHETIC private transport failure'); }],
      ['CLOUD_TIMEOUT', () => new Response(new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(original.slice(0, 17)); } }))],
      ['CLOUD_NOT_FOUND', () => json({ message: 'SYNTHETIC private missing image' }, 404)],
      ['CLOUD_INTEGRITY', () => new Response(corrupt)],
    ];
    for (const [code, respond] of faults) {
      remote.readFault = { path: imagePath, respond };
      try {
        const result = await b.api.syncFullDataNow();
        assert.equal(result.phase, 'error'); assert.equal(result.code, code);
        assert.doesNotMatch(result.message, /SYNTHETIC|private transport|private missing/);
        assert.deepEqual(b.records, before); assert.equal(b.applied, 0);
        assert.equal(await valueOf(b, 'local-image').blob.text(), 'local image');
        assert.equal(b.store.value, null); assert.equal(b.pending.size, 0);
        assert.equal(remote.writes.length, writes, 'a partial image download must not publish any local revision');
      } finally { streamController?.close(); streamController = undefined; }
    }
    remote.readFault = null; b.api = b.make(); await saved(b);
    assert.deepEqual(new Uint8Array(await valueOf(b, 'remote-image').blob.arrayBuffer()), bytes);
    assert.equal(valueOf(b, 'remote-image').blob.type, 'image/png');
    assert.deepEqual(valueOf(b, 'local-image'), before.find(item => item.key === 'local-image').value);
    assert.equal(await valueOf(b, 'local-image').blob.text(), 'local image');
    assert.deepEqual(valueOf(b, 'covelet.local-note.v1'), before.find(item => item.key === 'covelet.local-note.v1').value);
    const afterRetry = remote.writes.length; await saved(b);
    assert.equal(remote.writes.length, afterRetry);
  });

  test(`${profile.provider} late write responses after timeout cannot acknowledge pending ciphertext, including after restart`, async () => {
    for (const area of ['chunk', 'index']) {
      const remote = protocolFixture(profile, { timeoutMs: 100 });
      const bytes = Uint8Array.from({ length: 270 * 1024 }, (_, index) => (index * 7) % 251);
      const a = device(remote, 'a', [record('retry-image', { blob: new Blob([bytes], { type: 'image/png' }) }, 'assets')]);
      const gate = { area, started: deferred(), response: deferred() }; remote.delayedWrite = gate;
      try {
        const result = await a.api.syncFullDataNow();
        assert.equal(result.code, 'CLOUD_TIMEOUT'); assert.equal(result.phase, 'error');
        const pending = a.store.value.metadata.pending;
        assert.ok(pending); assert.ok(a.pending.size); assert.equal(a.store.value.metadata.lastSync, 0);
        assert.equal(remote.writes.some(item => area === 'chunk' ? item.path.includes('/blobs/') : !item.path.includes('/blobs/')), true);
        gate.response.resolve(json({}, ['github', 'gitlab'].includes(profile.provider) ? 201 : 200));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(a.store.value.metadata.pending, pending, 'late success must not clear the durable retry record');
        assert.equal(a.api.getFullDataSyncStatus().phase, 'error');
        a.api = a.make(); await saved(a);
        assert.deepEqual(remote.objects.get(`${profile.prefix}/all-data-v1/${pending.name}`), encoder.encode(pending.body));
        const paths = remote.writes.map(item => item.path);
        assert.equal(new Set(paths).size, paths.length, 'a retry must read the committed object instead of creating a duplicate');
        assert.equal(a.store.value.metadata.pending, null); assert.equal(a.pending.size, 0);
        const b = device(remote, 'b'); await saved(b);
        assert.deepEqual(new Uint8Array(await valueOf(b, 'retry-image').blob.arrayBuffer()), bytes);
        assert.equal(valueOf(b, 'retry-image').blob.type, 'image/png');
      } finally { gate.response.resolve(json({})); }
    }
  });
}

function fullController(remote, profile, client, stores = {}) {
  const configStore = stores.configStore || memory(), sessionStore = stores.sessionStore || memory();
  const make = (options = {}) => createCloudSync({ configStore, sessionStore, fullData: true, legacySeed: false, fullSyncStore: client.store,
    fullPendingStore: client.pendingStore, snapshotStore: client.snapshotStore, providerFactory: remote.factory, signer, locks: null,
    hasPermission: async () => true, stateStore: { async loadState() { return createEmptyState(); } }, toolSyncStore: memory(),
    uuid: () => 'a'.repeat(32), eventWindow: null, eventDocument: null, ...options });
  return { api: make(), make, configStore, sessionStore, profile };
}

test('full-data controller locking during a committed GitLab write keeps the exact pending image revision until explicit unlock', async () => {
  const profile = profiles.find(item => item.provider === 'gitlab'), remote = protocolFixture(profile);
  const client = device(remote, 'a', [record('controller-image', { blob: new Blob(['private image'], { type: 'image/webp' }) }, 'assets')]);
  const controller = fullController(remote, profile, client), password = 'synthetic controller password';
  await controller.api.saveCloudSyncSettings(profile, credentials, password);
  const gate = { area: 'chunk', started: deferred(), response: deferred() }; remote.delayedWrite = gate;
  try {
    const running = controller.api.syncCloudNow(); await gate.started.promise;
    const pending = client.store.value.metadata.pending; assert.ok(pending);
    await controller.api.lockCloudSync(); gate.response.resolve(json({}, 201));
    const result = await running;
    assert.equal(result.phase, 'locked'); assert.equal(result.code, 'CLOUD_LOCKED');
    assert.deepEqual(client.store.value.metadata.pending, pending);
    assert.equal(controller.api.getCloudSyncStatus().unlocked, false);
    const calls = remote.calls.length;
    controller.api = controller.make();
    assert.equal((await controller.api.loadCloudSyncSettings()).unlocked, false);
    assert.equal((await controller.api.syncCloudNow()).code, 'CLOUD_LOCKED'); assert.equal(remote.calls.length, calls);
    await controller.api.unlockCloudSync(credentials, password);
    assert.equal((await controller.api.syncCloudNow()).phase, 'saved');
    assert.equal(client.store.value.metadata.pending, null);
    const paths = remote.writes.map(item => item.path); assert.equal(new Set(paths).size, paths.length);
  } finally { gate.response.resolve(json({}, 201)); }
});

test('full-data controller reports denied permission and unavailable browser access without trusting exception text or contacting the provider', async () => {
  const profile = profiles.find(item => item.provider === 'gitlab'), remote = protocolFixture(profile);
  const client = device(remote, 'a', [record('covelet.local-note.v1', { body: 'retained locally' })]);
  const controller = fullController(remote, profile, client);
  await controller.api.saveCloudSyncSettings(profile, credentials, 'synthetic controller password');
  const failures = [
    ['CLOUD_PERMISSION', async () => false],
    ['CLOUD_PERMISSION', async () => { throw { code: 'CLOUD_PERMISSION', message: 'SYNTHETIC private forged permission token https://private.example/' }; }],
    ['CLOUD_UNAVAILABLE', async () => { throw Object.assign(Error('SYNTHETIC private unavailable token https://private.example/'), { code: 'CLOUD_UNAVAILABLE' }); }],
  ];
  for (const [code, hasPermission] of failures) {
    controller.api = controller.make({ hasPermission });
    const before = client.records, result = await controller.api.syncCloudNow();
    assert.equal(result.code, code); assert.equal(result.phase, 'error');
    assert.doesNotMatch(result.message, /SYNTHETIC|private|forged|token|http/);
    assert.deepEqual(client.records, before); assert.equal(remote.calls.length, 0); assert.equal(client.store.value, null);
    assert.equal(client.applied, 0); assert.equal(client.pending.size, 0);
  }
});

test('GitLab synthetic protocol: legacy empty-directory 200 responses initialize safely and exchange full data', async () => {
  const remote = protocolFixture(profiles.find(profile => profile.provider === 'gitlab'), { emptyTreeStatus: 200 });
  const a = device(remote, 'a', [record('covelet.tools.v1', tools('legacy empty-directory fixture'))]);
  const b = device(remote, 'b');
  await saved(a); await saved(b);
  assert.deepEqual(b.records, a.records);
  assert.ok(remote.calls.some(call => new URL(call.address).pathname.includes('/repository/branches/')), 'an empty response must verify branch visibility');
  const writes = remote.writes.length;
  await saved(a); await saved(b);
  assert.equal(remote.writes.length, writes);
});

test('full-data engine does not trust a forged provider code or arbitrary transport message', async () => {
  const fixture = protocolFixture(profiles[0]);
  const remote = { ...fixture, provider: { async list() { throw Object.assign(Error('SYNTHETIC PRIVATE EXCEPTION'), { code: 'CLOUD_AUTH' }); } } };
  const a = device(remote, 'a', [record('covelet.tools.v1', tools('local'))]);
  const result = await a.api.syncFullDataNow();
  assert.equal(result.code, 'DATA_SYNC_REQUEST');
  assert.doesNotMatch(result.message, /SYNTHETIC|PRIVATE/); assert.equal(fixture.writes.length, 0);
});
