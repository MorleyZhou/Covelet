import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CLOUD_SNAPSHOT_MAX_BYTES, cloudOrigin, createCloudProvider, isCloudProviderError, parseCloudSnapshotName, validateCloudConfig } from './cloud-providers.js';
import { createSyncWasm } from './sync-wasm.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const signer = { sha256: async (bytes) => hash(bytes), hmacSha256: async (key, bytes) => new Uint8Array(createHmac('sha256', key).update(bytes).digest()) };
const actor = '1234567890abcdef1234567890abcdef';
const payload = encoder.encode('{"version":1,"encrypted":"FAKE-CIPHERTEXT-ONLY"}');
const snapshot = (bytes = payload, clock = 1, installation = actor) => `covelet-${installation}-${clock}-${hash(bytes)}.json`;
const name = snapshot();
const r2 = { provider: 'r2', endpoint: 'https://fake-account.r2.cloudflarestorage.com', bucket: 'test-bucket', prefix: 'covelet' };
const oss = { provider: 'oss', endpoint: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com', bucket: 'test-bucket', region: 'cn-hangzhou', prefix: 'covelet' };
const github = { provider: 'github', owner: 'fake-owner', repo: 'private-sync', branch: 'sync/covelet', prefix: 'covelet' };
const gitlab = { provider: 'gitlab', endpoint: 'https://gitlab.com', project: 'fake-group/subgroup/private-sync', branch: 'sync/covelet', prefix: 'covelet' };
const fakeSecrets = { accessKeyId: 'FAKE-ACCESS-KEY', secretAccessKey: 'FAKE-SECRET-NOT-A-CREDENTIAL', token: 'FAKE-GITHUB-TOKEN' };
const fixedDate = new Date('2025-04-11T06:41:24Z');
const xmlEscape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function listing(entries = [], next, encoding = 'url') {
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${encoding ? `<EncodingType>${encoding}</EncodingType>` : ''}${entries.map(({ key, size = payload.length }) => `<Contents><Key>${xmlEscape(encoding === 'url' ? encodeURIComponent(key) : key)}</Key><Size>${size}</Size></Contents>`).join('')}${next ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>` : ''}</ListBucketResult>`;
}
function response(body = '', status = 200, headers) { return new Response(body, { status, headers }); }
function fakeQueue(results) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(results.length, 'unexpected additional cloud request');
    const next = results.shift();
    if (typeof next === 'function') return next(url, options);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetcher, results };
}
function provider(profile, queue, extra = {}, secrets = fakeSecrets) {
  return createCloudProvider(profile, secrets, { signer, fetcher: queue.fetcher, date: fixedDate, ...extra });
}
const codeIs = (code) => (error) => error.code === code;

