import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createCloudProvider } from './cloud-providers.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const signer = { sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
  hmacSha256: async (key, bytes) => new Uint8Array(createHmac('sha256', key).update(bytes).digest()) };
const profiles = {
  r2: { provider: 'r2', endpoint: 'https://fake.r2.cloudflarestorage.com', bucket: 'test-bucket', prefix: 'covelet/all-data-v1' },
  oss: { provider: 'oss', endpoint: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com', bucket: 'test-bucket', region: 'cn-hangzhou', prefix: 'covelet/all-data-v1' },
  github: { provider: 'github', owner: 'fake-owner', repo: 'private-sync', branch: 'sync/covelet', prefix: 'covelet/all-data-v1' },
  gitlab: { provider: 'gitlab', endpoint: 'https://gitlab.com', project: 'fake-group/private-sync', branch: 'sync/covelet', prefix: 'covelet/all-data-v1' },
  webdav: { provider: 'webdav', endpoint: 'https://dav.example.test/remote/files/alice/', prefix: 'covelet/all-data-v1' },
};
const secrets = { accessKeyId: 'FAKE-ACCESS-KEY', secretAccessKey: 'FAKE-SECRET-NOT-A-CREDENTIAL', token: 'FAKE-TOKEN',
  username: 'fake-user', appPassword: 'FAKE-APP-PASSWORD' };
const epoch = (next = 'a'.repeat(32), previous = null) => encoder.encode(JSON.stringify({ format: 'covelet-password-epoch', version: 1,
  previous, next, proof: 'synthetic-new-password-encrypted-proof' }));
const response = (body, status = 200) => new Response(status === 204 ? null : body, { status });

function remote(profile, options = {}) {
  const calls = [], controls = new Map(), mutationBodies = [];
  let loseResponse = options.loseResponse;
  const isVersioning = (url) => profile.provider === 'oss' && new URL(url).search === '?versioning';
  const fetcher = async (url, input) => {
    calls.push({ url, ...input });
    if (isVersioning(url)) return response(options.versioning || '<VersioningConfiguration/>');
    if (input.method === 'GET') return controls.has(url) ? response(controls.get(url).slice()) : response('', 404);
    const tokenProvider = ['github', 'gitlab'].includes(profile.provider);
    const readUrl = new URL(url);
    if (profile.provider === 'github') readUrl.search = new URLSearchParams({ ref: profile.branch }).toString();
    if (profile.provider === 'gitlab') { readUrl.pathname += '/raw'; readUrl.search = new URLSearchParams({ ref: profile.branch }).toString(); }
    const bytes = tokenProvider ? new Uint8Array(Buffer.from(JSON.parse(decoder.decode(input.body)).content, 'base64')) : input.body.slice();
    mutationBodies.push(bytes);
    if (options.unsupported) return response('<Error><Code>NotImplemented</Code></Error>', options.unsupported);
    if (controls.has(readUrl.href)) return response('', profile.provider === 'gitlab' ? 400 : 412);
    if (profile.provider === 'r2' || profile.provider === 'webdav') assert.equal(input.headers['if-none-match'], '*');
    if (profile.provider === 'oss') { assert.equal(input.headers['x-oss-forbid-overwrite'], 'true'); assert.equal(input.headers['if-none-match'], undefined); }
    if (tokenProvider) assert.equal(Object.hasOwn(JSON.parse(decoder.decode(input.body)), 'sha'), false, 'create never supplies an existing file SHA');
    controls.set(readUrl.href, options.corruptStored ? epoch('c'.repeat(32)) : bytes);
    if (loseResponse) { loseResponse = false; throw Error('synthetic lost response FAKE-SECRET-NOT-A-CREDENTIAL'); }
    return response('', tokenProvider ? 201 : 200);
  };
  return { calls, controls, mutationBodies, fetcher };
}
const make = (profile, cloud, options = {}) => createCloudProvider(profile, secrets, { signer, fetcher: cloud.fetcher, ...options });

for (const [name, profile] of Object.entries(profiles)) {
  test(`${name} reads and creates only its fixed sibling password epoch, with immutable same-body retry`, async () => {
    const cloud = remote(profile), provider = make(profile, cloud), bytes = epoch();
    assert.equal(await provider.readPasswordEpoch(), null);
    await provider.createPasswordEpoch(bytes);
    assert.deepEqual(await provider.readPasswordEpoch(), bytes);
    await provider.createPasswordEpoch(bytes);
    assert.equal(cloud.mutationBodies.length, 1);
    assert.deepEqual(cloud.mutationBodies[0], bytes);
    const controlCalls = cloud.calls.filter((call) => !call.url.endsWith('?versioning'));
    for (const call of controlCalls) {
      const pathname = decodeURIComponent(new URL(call.url).pathname);
      assert.ok(pathname.includes('covelet/password-epoch-v1.json'));
      assert.ok(!pathname.includes('/all-data-v1/password-epoch-v1.json'));
      assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error'); assert.equal(call.referrerPolicy, 'no-referrer');
      assert.ok(!call.url.includes(secrets.secretAccessKey));
    }
    if (name === 'oss') assert.equal(cloud.calls.filter((call) => call.url.endsWith('?versioning')).length, 1);
    if (name === 'github') assert.equal(cloud.calls.find((call) => call.method === 'PUT').headers.accept, 'application/vnd.github+json');
    if (name === 'gitlab') assert.equal(cloud.calls.find((call) => call.method === 'POST').headers['content-type'], 'application/json');
  });

  test(`${name} reconciles unknown create outcome with fresh readback and rejects a competing generation`, async () => {
    const cloud = remote(profile, { loseResponse: true }), provider = make(profile, cloud);
    await provider.createPasswordEpoch(epoch());
    assert.equal(cloud.mutationBodies.length, 1, 'lost mutation response needs no unconditional rewrite');
    await assert.rejects(provider.createPasswordEpoch(epoch('b'.repeat(32))), { code: 'CLOUD_CONFLICT' });
    assert.equal(cloud.mutationBodies.length, 1, 'different existing generation is preserved');
    assert.equal(JSON.parse(decoder.decode([...cloud.controls.values()][0])).next, 'a'.repeat(32));
  });

  test(`${name} concurrent create attempts cannot both activate different password epochs`, async () => {
    const cloud = remote(profile), first = make(profile, cloud), second = make(profile, cloud);
    const results = await Promise.allSettled([first.createPasswordEpoch(epoch()), second.createPasswordEpoch(epoch('b'.repeat(32)))]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CLOUD_CONFLICT');
    assert.equal(cloud.controls.size, 1);
  });

  test(`${name} refuses malformed, excessive or path-injected controls without issuing requests`, async () => {
    const cloud = remote(profile), provider = make(profile, cloud);
    for (const changed of [{ next: '../other' }, { next: 'A'.repeat(32) }, { previous: 'bad' }, { previous: 'a'.repeat(32) },
      { proof: '' }, { version: 2 }, { extra: 'unknown field' }]) {
      const input = encoder.encode(JSON.stringify({ ...JSON.parse(decoder.decode(epoch())), ...changed }));
      await assert.rejects(provider.createPasswordEpoch(input), { code: 'CLOUD_INVALID_RESPONSE' });
    }
    await assert.rejects(provider.createPasswordEpoch(new Uint8Array(64 * 1024 + 1)), (cause) => ['CLOUD_CAPACITY', 'CLOUD_LIMIT'].includes(cause.code));
    assert.equal(cloud.calls.length, 0);
    assert.throws(() => provider.read('password-epoch-v1.json'), { code: 'CLOUD_INVALID_NAME' });
    assert.throws(() => provider.write('password-epoch-v1.json', epoch()), { code: 'CLOUD_INVALID_NAME' });
    const child = make({ ...profile, prefix: 'covelet/all-data-v1/blobs' }, cloud);
    await assert.rejects(child.readPasswordEpoch(), { code: 'CLOUD_INVALID_CONFIG' });
    await assert.rejects(child.createPasswordEpoch(epoch()), { code: 'CLOUD_INVALID_CONFIG' });
    assert.equal(cloud.calls.length, 0);
  });

  test(`${name} verifies even successful create acknowledgements and refuses unsupported primitives`, async () => {
    const corrupt = remote(profile, { corruptStored: true });
    await assert.rejects(make(profile, corrupt).createPasswordEpoch(epoch()), { code: 'CLOUD_CONFLICT' });
    const unsupported = remote(profile, { unsupported: 501 });
    await assert.rejects(make(profile, unsupported).createPasswordEpoch(epoch()), { code: 'CLOUD_EPOCH_UNSUPPORTED' });
    assert.equal(unsupported.controls.size, 0);
    assert.equal(unsupported.mutationBodies.length, 1, 'never retries using an unconditional update');
  });

  test(`${name} validates read controls and copies caller bytes before its first await`, async () => {
    const cloud = remote(profile), provider = make(profile, cloud), input = epoch(), original = input.slice();
    const pending = provider.createPasswordEpoch(input); input.fill(0); await pending;
    assert.deepEqual(await provider.readPasswordEpoch(), original);
    const url = [...cloud.controls.keys()][0]; cloud.controls.set(url, encoder.encode('{"unexpected":"foreign"}'));
    await assert.rejects(provider.readPasswordEpoch(), { code: 'CLOUD_INVALID_RESPONSE' });
    cloud.controls.set(url, new Uint8Array(64 * 1024 + 1));
    await assert.rejects(provider.readPasswordEpoch(), (cause) => ['CLOUD_CAPACITY', 'CLOUD_LIMIT'].includes(cause.code));
  });
}

test('OSS refuses control creation unless bucket overwrite protection has proven never-versioned semantics', async () => {
  for (const status of ['Enabled', 'Suspended']) {
    const cloud = remote(profiles.oss, { versioning: `<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>` });
    await assert.rejects(make(profiles.oss, cloud).createPasswordEpoch(epoch()), { code: 'CLOUD_OSS_VERSIONING' });
    assert.equal(cloud.mutationBodies.length, 0);
  }
});

test('generation control URL remains a bounded sibling for Unicode and existing key generations', async () => {
  for (const profile of Object.values(profiles)) {
    const config = { ...profile, prefix: `保存/Cove +/key-${'b'.repeat(32)}/all-data-v1` }, cloud = remote(config);
    await make(config, cloud).createPasswordEpoch(epoch('c'.repeat(32), 'b'.repeat(32)));
    const url = [...cloud.controls.keys()][0];
    assert.ok(decodeURIComponent(new URL(url).pathname).includes(`保存/Cove +/key-${'b'.repeat(32)}/password-epoch-v1.json`));
  }
});

function davDirectory(url) {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${new URL(url).pathname}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
}
test('WebDAV creates exactly key-id/all-data-v1/blobs below the selected existing user prefix', async () => {
  const calls = [], existing = new Set();
  const cloud = { fetcher: async (url, input) => {
    calls.push({ url, ...input });
    if (input.method === 'PROPFIND') return response(davDirectory(url), 207);
    assert.equal(input.method, 'MKCOL');
    if (existing.has(url)) return response('', 405);
    existing.add(url); return response('', 201);
  } };
  const provider = make(profiles.webdav, cloud), id = 'a'.repeat(32);
  await provider.ensurePasswordEpochDirectory(id);
  assert.deepEqual(calls.map((call) => call.url), [`${profiles.webdav.endpoint}covelet/key-${id}/`,
    `${profiles.webdav.endpoint}covelet/key-${id}/all-data-v1/`, `${profiles.webdav.endpoint}covelet/key-${id}/all-data-v1/blobs/`]);
  await provider.ensurePasswordEpochDirectory(id);
  assert.equal(calls.filter((call) => call.method === 'PROPFIND').length, 3, 'existing collections are verified, never overwritten');
  for (const invalid of ['../other', id.toUpperCase(), '', `${id}/child`]) assert.throws(() => provider.ensurePasswordEpochDirectory(invalid), { code: 'CLOUD_INVALID_CONFIG' });
  assert.ok(calls.every((call) => !call.url.includes('/all-data-v1/key-')));
});

test('WebDAV generation directory setup stops at a missing chosen parent and never creates arbitrary ancestors', async () => {
  const calls = [], cloud = { fetcher: async (url, input) => { calls.push({ url, ...input }); return response('', 409); } };
  await assert.rejects(make(profiles.webdav, cloud).ensurePasswordEpochDirectory('a'.repeat(32)), { code: 'CLOUD_NOT_FOUND' });
  assert.equal(calls.length, 1);
  const denied = { fetcher: async () => response('', 501) };
  await assert.rejects(make(profiles.webdav, denied).ensurePasswordEpochDirectory('a'.repeat(32)), { code: 'CLOUD_EPOCH_UNSUPPORTED' });
});
