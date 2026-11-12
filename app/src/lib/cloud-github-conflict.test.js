import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createCloudProvider } from './cloud-providers.js';
import { createFullDataSync } from './full-data-sync.js';

// Synthetic GitHub REST/GraphQL protocol, with real adapters and encryption.
// This fixture never contacts GitHub or reads account credentials.
const clone = value => structuredClone(value), encoder = new TextEncoder(), decoder = new TextDecoder();
const profile = { provider: 'github', owner: 'fixture-owner', repo: 'fixture-repo', branch: 'qa/sync', prefix: 'fixture' };
const target = 'a'.repeat(64), password = 'synthetic github conflict password';
const hash = value => createHash('sha256').update(value).digest('hex');
const signer = { sha256: async value => hash(value), hmacSha256: async (key, value) => new Uint8Array(createHmac('sha256', key).update(value).digest()) };
const record = (key, value) => ({ namespace: 'preferences', key, value });

function githubProtocol() {
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
  let sequence = 0, head, mutationError, loseAdvance = false;
  const oid = () => (++sequence).toString(16).padStart(40, '0');
  const json = (value, status = 200) => Response.json(value, { status });
  const blob = bytes => { const sha = oid(); blobs.set(sha, bytes.slice()); return sha; };
  function tree(files) { const sha = oid(); trees.set(sha, clone(files)); return sha; }
  function commit(files, parent) {
    const sha = oid(), treeSha = tree(files);
    commits.set(sha, { files: clone(files), tree: treeSha, parents: parent ? [{ sha: parent }] : [] });
    return sha;
  }
  head = commit(new Map([['README.md', encoder.encode('Unrelated repository file')]]));
  function children(files) {
    const entries = new Map();
    for (const [path, bytes] of files) {
      const [name, ...tail] = path.split('/');
      if (entries.has(name)) continue;
      if (tail.length) {
        const nested = new Map([...files].filter(([key]) => key.startsWith(name + '/')).map(([key, value]) => [key.slice(name.length + 1), value]));
        entries.set(name, { path: name, type: 'tree', mode: '040000', sha: tree(nested) });
      } else entries.set(name, { path: name, type: 'blob', mode: '100644', sha: blob(bytes), size: bytes.length });
    }
    return [...entries.values()];
  }
  async function fetcher(address, request) {
    const url = new URL(address), headers = new Headers(request.headers);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(headers.get('authorization'), 'Bearer SYNTHETIC-TOKEN');
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error'); assert.equal(request.referrer, '');
    calls.push({ method: request.method, path: url.pathname });
    const input = request.body && JSON.parse(decoder.decode(request.body));
    const base = `/repos/${profile.owner}/${profile.repo}`;
    if (url.pathname === '/graphql') {
      assert.match(input.query, /updateRefs/);
      if (mutationError) return json({ errors: [{ type: mutationError, message: 'PRIVATE_SERVER_DETAILS' }] });
      const update = input.variables.input.refUpdates[0];
      assert.equal(update.name, `refs/heads/${profile.branch}`); assert.equal(update.force, false);
      if (update.beforeOid !== head) return json({ errors: [{ type: 'UNPROCESSABLE' }] });
      assert.ok(commits.has(update.afterOid)); head = update.afterOid;
      if (loseAdvance) { loseAdvance = false; throw new TypeError('Synthetic response lost after committed update'); }
      return json({ data: { updateRefs: { clientMutationId: input.variables.input.clientMutationId } } });
    }
    if (url.pathname === base) return json({ full_name: `${profile.owner}/${profile.repo}`, node_id: 'R_fixtureRepository' });
    if (url.pathname.startsWith(base + '/branches/')) return json({ name: profile.branch, commit: { sha: head, commit: { tree: { sha: commits.get(head).tree } } } });
    if (url.pathname.startsWith(base + '/git/blobs') && request.method === 'POST') return json({ sha: blob(new Uint8Array(Buffer.from(input.content, 'base64'))) }, 201);
    if (url.pathname === base + '/git/trees' && request.method === 'POST') {
      const files = clone(trees.get(input.base_tree)); assert.ok(files);
      for (const item of input.tree) {
        for (const key of files.keys()) if (key === item.path || key.startsWith(item.path + '/')) files.delete(key);
        if (item.sha !== null) files.set(item.path, item.content === undefined ? blobs.get(item.sha).slice() : encoder.encode(item.content));
      }
      return json({ sha: tree(files) }, 201);
    }
    if (url.pathname.startsWith(base + '/git/trees/')) {
      const sha = url.pathname.split('/').at(-1), files = trees.get(sha); assert.ok(files);
      return json({ sha, truncated: false, tree: children(files) });
    }
    if (url.pathname === base + '/git/commits' && request.method === 'POST') {
      const files = trees.get(input.tree); assert.ok(files);
      const sha = oid(); commits.set(sha, { files: clone(files), tree: input.tree, parents: input.parents.map(sha => ({ sha })) });
      return json({ sha, tree: { sha: input.tree }, parents: commits.get(sha).parents }, 201);
    }
    if (url.pathname.startsWith(base + '/git/commits/')) {
      const sha = url.pathname.split('/').at(-1), value = commits.get(sha); assert.ok(value);
      return json({ sha, tree: { sha: value.tree }, parents: value.parents });
    }
    assert.ok(url.pathname.startsWith(base + '/contents/'), url.pathname);
    const path = decodeURIComponent(url.pathname.slice((base + '/contents/').length));
    if (request.method === 'PUT') {
      const files = clone(commits.get(head).files);
      if (files.has(path)) return json({}, 422);
      files.set(path, new Uint8Array(Buffer.from(input.content, 'base64'))); head = commit(files, head);
      return json({}, 201);
    }
    const ref = url.searchParams.get('ref'), value = commits.get(ref === profile.branch ? head : ref); assert.ok(value);
    const bytes = value.files.get(path);
    if (bytes) return headers.get('accept') === 'application/vnd.github.raw+json' ? new Response(bytes) : json({
      type: 'file', path, size: bytes.length, encoding: 'base64', content: Buffer.from(bytes).toString('base64'),
    });
    const nested = new Map([...value.files].filter(([key]) => key.startsWith(path + '/')).map(([key, bytes]) => [key.slice(path.length + 1), bytes]));
    if (!nested.size) return json({}, 404);
    return json(children(nested).map(item => ({ name: item.path, path: path + '/' + item.path, size: item.size, type: item.type === 'tree' ? 'dir' : 'file' })));
  }
  const provider = suffix => createCloudProvider({ ...profile, prefix: `${profile.prefix}/${suffix}` }, { token: 'SYNTHETIC-TOKEN' }, { signer, fetcher });
  return { provider: provider('all-data-v1'), assetProvider: provider('all-data-v1/blobs'),
    githubV2: { provider: provider('all-data-v2'), assetProvider: provider('all-data-v2/blobs') }, calls,
    get files() { return clone(commits.get(head).files); },
    addFile(path, content) { const files = clone(commits.get(head).files); files.set(path, encoder.encode(content)); head = commit(files, head); },
    set mutationError(value) { mutationError = value; }, set loseAdvance(value) { loseAdvance = value; } };
}