test('normalizes only public profile fields and validates an exact HTTPS origin', () => {
  assert.deepEqual(validateCloudConfig({ ...r2, prefix: '/covelet/保存/', endpoint: `${r2.endpoint}/`, token: fakeSecrets.token }), { ...r2, prefix: 'covelet/保存' });
  assert.equal(cloudOrigin(github), 'https://api.github.com');
  assert.equal(cloudOrigin({ ...oss, endpoint: 'https://storage.example.com' }), 'https://storage.example.com');
  for (const endpoint of ['http://storage.example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'https://example.com/#hash']) assert.throws(() => validateCloudConfig({ ...r2, endpoint }), codeIs('CLOUD_INVALID_CONFIG'));
  for (const prefix of ['', '/', '../covelet', 'covelet/../other', 'covelet//other', 'x\\y', 'x\ny']) assert.throws(() => validateCloudConfig({ ...r2, prefix }), codeIs('CLOUD_INVALID_CONFIG'));
  for (const branch of ['refs/heads/main', 'main..other', '-main/', 'main.lock', 'main@{1}', 'main branch', 'main\\branch']) assert.throws(() => validateCloudConfig({ ...github, branch }), codeIs('CLOUD_INVALID_CONFIG'));
  assert.equal(validateCloudConfig({ ...github, branch: '功能/同步' }).branch, '功能/同步');
});

test('only accepts content-addressed filenames with positive safe clocks', () => {
  assert.deepEqual(parseCloudSnapshotName(name), { actor, clock: 1, digest: hash(payload) });
  for (const value of [name.replace('-1-', '-0-'), name.replace('-1-', '-01-'), snapshot(payload, Number.MAX_SAFE_INTEGER + 1), `../${name}`, name.toUpperCase(), 'covelet-a-1-' + 'a'.repeat(64) + '.json', null]) assert.equal(parseCloudSnapshotName(value), null);
});

test('R2 uses AWS4, encoded path-style keys, signed create conditions, and safe fetch options', async () => {
  const queue = fakeQueue([response('', 404), response('', 200)]);
  const profile = { ...r2, prefix: "保存/Cove + !'()" };
  await provider(profile, queue, {}, { ...fakeSecrets, sessionToken: 'FAKE-SESSION-TOKEN' }).write(name, payload);
  const put = queue.calls[1];
  assert.equal(put.method, 'PUT');
  assert.equal(new URL(put.url).pathname, `/test-bucket/%E4%BF%9D%E5%AD%98/Cove%20%2B%20%21%27%28%29/${name}`);
  assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=FAKE-ACCESS-KEY\/20250411\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[a-f0-9]{64}$/);
  assert.equal(put.headers['x-amz-content-sha256'], hash(payload));
  assert.equal(put.headers['x-amz-date'], '20250411T064124Z');
  assert.equal(put.headers['if-none-match'], '*');
  assert.equal(put.headers['x-amz-security-token'], 'FAKE-SESSION-TOKEN');
  assert.equal(Object.hasOwn(put.headers, 'host'), false, 'host is signed but not set as a forbidden browser header');
  assert.equal(Object.hasOwn(put.headers, 'content-length'), false);
  for (const call of queue.calls) {
    assert.equal(call.credentials, 'omit'); assert.equal(call.referrerPolicy, 'no-referrer'); assert.equal(call.referrer, ''); assert.equal(call.redirect, 'error'); assert.equal(call.cache, 'no-store');
    assert.equal(call.url.includes('FAKE'), false, 'credentials are never placed in URLs');
  }
  // Independently reconstruct the canonical request using the official AWS4
  // request shape, rather than reading internal adapter state.
  const canonical = `PUT\n${new URL(put.url).pathname}\n\ncontent-type:application/json\nhost:fake-account.r2.cloudflarestorage.com\nif-none-match:*\nx-amz-content-sha256:${hash(payload)}\nx-amz-date:20250411T064124Z\nx-amz-security-token:FAKE-SESSION-TOKEN\n\ncontent-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token\n${hash(payload)}`;
  let key = Buffer.from(`AWS4${fakeSecrets.secretAccessKey}`);
  for (const part of ['20250411', 'auto', 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n20250411T064124Z\n20250411/auto/s3/aws4_request\n${hash(canonical)}`).digest('hex');
  assert.ok(put.headers.authorization.endsWith(`Signature=${signature}`));
});

test('OSS native V4 signs bucket in canonical URI, UNSIGNED-PAYLOAD, and all x-oss headers', async () => {
  const queue = fakeQueue([response('', 404), response('<VersioningConfiguration/>'), response('', 200)]);
  await provider({ ...oss, endpoint: 'https://storage.example.com', prefix: '保存/界面' }, queue, {}, { ...fakeSecrets, sessionToken: 'FAKE-STS-TOKEN' }).write(name, payload);
  const put = queue.calls[2];
  assert.equal(new URL(put.url).pathname, `/%E4%BF%9D%E5%AD%98/%E7%95%8C%E9%9D%A2/${name}`);
  assert.equal(put.headers['x-oss-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.equal(put.headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(put.headers['if-none-match'], undefined, 'native OSS does not support conditional PUT');
  assert.equal(put.headers['x-oss-security-token'], 'FAKE-STS-TOKEN');
  const canonical = `PUT\n/test-bucket${new URL(put.url).pathname}\n\ncontent-type:application/json\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:20250411T064124Z\nx-oss-forbid-overwrite:true\nx-oss-security-token:FAKE-STS-TOKEN\n\n\nUNSIGNED-PAYLOAD`;
  let key = Buffer.from(`aliyun_v4${fakeSecrets.secretAccessKey}`);
  for (const part of ['20250411', 'cn-hangzhou', 'oss', 'aliyun_v4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(`OSS4-HMAC-SHA256\n20250411T064124Z\n20250411/cn-hangzhou/oss/aliyun_v4_request\n${hash(canonical)}`).digest('hex');
  assert.equal(put.headers.authorization, `OSS4-HMAC-SHA256 Credential=FAKE-ACCESS-KEY/20250411/cn-hangzhou/oss/aliyun_v4_request, Signature=${signature}`);
});

test('OSS documented canonical request hashes to the official test-vector digest', () => {
  // https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4/
  // The documentation labels its signing-key sample illustrative; this exact
  // published canonical-request SHA-256 is independently reproducible.
  const canonical = 'PUT\n/examplebucket/exampleobject\n\ncontent-disposition:attachment\ncontent-length:3\ncontent-md5:ICy5YqxZB1uWSwcVLSNLcA==\ncontent-type:text/plain\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:20250411T064124Z\n\ncontent-disposition;content-length\nUNSIGNED-PAYLOAD';
  assert.equal(hash(canonical), 'c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca');
});

test('OSS checks never-enabled versioning before every immutable create, including signed subresource query', async () => {
  for (const policy of ['<VersioningConfiguration/>', '<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"></VersioningConfiguration>']) {
    const queue = fakeQueue([response('', 404), response(policy), response('', 200)]);
    await provider(oss, queue).write(name, payload);
    assert.deepEqual(queue.calls.map(call => call.method), ['GET', 'GET', 'PUT']);
    const check = queue.calls[1], url = new URL(check.url);
    assert.equal(url.pathname, '/'); assert.equal(url.search, '?versioning');
    const canonical = 'GET\n/test-bucket/\nversioning\nx-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:20250411T064124Z\n\n\nUNSIGNED-PAYLOAD';
    let key = Buffer.from(`aliyun_v4${fakeSecrets.secretAccessKey}`);
    for (const part of ['20250411', 'cn-hangzhou', 'oss', 'aliyun_v4_request']) key = createHmac('sha256', key).update(part).digest();
    const signature = createHmac('sha256', key).update(`OSS4-HMAC-SHA256\n20250411T064124Z\n20250411/cn-hangzhou/oss/aliyun_v4_request\n${hash(canonical)}`).digest('hex');
    assert.ok(check.headers.authorization.endsWith(`Signature=${signature}`), 'versioning subresource has no equals sign in OSS V4 canonical query');
  }
});

test('OSS refuses enabled/suspended buckets and unconfirmed/malformed versioning without any PUT', async () => {
  for (const status of ['Enabled', 'Suspended']) {
    const queue = fakeQueue([response('', 404), response(`<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>`)]);
    await assert.rejects(provider(oss, queue).write(name, payload), codeIs('CLOUD_OSS_VERSIONING'));
    assert.deepEqual(queue.calls.map(call => call.method), ['GET', 'GET']);
  }
  for (const policy of ['', '{}', '<VersioningConfiguration><Status>Disabled</Status></VersioningConfiguration>', '<VersioningConfiguration Status="Enabled"/>', '<VersioningConfiguration><Unknown>enabled</Unknown></VersioningConfiguration>', '<!DOCTYPE x><VersioningConfiguration/>']) {
    const queue = fakeQueue([response('', 404), response(policy)]);
    await assert.rejects(provider(oss, queue).write(name, payload), codeIs('CLOUD_INVALID_RESPONSE'));
    assert.equal(queue.calls.some(call => call.method === 'PUT'), false);
  }
  for (const status of [401, 403]) {
    const queue = fakeQueue([response('', 404), response('PRIVATE bucket error', status)]);
    await assert.rejects(provider(oss, queue).write(name, payload), error => error.code === 'CLOUD_OSS_VERSIONING_CHECK' && !error.message.includes('PRIVATE'));
    assert.equal(queue.calls.some(call => call.method === 'PUT'), false);
  }
});

test('only adapter-created errors are marked safe for the controller boundary', async () => {
  const queue = fakeQueue([response('PRIVATE provider message', 401)]);
  await assert.rejects(provider(github, queue).read(name), error => isCloudProviderError(error));
  assert.equal(isCloudProviderError(Object.assign(Error('PRIVATE provider message'), { code: 'CLOUD_AUTH' })), false);
  assert.equal(isCloudProviderError('CLOUD_AUTH'), false);
});

test('R2 and OSS decode paged XML safely and only list our direct-child snapshot basenames', async () => {
  for (const profile of [r2, oss]) {
    const secondName = snapshot(payload, 2);
    const prefix = '保存/Cove +';
    const queue = fakeQueue([
      response(listing([{ key: `${prefix}/${name}` }, { key: `${prefix}/nested/${name}` }, { key: 'other/not-ours.json' }], 'token+/=&')),
      response(listing([{ key: `${prefix}/${secondName}` }, { key: `${prefix}/README.txt` }])),
    ]);
    const result = await provider({ ...profile, prefix }, queue).list();
    assert.deepEqual(result, [{ name, size: payload.length }, { name: secondName, size: payload.length }]);
    const second = new URL(queue.calls[1].url);
    assert.equal(second.searchParams.get('prefix'), `${prefix}/`);
    assert.equal(second.searchParams.get('continuation-token'), 'token+/=&');
    assert.ok(second.search.includes('continuation-token=token%2B%2F%3D%26'));
    assert.equal(second.search.includes('+'), false, 'SigV4 canonical queries encode spaces as %20');
    assert.equal(queue.calls[0].headers['content-length'], undefined);
  }
});

test('XML plain keys/entities are decoded without interpreting document resources', async () => {
  const prefix = 'Cove & 保存';
  const queue = fakeQueue([response(listing([{ key: `${prefix}/${name}` }], undefined, null))]);
  assert.deepEqual(await provider({ ...r2, prefix }, queue).list(), [{ name, size: payload.length }]);
  const unsafe = [
    '<!DOCTYPE x [<!ENTITY data SYSTEM "https://evil.invalid/x">]><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>&unknown;</Key><Size>1</Size></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>maybe</IsTruncated></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>%ZZ</Key><Size>1</Size></Contents><EncodingType>url</EncodingType></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>incomplete</Key></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount></ListBucketResult>',
  ];
  for (const xml of unsafe) await assert.rejects(provider(r2, fakeQueue([response(xml)])).list(), codeIs('CLOUD_INVALID_RESPONSE'));
});

test('duplicate continuation tokens, actor limits, and oversized object listings fail explicitly', async () => {
  const queue = fakeQueue([response(listing([], 'same')), response(listing([], 'same'))]);
  await assert.rejects(provider(r2, queue).list(), codeIs('CLOUD_INVALID_RESPONSE'));
  const actors = Array.from({ length: 101 }, (_, index) => ({ key: `covelet/${snapshot(payload, 1, index.toString(16).padStart(32, '0'))}` }));
  await assert.rejects(provider(oss, fakeQueue([response(listing(actors))])).list(), codeIs('CLOUD_LIMIT'));
  await assert.rejects(provider(r2, fakeQueue([response(listing([{ key: `covelet/${name}`, size: CLOUD_SNAPSHOT_MAX_BYTES + 1 }]))])).list(), codeIs('CLOUD_LIMIT'));
  const pages = Array.from({ length: 6 }, (_, page) => response(listing(Array.from({ length: page === 5 ? 1 : 1000 }, (_, index) => ({ key: `covelet/${snapshot(payload, page * 1000 + index + 1)}` })), page < 5 ? `page-${page + 1}` : undefined)));
  await assert.rejects(provider(r2, fakeQueue(pages)).list(), codeIs('CLOUD_LIMIT'));
});

test('GitHub lists exact file paths and refuses its unpageable 1,000-entry directory limit', async () => {
  const queue = fakeQueue([response(JSON.stringify([{ name, path: `covelet/${name}`, type: 'file', size: payload.length, download_url: 'https://evil.invalid/never-follow' }, { name: 'README.md', type: 'file' }]))]);
  assert.deepEqual(await provider(github, queue).list(), [{ name, size: payload.length }]);
  assert.equal(queue.calls.length, 1);
  assert.equal(new URL(queue.calls[0].url).searchParams.get('ref'), 'sync/covelet');
  await assert.rejects(provider(github, fakeQueue([response(JSON.stringify(Array.from({ length: 1000 }, () => ({ name: 'unrelated', type: 'dir' }))))])).list(), codeIs('CLOUD_LIMIT'));
  await assert.rejects(provider(github, fakeQueue([response(JSON.stringify([{ name, path: `other/${name}`, type: 'file', size: 1 }]))])).list(), codeIs('CLOUD_INVALID_RESPONSE'));
});

test('GitHub distinguishes a first-sync missing directory from inaccessible repo/branch', async () => {
  const queue = fakeQueue([response('{}', 404), response(JSON.stringify({ name: github.branch }))]);
  assert.deepEqual(await provider(github, queue).list(), []);
  assert.match(queue.calls[1].url, /\/branches\/sync%2Fcovelet$/);
  await assert.rejects(provider(github, fakeQueue([response('{}', 404), response('{}', 404)])).list(), codeIs('CLOUD_NOT_FOUND'));
  await assert.rejects(provider(github, fakeQueue([response('{}', 404), response('{"name":"wrong-branch"}')])).list(), codeIs('CLOUD_NOT_FOUND'));
});

test('all providers read bounded bytes, verify snapshot SHA-256, and never follow download URLs', async () => {
  for (const profile of [r2, oss, github]) {
    const queue = fakeQueue([response(payload)]);
    assert.deepEqual(await provider(profile, queue).read(name), payload);
    assert.equal(new URL(queue.calls[0].url).origin, cloudOrigin(profile));
    if (profile.provider === 'github') assert.equal(queue.calls[0].headers.accept, 'application/vnd.github.raw+json');
    await assert.rejects(provider(profile, fakeQueue([response('TAMPERED')])).read(name), codeIs('CLOUD_INTEGRITY'));
    const emptyQueue = fakeQueue([]);
    assert.throws(() => provider(profile, emptyQueue).read(`../${name}`), codeIs('CLOUD_INVALID_NAME'));
    assert.equal(emptyQueue.calls.length, 0);
  }
});

test('GitHub only creates immutable contents, encoding binary bytes as base64 and preserving the branch', async () => {
  const bytes = encoder.encode('{"密文":"本机加密后的数据"}');
  const queue = fakeQueue([response('{}', 404), response('{}', 201)]);
  await provider(github, queue).write(snapshot(bytes), bytes);
  const put = queue.calls[1];
  const body = JSON.parse(decoder.decode(put.body));
  assert.equal(Buffer.from(body.content, 'base64').toString(), decoder.decode(bytes));
  assert.equal(body.branch, 'sync/covelet');
  assert.equal(Object.hasOwn(body, 'sha'), false, 'no update of an existing GitHub file');
  assert.equal(new URL(put.url).search, '');
  assert.equal(put.headers.authorization, 'Bearer FAKE-GITHUB-TOKEN');
});

test('GitHub cleanup pins the index and blob reads and commits only exact obsolete index paths', async () => {
  const head = 'a'.repeat(40), next = 'd'.repeat(40);
  const prefix = 'covelet/all-data-v1', profile = { ...github, prefix };
  const queue = fakeQueue([
    Response.json({ name: profile.branch, commit: { sha: head } }),
    Response.json([{ name, path: `${prefix}/${name}`, type: 'file', size: payload.length }]),
    response(payload), response(payload), Response.json({ data: { createCommitOnBranch: { commit: { oid: next } } } }),
  ]);
  const indexes = provider(profile, queue), blobs = provider({ ...profile, prefix: `${prefix}/blobs` }, queue);
  assert.equal(blobs.pruneIndexes, undefined);
  assert.equal(await indexes.pinIndexes(), head);
  assert.deepEqual(await indexes.list(head), [{ name, size: payload.length }]);
  assert.deepEqual(await indexes.read(name, head), payload);
  assert.deepEqual(await blobs.read(name, head), payload);
  await indexes.pruneIndexes(head, [name]);
  const urls = queue.calls.map(call => new URL(call.url));
  assert.match(urls[0].pathname, /\/branches\/sync%2Fcovelet$/);
  assert.ok(urls.slice(1, 4).every(url => url.searchParams.get('ref') === head));
  assert.equal(queue.calls[4].method, 'POST');
  assert.equal(urls[4].href, 'https://api.github.com/graphql');
  const body = JSON.parse(decoder.decode(queue.calls[4].body));
  assert.match(body.query, /createCommitOnBranch/);
  assert.deepEqual(body.variables.input, {
    branch: { repositoryNameWithOwner: `${profile.owner}/${profile.repo}`, branchName: profile.branch },
    expectedHeadOid: head,
    fileChanges: { deletions: [{ path: `${prefix}/${name}` }] },
    message: { headline: 'Covelet remove obsolete encrypted sync indexes' },
  });
});

test('GitHub cleanup leaves a changed branch intact when the exact-head mutation is rejected', async () => {
  const head = 'a'.repeat(40), profile = { ...github, prefix: 'covelet/all-data-v1' };
  const queue = fakeQueue([Response.json({ data: { createCommitOnBranch: null }, errors: [{ message: 'Expected branch head has changed' }] })]);
  const indexes = provider(profile, queue);
  assert.throws(() => indexes.pruneIndexes(head, [`../${name}`]), codeIs('CLOUD_INVALID_NAME'));
  await assert.rejects(indexes.pruneIndexes(head, [name]), codeIs('CLOUD_INVALID_RESPONSE'));
  assert.deepEqual(queue.calls.map(call => call.method), ['POST']);
  assert.equal(JSON.parse(decoder.decode(queue.calls[0].body)).variables.input.expectedHeadOid, head);
});

test('GitHub cleanup rejects a mutation body exceeding the byte limit before making a request', () => {
  const prefix = `${'壁'.repeat(287)}/all-data-v1`, queue = fakeQueue([]);
  const names = Array.from({ length: 950 }, (_, index) => snapshot(payload, index + 1));
  assert.throws(() => provider({ ...github, prefix }, queue).pruneIndexes('a'.repeat(40), names), codeIs('CLOUD_LIMIT'));
  assert.equal(queue.calls.length, 0);
});

const gitSha = letter => letter.repeat(40);
const storageProfile = { ...github, prefix: 'covelet/all-data-v1' };
const githubNode = 'R_testRepository';
const gitBranch = (head = gitSha('a'), tree = gitSha('b')) => Response.json({ name: github.branch, commit: { sha: head, commit: { tree: { sha: tree } } } });
const gitRepo = () => Response.json({ full_name: `${github.owner}/${github.repo}`, node_id: githubNode });
const gitTree = (sha, tree, truncated = false) => Response.json({ sha, tree, truncated });
const gitEntry = (path, sha, type = 'tree') => ({ path, sha, type, mode: type === 'tree' ? '040000' : '100644', ...(type === 'blob' && { size: payload.length }) });
const gitBody = call => JSON.parse(decoder.decode(call.body));
const gitSeal = epoch => {
  const bytes = encoder.encode(`Covelet sync layout 2\n${epoch}\n`);
  return Response.json({ type: 'file', path: storageProfile.prefix, size: bytes.length, encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
};

test('GitHub probes the live layout and requires an exact seal marker at a pinned commit', async () => {
  const head = gitSha('a');
  const queue = fakeQueue([response('', 404), Response.json([]), gitSeal(name), gitSeal('../unrelated.txt'), response('', 503)]);
  const { githubStorage } = provider(storageProfile, queue);
  assert.deepEqual(await githubStorage.readLayout(), { layout: 'v1', epoch: null });
  assert.deepEqual(await githubStorage.readLayout(), { layout: 'v1', epoch: null });
  assert.deepEqual(await githubStorage.readLayout({ head }), { layout: 'v2', epoch: name });
  await assert.rejects(githubStorage.readLayout({ head }), codeIs('CLOUD_INVALID_RESPONSE'));
  await assert.rejects(githubStorage.readLayout({ head }), codeIs('CLOUD_NETWORK'));
  assert.deepEqual(queue.calls.map(call => new URL(call.url).searchParams.get('ref')), [github.branch, github.branch, head, head, head]);
});

test('GitHub lists exact Git trees and more than 100 distinct encrypted blob actors', async () => {
  const head = gitSha('a'), root = gitSha('b'), prefixTree = gitSha('c'), v2 = gitSha('d'), blobs = gitSha('e');
  const entries = Array.from({ length: 120 }, (_, i) => {
    const digest = hash(`blob-${i}`);
    return gitEntry(`covelet-${digest.slice(0, 32)}-1-${digest}.json`, gitSha('f'), 'blob');
  });
  const queue = fakeQueue([gitBranch(), gitRepo(), gitTree(root, [gitEntry('covelet', prefixTree), gitEntry('unrelated', gitSha('9'))]),
    gitTree(prefixTree, [gitEntry('all-data-v2', v2)]), gitTree(v2, [gitEntry(name, gitSha('8'), 'blob'), gitEntry('blobs', blobs)]), gitTree(blobs, entries)]);
  const { githubStorage } = provider(storageProfile, queue);
  const pin = await githubStorage.pin();
  assert.deepEqual(pin, { head, tree: root, repositoryId: githubNode });
  const files = await githubStorage.files(pin, 'v2');
  assert.deepEqual(files.indexes, [{ name, sha: gitSha('8'), size: payload.length }]);
  assert.equal(files.blobs.length, 120);
  assert.ok(queue.calls.every(call => call.method === 'GET'));
});

test('GitHub pins a detached commit by SHA without following the branch', async () => {
  const head = gitSha('a'), tree = gitSha('b');
  const queue = fakeQueue([Response.json({ sha: head, tree: { sha: tree } }), gitRepo(), Response.json({ sha: gitSha('c'), tree: { sha: tree } })]);
  const { githubStorage } = provider(storageProfile, queue);
  assert.deepEqual(await githubStorage.pin(head), { head, tree, repositoryId: githubNode });
  await assert.rejects(githubStorage.pin(head), codeIs('CLOUD_INVALID_RESPONSE'));
  assert.ok(queue.calls[0].url.endsWith(`/git/commits/${head}`));
});

test('GitHub stages unattached blobs, a v2 tree and a seal, then advances only the pinned branch', async () => {
  const head = gitSha('a'), root = gitSha('b'), prefixTree = gitSha('c'), v1 = gitSha('d'), nextTree = gitSha('e'), candidate = gitSha('f');
  const digest = hash(payload), blobName = snapshot(payload, 1, digest.slice(0, 32)), blobSha = gitSha('7');
  const queue = fakeQueue([gitBranch(), gitRepo(), Response.json({ sha: blobSha }, { status: 201 }),
    gitTree(root, [gitEntry('covelet', prefixTree)]), gitTree(prefixTree, [gitEntry('all-data-v1', v1)]), gitTree(v1, [gitEntry(name, gitSha('9'), 'blob')]),
    Response.json({ sha: nextTree }, { status: 201 }), Response.json({ sha: candidate, tree: { sha: nextTree }, parents: [{ sha: head }] }, { status: 201 }),
    Response.json({ data: { updateRefs: { clientMutationId: candidate } } })]);
  const { githubStorage } = provider(storageProfile, queue);
  const pin = await githubStorage.pin();
  assert.equal(await githubStorage.uploadBlob(payload), blobSha);
  assert.equal(await githubStorage.prepare(pin, { additions: [{ kind: 'index', name, sha: blobSha }, { kind: 'blob', name: blobName, sha: blobSha }],
    deletions: [{ kind: 'index', name: snapshot(payload, 2) }], seal: name }), candidate);
  assert.deepEqual(gitBody(queue.calls[2]), { content: Buffer.from(payload).toString('base64'), encoding: 'base64' });
  assert.deepEqual(gitBody(queue.calls[6]), { base_tree: root, tree: [
    { path: `covelet/all-data-v2/${name}`, mode: '100644', type: 'blob', sha: blobSha },
    { path: `covelet/all-data-v2/blobs/${blobName}`, mode: '100644', type: 'blob', sha: blobSha },
    { path: `covelet/all-data-v2/${snapshot(payload, 2)}`, mode: '100644', type: 'blob', sha: null },
    { path: storageProfile.prefix, mode: '100644', type: 'blob', content: `Covelet sync layout 2\n${name}\n` },
  ] });
  assert.deepEqual(gitBody(queue.calls[7]).parents, [head]);
  assert.equal(queue.calls.length, 8, 'preparation leaves the branch alone');
  await githubStorage.advance(pin, candidate);
  assert.equal(queue.calls[8].url, 'https://api.github.com/graphql');
  assert.deepEqual(gitBody(queue.calls[8]).variables.input, { repositoryId: githubNode, clientMutationId: candidate,
    refUpdates: [{ name: `refs/heads/${github.branch}`, beforeOid: head, afterOid: candidate, force: false }] });
});

test('GitHub refuses to seal a foreign v1 file or an incomplete tree without preparing a commit', async () => {
  const root = gitSha('b'), prefixTree = gitSha('c'), v1 = gitSha('d');
  for (const leaf of [gitTree(v1, [gitEntry('unrelated.txt', gitSha('e'), 'blob')]), gitTree(v1, [], true)]) {
    const queue = fakeQueue([gitTree(root, [gitEntry('covelet', prefixTree)]), gitTree(prefixTree, [gitEntry('all-data-v1', v1)]), leaf]);
    const { githubStorage } = provider(storageProfile, queue);
    await assert.rejects(githubStorage.prepare({ head: gitSha('a'), tree: root }, { seal: name }));
    assert.deepEqual(queue.calls.map(call => call.method), ['GET', 'GET', 'GET']);
  }
});

test('GitHub rejects changed exact heads and keeps a server outage retryable', async () => {
  const candidate = gitSha('c');
  const queue = fakeQueue([gitBranch(), gitRepo(), Response.json({ errors: [{ message: 'stale' }] }), gitBranch(gitSha('d')), response('', 503)]);
  const { githubStorage } = provider(storageProfile, queue);
  const pin = await githubStorage.pin();
  await assert.rejects(githubStorage.advance(pin, candidate), codeIs('CLOUD_STALE_HEAD'));
  await assert.rejects(githubStorage.advance(pin, candidate), codeIs('CLOUD_NETWORK'));
});

test('identical existing files are idempotent without PUT, but mismatched files are preserved', async () => {
  for (const profile of [r2, oss, github]) {
    const queue = fakeQueue([response(payload)]);
    await provider(profile, queue).write(name, payload);
    assert.deepEqual(queue.calls.map((call) => call.method), ['GET']);
    const collision = fakeQueue([response('DIFFERENT CONTENT')]);
    await assert.rejects(provider(profile, collision).write(name, payload), codeIs('CLOUD_CONFLICT'));
    assert.equal(collision.calls.length, 1);
    const noCalls = fakeQueue([]);
    await assert.rejects(provider(profile, noCalls).write(name, encoder.encode('wrong hash')), codeIs('CLOUD_INTEGRITY'));
    assert.equal(noCalls.calls.length, 0);
  }
});

test('racing creates reconcile by bytes after R2 412, OSS 409, and GitHub 422', async () => {
  for (const [profile, status] of [[r2, 412], [oss, 409], [github, 422]]) {
    const policy = () => profile.provider === 'oss' ? [response('<VersioningConfiguration/>')] : [];
    const queue = fakeQueue([response('', 404), ...policy(), response('{}', status), response(payload)]);
    await provider(profile, queue).write(name, payload);
    assert.deepEqual(queue.calls.map((call) => call.method), profile.provider === 'oss' ? ['GET', 'GET', 'PUT', 'GET'] : ['GET', 'PUT', 'GET']);
    const collision = fakeQueue([response('', 404), ...policy(), response('{}', status), response('BAD EXISTING BYTES')]);
    await assert.rejects(provider(profile, collision).write(name, payload), codeIs('CLOUD_CONFLICT'));
  }
  await assert.rejects(provider(github, fakeQueue([response('', 404), response('{}', 422), response('', 404)])).write(name, payload), codeIs('CLOUD_REQUEST_FAILED'), '422 validation is not automatically a conflict');
});

test('an unknown write outcome is safely retried by checking the same immutable file', async () => {
  const queue = fakeQueue([response('', 404), new TypeError('FAKE-SECRET-NOT-A-CREDENTIAL'), response(payload)]);
  const cloud = provider(r2, queue);
  await assert.rejects(cloud.write(name, payload), codeIs('CLOUD_NETWORK'));
  await cloud.write(name, payload);
  assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'PUT', 'GET']);
});

test('timeouts cover the full operation even when a fake transport ignores abort', async () => {
  const queue = fakeQueue([() => new Promise(() => {})]);
  const before = Date.now();
  await assert.rejects(provider(r2, queue, { timeoutMs: 15 }).read(name), codeIs('CLOUD_TIMEOUT'));
  assert.ok(Date.now() - before < 1000);
  assert.equal(queue.calls[0].signal.aborted, true);
});

test('response size bounds apply to advertised size, streamed bytes, and decoded snapshot size', async () => {
  await assert.rejects(provider(r2, fakeQueue([response('', 200, { 'content-length': String(1024 * 1024 + 1) })])).read(name), codeIs('CLOUD_LIMIT'));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } });
  await assert.rejects(provider(r2, fakeQueue([response(stream)])).read(name), codeIs('CLOUD_LIMIT'));
  await assert.rejects(provider(r2, fakeQueue([response(new Uint8Array(CLOUD_SNAPSHOT_MAX_BYTES + 1))])).read(name), codeIs('CLOUD_LIMIT'));
});

test('redirected and wrong-origin responses fail without any follow-up request', async () => {
  for (const property of [{ key: 'url', value: 'https://evil.invalid/steal' }, { key: 'redirected', value: true }]) {
    const remote = response(payload);
    Object.defineProperty(remote, property.key, { value: property.value });
    const queue = fakeQueue([remote]);
    await assert.rejects(provider(r2, queue).read(name), codeIs('CLOUD_REDIRECT'));
    assert.equal(queue.calls.length, 1);
  }
});

test('provider errors never expose credentials, remote XML, URLs, or arbitrary transport messages', async () => {
  const server = `<Error><Message>${fakeSecrets.secretAccessKey}</Message><StringToSign>PRIVATE-SIGNING-INPUT</StringToSign></Error>`;
  for (const result of [response(server, 403), Object.assign(new Error(fakeSecrets.token), { code: 'CLOUD_FAKE' })]) {
    const queue = fakeQueue([result]);
    await assert.rejects(provider(r2, queue).read(name), (error) => {
      assert.equal(error.message.includes('FAKE'), false);
      assert.equal(error.message.includes('PRIVATE'), false);
      assert.equal(error.message.includes('http'), false);
      return ['CLOUD_AUTH', 'CLOUD_NETWORK'].includes(error.code);
    });
  }
  await assert.rejects(provider(github, fakeQueue([response('{}', 403, { 'x-ratelimit-remaining': '0' })])).list(), codeIs('CLOUD_RATE_LIMIT'));
});

test('invalid credential headers are rejected before the first request and bytes are copied before signing', async () => {
  const queue = fakeQueue([]);
  assert.throws(() => provider(github, queue, {}, { token: 'FAKE\nInjected: value' }), codeIs('CLOUD_CREDENTIALS'));
  assert.equal(queue.calls.length, 0);
  const bytes = new Uint8Array(payload);
  const putQueue = fakeQueue([response('', 404), response('', 200)]);
  const promise = provider(r2, putQueue).write(name, bytes);
  bytes.fill(0);
  await promise;
  assert.deepEqual(putQueue.calls[1].body, payload);
});

test('packaged sync WASM interoperates with R2, native OSS V4, GitHub and GitLab adapters', async () => {
  const wasm = await createSyncWasm(await readFile(new URL('../wasm/sync-core.wasm', import.meta.url)));
  for (const profile of [r2, oss, github, gitlab]) {
    const policy = () => profile.provider === 'oss' ? [response('<VersioningConfiguration/>')] : [];
    const normal = fakeQueue([response('', 404), ...policy(), response('{}', ['github', 'gitlab'].includes(profile.provider) ? 201 : 200), response(payload)]);
    const compiled = fakeQueue([response('', 404), ...policy(), response('{}', ['github', 'gitlab'].includes(profile.provider) ? 201 : 200), response(payload)]);
    await provider(profile, normal).write(name, payload);
    const runtime = provider(profile, compiled, { signer: wasm });
    await runtime.write(name, payload);
    assert.deepEqual(await runtime.read(name), payload);
    const putIndex = profile.provider === 'oss' ? 2 : 1;
    assert.deepEqual(compiled.calls[putIndex].headers, normal.calls[putIndex].headers, 'real bundled WASM signatures match Node crypto reference');
  }
});

for (const profile of [r2, oss, github, gitlab]) {
  test(`${profile.provider} preserves HTTP failure codes without exposing remote text or blindly retrying`, async () => {
    const privateBody = JSON.stringify({ message: 'SYNTHETIC PRIVATE SERVER TEXT', token: fakeSecrets.token });
    for (const [status, expected] of [[401, 'CLOUD_AUTH'], [403, 'CLOUD_AUTH'], [404, 'CLOUD_NOT_FOUND'], [429, 'CLOUD_RATE_LIMIT'], [500, 'CLOUD_REQUEST_FAILED'], [503, 'CLOUD_REQUEST_FAILED']]) {
      const queue = fakeQueue([response(privateBody, status)]);
      await assert.rejects(provider(profile, queue).read(name), error => {
        assert.equal(error.code, expected);
        assert.doesNotMatch(error.message, /SYNTHETIC|FAKE|SERVER TEXT|http/);
        return true;
      });
      assert.equal(queue.calls.length, 1, 'a failed read must not trigger a write or unbounded automatic retry');
    }
    const write = fakeQueue([response('', 404), ...(profile.provider === 'oss' ? [response('<VersioningConfiguration/>')] : []), response(privateBody, 403)]);
    await assert.rejects(provider(profile, write).write(name, payload), codeIs('CLOUD_AUTH'));
    assert.deepEqual(write.calls.map(call => call.method), profile.provider === 'oss' ? ['GET', 'GET', 'PUT'] : ['GET', profile.provider === 'gitlab' ? 'POST' : 'PUT']);
    for (const status of [401, 403, 429, 503]) {
      const listing = fakeQueue([response(privateBody, status)]);
      await assert.rejects(provider(profile, listing).list(), codeIs(status === 429 ? 'CLOUD_RATE_LIMIT' : status === 503 ? 'CLOUD_REQUEST_FAILED' : 'CLOUD_AUTH'));
      assert.equal(listing.calls.length, 1, 'an auth/rate-limit error must not be interpreted as an empty directory');
    }
  });
}

test('GitLab profiles normalize project IDs and namespace paths without retaining credentials', () => {
  assert.deepEqual(validateCloudConfig({ ...gitlab, token: fakeSecrets.token }), gitlab);
  assert.deepEqual(validateCloudConfig({ ...gitlab, endpoint: undefined, project: 13083 }), { ...gitlab, project: '13083' });
  assert.equal(cloudOrigin({ ...gitlab, endpoint: 'https://git.example.com' }), 'https://git.example.com');
  for (const project of ['', '0', 'group', '../repo', 'group/../repo', 'group//repo', 'https://gitlab.com/group/repo', 'group/repo?token=x']) assert.throws(() => validateCloudConfig({ ...gitlab, project }), codeIs('CLOUD_INVALID_CONFIG'));
  assert.throws(() => validateCloudConfig({ ...gitlab, branch: 'HEAD' }), codeIs('CLOUD_INVALID_CONFIG'));
  assert.throws(() => validateCloudConfig({ ...gitlab, endpoint: 'https://git.example.com/gitlab' }), codeIs('CLOUD_INVALID_CONFIG'));
});

function gitlabTree(start = 1, count = 1, prefix = 'covelet') {
  return Array.from({ length: count }, (_, index) => {
    const name = snapshot(payload, start + index);
    return { id: 'a'.repeat(40), name, path: `${prefix}/${name}`, type: 'blob', mode: '100644' };
  });
}

test('GitLab paginates a nonrecursive tree with encoded subgroup project and branch paths', async () => {
  const prefix = '保存/Cove +';
  const queue = fakeQueue([
    response(JSON.stringify(gitlabTree(1, 100, prefix)), 200, { 'x-page': '1', 'x-next-page': '2', 'x-total': '101', 'x-total-pages': '2' }),
    response(JSON.stringify(gitlabTree(101, 1, prefix)), 200, { 'x-page': '2', 'x-next-page': '', 'x-total': '101', 'x-total-pages': '2' }),
  ]);
  const result = await provider({ ...gitlab, prefix }, queue).list();
  assert.equal(result.length, 101);
  assert.deepEqual(result.find((item) => item.name === name), { name });
  const first = new URL(queue.calls[0].url);
  assert.equal(first.origin, 'https://gitlab.com');
  assert.equal(first.pathname, '/api/v4/projects/fake-group%2Fsubgroup%2Fprivate-sync/repository/tree');
  assert.equal(first.searchParams.get('path'), prefix);
  assert.equal(first.searchParams.get('ref'), 'sync/covelet');
  assert.equal(first.searchParams.get('recursive'), 'false');
  assert.equal(first.searchParams.get('per_page'), '100');
  assert.equal(new URL(queue.calls[1].url).searchParams.get('page'), '2');
  assert.equal(queue.calls[0].headers['private-token'], fakeSecrets.token);
  assert.equal(queue.calls.some((call) => call.url.includes('FAKE')), false);
});

test('GitLab probes full pages when pagination headers are unavailable and respects declared complete pages', async () => {
  const probe = fakeQueue([response(JSON.stringify(gitlabTree(1, 100))), response('[]')]);
  assert.equal((await provider(gitlab, probe).list()).length, 100);
  assert.equal(probe.calls.length, 2);
  const declared = fakeQueue([response(JSON.stringify(gitlabTree(1, 100)), 200, { 'x-next-page': '', 'x-total-pages': '1', 'x-total': '100' })]);
  assert.equal((await provider(gitlab, declared).list()).length, 100);
  assert.equal(declared.calls.length, 1);
});

test('GitLab accepts both empty-page conventions only after verifying the configured branch', async () => {
  for (const headers of [{}, { 'x-page': '1', 'x-next-page': '', 'x-total': '0', 'x-total-pages': '0' }, { 'x-total-pages': '0' }, { 'x-total': '0', 'x-total-pages': '1' }]) {
    const queue = fakeQueue([response('[]', 200, headers), response(JSON.stringify({ name: gitlab.branch }))]);
    assert.deepEqual(await provider(gitlab, queue).list(), []);
    assert.equal(queue.calls.length, 2);
    assert.match(queue.calls[1].url, /\/repository\/branches\/sync%2Fcovelet$/);
  }
  for (const [branchBody, status, code] of [['{}', 404, 'CLOUD_NOT_FOUND'], ['{"name":"other"}', 200, 'CLOUD_NOT_FOUND'], ['{}', 403, 'CLOUD_AUTH']]) {
    const queue = fakeQueue([response('[]', 200, { 'x-total': '0', 'x-total-pages': '0' }), response(branchBody, status)]);
    await assert.rejects(provider(gitlab, queue).list(), codeIs(code));
  }
});

test('GitLab rejects pagination loops, skipped pages, inconsistent totals, nested entries and symlinks', async () => {
  const invalidPages = [
    [gitlabTree(1, 100), { 'x-next-page': '1' }],
    [gitlabTree(1, 100), { 'x-next-page': '3' }],
    [gitlabTree(1, 1), { 'x-next-page': '2' }],
    [gitlabTree(1, 1), { 'x-total': '5' }],
    [gitlabTree(1, 1), { 'x-total-pages': '0' }],
    [[], { 'x-total-pages': '0', 'x-total': '1' }],
    [[], { 'x-total-pages': '0', 'x-next-page': '2' }],
    [[], { 'x-total-pages': '00' }],
    [[], { 'x-total-pages': 'NaN' }],
    [[], { 'x-total-pages': '0', 'x-page': '2' }],
    [[{ ...gitlabTree()[0], path: `covelet/nested/${name}` }], {}],
    [[{ ...gitlabTree()[0], mode: '120000' }], {}],
    [gitlabTree(1, 101), {}],
  ];
  for (const [entries, headers] of invalidPages) await assert.rejects(provider(gitlab, fakeQueue([response(JSON.stringify(entries), 200, headers)])).list(), codeIs('CLOUD_INVALID_RESPONSE'));
  const repeated = fakeQueue([response(JSON.stringify(gitlabTree(1, 100))), response(JSON.stringify(gitlabTree(1, 1)))]);
  await assert.rejects(provider(gitlab, repeated).list(), codeIs('CLOUD_INVALID_RESPONSE'));
  const zeroSecondPage = fakeQueue([response(JSON.stringify(gitlabTree(1, 100))), response('[]', 200, { 'x-page': '2', 'x-total-pages': '0' })]);
  await assert.rejects(provider(gitlab, zeroSecondPage).list(), codeIs('CLOUD_INVALID_RESPONSE'));
  await assert.rejects(provider(gitlab, fakeQueue([response('[]', 200, { 'x-total': '5001' })])).list(), codeIs('CLOUD_LIMIT'));
});

test('GitLab verifies branch visibility before treating a missing directory as empty', async () => {
  const queue = fakeQueue([response('{}', 404), response(JSON.stringify({ name: gitlab.branch }))]);
  assert.deepEqual(await provider(gitlab, queue).list(), []);
  assert.match(queue.calls[1].url, /\/repository\/branches\/sync%2Fcovelet$/);
  await assert.rejects(provider(gitlab, fakeQueue([response('{}', 404), response('{}', 404)])).list(), codeIs('CLOUD_NOT_FOUND'));
  await assert.rejects(provider(gitlab, fakeQueue([response('{}', 404), response('{"name":"other"}')])).list(), codeIs('CLOUD_NOT_FOUND'));
});

test('GitLab uses raw reads and POST-only base64 creates, with no file update or download URL', async () => {
  const bytes = encoder.encode('{"密文":"经过本机加密"}');
  const queue = fakeQueue([response(bytes), response('', 404), response('{}', 201)]);
  const runtime = provider({ ...gitlab, project: '13083', endpoint: 'https://git.example.com' }, queue);
  assert.deepEqual(await runtime.read(snapshot(bytes)), bytes);
  await runtime.write(snapshot(bytes), bytes);
  const raw = new URL(queue.calls[0].url);
  assert.equal(raw.pathname, `/api/v4/projects/13083/repository/files/covelet%2F${snapshot(bytes)}/raw`);
  assert.equal(raw.searchParams.get('ref'), gitlab.branch);
  const post = queue.calls[2];
  assert.equal(post.method, 'POST');
  const body = JSON.parse(decoder.decode(post.body));
  assert.equal(body.branch, gitlab.branch);
  assert.equal(body.encoding, 'base64');
  assert.equal(Buffer.from(body.content, 'base64').toString(), decoder.decode(bytes));
  assert.equal(body.commit_message, 'Covelet encrypted sync snapshot');
  assert.equal(Object.hasOwn(body, 'start_branch'), false);
  assert.equal(Object.hasOwn(body, 'last_commit_id'), false);
  assert.ok(queue.calls.every((call) => new URL(call.url).origin === 'https://git.example.com'));
  assert.ok(queue.calls.every((call) => call.credentials === 'omit' && call.redirect === 'error'));
});

test('GitLab racing creates reconcile 400/409 only when the existing immutable content matches', async () => {
  for (const status of [400, 409]) {
    const queue = fakeQueue([response('', 404), response('{"message":"FAKE-PRIVATE-ERROR"}', status), response(payload)]);
    await provider(gitlab, queue).write(name, payload);
    assert.deepEqual(queue.calls.map((call) => call.method), ['GET', 'POST', 'GET']);
    const collision = fakeQueue([response('', 404), response('{}', status), response('CORRUPT')]);
    await assert.rejects(provider(gitlab, collision).write(name, payload), codeIs('CLOUD_CONFLICT'));
  }
  await assert.rejects(provider(gitlab, fakeQueue([response('', 404), response('{}', 400), response('', 404)])).write(name, payload), codeIs('CLOUD_REQUEST_FAILED'));
  await assert.rejects(provider(gitlab, fakeQueue([response('TAMPERED')])).read(name), codeIs('CLOUD_INTEGRITY'));
});

test('beforeRequest guards every actual I/O and preserves locked/permission codes without leaking guard messages', async () => {
  for (const profile of [r2, oss, github, gitlab]) {
    let allowed = true;
    let checks = 0;
    const queue = fakeQueue([() => { allowed = false; return response('', 404); }]);
    const beforeRequest = async () => { checks++; if (!allowed) throw Object.assign(new Error(fakeSecrets.token), { code: 'CLOUD_LOCKED' }); };
    await assert.rejects(provider(profile, queue, { beforeRequest }).write(name, payload), (error) => error.code === 'CLOUD_LOCKED' && !error.message.includes('FAKE'));
    assert.equal(checks, 2, 'guard reruns between existence GET and create');
    assert.deepEqual(queue.calls.map((call) => call.method), ['GET'], 'lock during GET prevents a later PUT/POST');
    const denied = fakeQueue([]);
    await assert.rejects(provider(profile, denied, { beforeRequest: async () => { throw { code: 'CLOUD_PERMISSION', message: fakeSecrets.secretAccessKey }; } }).list(), codeIs('CLOUD_PERMISSION'));
    assert.equal(denied.calls.length, 0);
  }
});

test('unified provider entry points dispatch path-bearing WebDAV profiles and pass the request guard', async () => {
  const webdav = { provider: 'webdav', endpoint: 'https://dav.example.com/remote.php/dav/files/account/', prefix: 'covelet' };
  assert.deepEqual(validateCloudConfig({ ...webdav, token: 'not-saved' }), webdav);
  assert.equal(cloudOrigin(webdav), 'https://dav.example.com');
  const queue = fakeQueue([response(payload)]);
  let checks = 0;
  const runtime = provider(webdav, queue, { beforeRequest: async () => { checks++; } }, { username: 'fake-user', appPassword: 'FAKE-APP-PASSWORD' });
  assert.deepEqual(await runtime.read(name), payload);
  assert.equal(checks, 1);
  assert.equal(new URL(queue.calls[0].url).pathname, `/remote.php/dav/files/account/covelet/${name}`);
  const blocked = fakeQueue([]);
  await assert.rejects(provider(webdav, blocked, { beforeRequest: async () => { throw { code: 'CLOUD_LOCKED' }; } }, { username: 'fake-user', appPassword: 'FAKE-APP-PASSWORD' }).read(name), codeIs('CLOUD_LOCKED'));
  assert.equal(blocked.calls.length, 0);
});