function memory() {
  let value = null;
  return { async read() { return clone(value); }, async write(next) { value = clone(next); } };
}
function device(remote, actor, initial = []) {
  let records = clone(initial), revision = 0, sequence = 0;
  const store = memory(), historyStore = memory(), pending = new Map();
  const pendingStore = { async get(key) { return clone(pending.get(key)); }, async set(key, value) { pending.set(key, clone(value)); },
    async remove(key) { pending.delete(key); }, async entries() { return clone([...pending]); } };
  const snapshotStore = { syncMetadataStore: store,
    async snapshot() { return { version: 1, records: clone(records), token: String(revision) }; },
    async apply(next, { expectedToken, syncMetadata }) {
      assert.equal(expectedToken, String(revision));
      if (syncMetadata !== undefined) await store.write(syncMetadata);
      records = clone(next.records); revision++; return snapshotStore.snapshot();
    },
  };
  const make = () => createFullDataSync({ store, historyStore, pendingStore, snapshotStore, signer, locks: null, eventWindow: null, eventDocument: null,
    uuid: () => actor.repeat(16) + (++sequence).toString(16).padStart(16, '0'),
    access: async () => ({ ...remote, target, password, autoSync: false, check: async () => {} }) });
  return { api: make(), make, get records() { return clone(records); }, edit(change) { change(records); revision++; } };
}
async function saved(device) {
  const result = await device.api.syncFullDataNow(); assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`); return result;
}
async function conflictFixture() {
  const cloud = githubProtocol(), a = device(cloud, 'a', [record('covelet.github.fixture', 'initial')]), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'cloud'; records.push(record('covelet.cloud.only', 'cloud only')); });
  b.edit(records => { records[0].value = 'local'; records.push(record('covelet.local.only', 'local only')); });
  await saved(a);
  const result = await b.api.syncFullDataNow(); assert.equal(result.phase, 'conflict', `${result.code}: ${result.message}`);
  return { cloud, a, b };
}

test('GitHub real adapters replace the complete cloud snapshot with local data and let a fresh device restore it', async () => {
  const { cloud, a, b } = await conflictFixture();
  const result = await b.api.resolveFullDataConflicts('local'); assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`);
  const c = device(cloud, 'c'); await saved(c);
  assert.deepEqual(c.records, b.records); assert.equal(c.records.some(record => record.key === 'covelet.cloud.only'), false);
  assert.ok(cloud.files.has('README.md'));
  assert.ok(cloud.files.has('fixture/all-data-v1'), 'old directory is sealed after the verified replacement');
  assert.ok(cloud.calls.some(call => call.path === '/graphql'));
  const remote = await a.api.resolveFullDataConflicts('remote'); assert.equal(remote.phase, 'saved', `${remote.code}: ${remote.message}`);
  assert.deepEqual(a.records, b.records);
});

test('GitHub real adapters keep the cloud intact when replacement lacks permission and can retry', async () => {
  const { cloud, b } = await conflictFixture(), previous = cloud.files;
  cloud.mutationError = 'FORBIDDEN';
  const failed = await b.api.resolveFullDataConflicts('local'); assert.equal(failed.phase, 'error'); assert.equal(failed.code, 'CLOUD_AUTH');
  assert.doesNotMatch(failed.message, /PRIVATE|格式/); assert.deepEqual(cloud.files, previous);
  cloud.mutationError = null;
  const retried = await b.api.resolveFullDataConflicts('local'); assert.equal(retried.phase, 'saved', `${retried.code}: ${retried.message}`);
  const c = device(cloud, 'c'); await saved(c); assert.deepEqual(c.records, b.records);
});

test('GitHub real adapters recover a committed replacement whose response was lost after restart', async () => {
  const { cloud, b } = await conflictFixture(); cloud.loseAdvance = true;
  const failed = await b.api.resolveFullDataConflicts('local'); assert.equal(failed.phase, 'error'); assert.equal(failed.code, 'CLOUD_NETWORK');
  b.api = b.make(); await saved(b);
  const c = device(cloud, 'c'); await saved(c); assert.deepEqual(c.records, b.records);
});

test('GitHub reads an old directory containing a README but refuses to replace unrelated files with an accurate error', async () => {
  const { cloud, a, b } = await conflictFixture();
  cloud.addFile('fixture/all-data-v1/README.md', 'Unrelated user file');
  const c = device(cloud, 'c'); await saved(c); assert.deepEqual(c.records, a.records, 'an unrelated file does not invalidate a readable cloud snapshot');
  const before = cloud.files, local = b.records;
  const failed = await b.api.resolveFullDataConflicts('local');
  assert.equal(failed.phase, 'error'); assert.equal(failed.code, 'CLOUD_DIRECTORY_NOT_DEDICATED');
  assert.equal(failed.message, '同步目录包含其他文件，请先将它们移出同步目录后重试。');
  assert.deepEqual(cloud.files, before, 'keep the complete remote directory including the README');
  assert.deepEqual(b.records, local, 'a refused replacement preserves local content');
});
