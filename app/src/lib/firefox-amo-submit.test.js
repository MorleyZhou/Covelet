import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { createAmoJwt, inspectAmoInputs, submitFirefoxAmo, runAmoCli, amoFailureSummary } from '../../scripts/submit-firefox-amo.mjs';

// Production AMO FileUploadSerializer declares UUIDField(format='hex').
const guid = 'covelet@morleyzhou.github.io', versionString = '0.7.0', uploadId = '1234567812344234a234123456789012';
const metadata = { addon: { name: { 'en-US': 'Covelet' }, summary: { 'en-US': 'Private new tab' }, default_locale: 'en-US', categories: { firefox: ['tabs', 'bookmarks'] }, support_url: { 'en-US': 'https://github.com/MorleyZhou/Covelet/issues' } },
  version: { license: 'MIT', compatibility: ['firefox'], release_notes: { 'en-US': 'Record merge and Firefox.' }, approval_notes: 'Build instructions in source.' }, policy: { privacy_policy: { 'en-US': 'Local data. No account, telemetry, ads or server.' } } };
function inputs() {
  return { zip: zipSync({ 'manifest.json': strToU8(JSON.stringify({ version: versionString, browser_specific_settings: { gecko: { id: guid } } })) }),
    source: zipSync({ 'app/package.json': strToU8('{"version":"0.7.0"}'), 'README.md': strToU8('Reproducible source') }), metadata: structuredClone(metadata), issuer: 'user:123:45', secret: 'fixture-secret-never-print' };
}
function fixture({ existing = false, listedVersion = false, uploadUuid = uploadId } = {}) {
  const input = inputs(), calls = [], receipts = [];
  let addon = existing ? addonValue() : null, ver = listedVersion ? versionValue(true) : null;
  const hooks = { onRequest: null, lostCreate: false, sourceFailure: false, policyFailure: false, invalidUpload: false, neverProcessed: false };
  function addonValue() { return { id: 101, guid, status: 'nominated', url: 'https://addons.mozilla.org/en-US/firefox/addon/covelet/' }; }
  function versionValue(hasSource) { return { id: 202, version: versionString, channel: 'listed', source: hasSource ? 'https://addons.mozilla.org/private-source/?private=not-for-receipts' : null,
    is_source_editable: true, edit_url: 'https://addons.mozilla.org/en-US/developers/addon/covelet/versions/202', file: { status: 'unreviewed', hash: `sha256:${inspectAmoInputs(input.zip, input.source, input.metadata).zipSha256}` } }; }
  function upload(processed = true) { return { uuid: uploadUuid, processed, valid: !hooks.invalidUpload, submitted: false, version: versionString, channel: 'listed', validation: { errors: hooks.invalidUpload ? 1 : 0, warnings: 2, messages: [{ type: 'warning', message: input.secret }] } }; }
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  async function fetch(url, options) {
    const path = new URL(url).pathname.replace('/api/v5/', ''), method = options.method;
    calls.push({ path, ...options });
    assert.equal(new URL(url).origin, 'https://addons.mozilla.org'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.match(options.headers.Authorization, /^JWT [A-Za-z0-9_.-]+$/u);
    if (hooks.onRequest) { const intercepted = await hooks.onRequest({ path, options, reply }); if (intercepted) return intercepted; }
    if (path === 'addons/upload/' && method === 'POST') return reply(upload(false), 201);
    if (path === `addons/upload/${uploadUuid}/`) return reply(upload(!hooks.neverProcessed));
    if (path === 'addons/addon/' && method === 'POST') {
      const body = JSON.parse(options.body); assert.equal(body.version.upload, uploadUuid); assert.equal(body.version.source, undefined);
      addon = addonValue(); ver = versionValue(false);
      if (hooks.lostCreate) throw new Error(`lost response ${input.secret}`);
      return reply({ ...addon, version: ver }, 201);
    }
    if (/^addons\/addon\/[^/]+\/$/u.test(path)) {
      if (!addon) return reply({}, 404);
      if (method === 'PATCH') Object.assign(addon, JSON.parse(options.body));
      return reply(addon);
    }
    if (path === 'addons/addon/101/versions/' && method === 'POST') {
      assert(options.body instanceof FormData); assert.equal(options.body.get('upload'), uploadUuid); assert.equal(options.body.get('license'), 'MIT');
      assert.deepEqual(new Uint8Array(await options.body.get('source').arrayBuffer()), input.source);
      ver = versionValue(true); return reply(ver, 201);
    }
    if (/^addons\/addon\/101\/versions\/(?:v0\.7\.0|202)\/$/u.test(path)) {
      if (!ver) return reply({}, 404);
      if (method === 'PATCH' && options.body instanceof FormData) {
        if (hooks.sourceFailure) return reply({ secret: input.secret }, 503);
        assert.deepEqual(new Uint8Array(await options.body.get('source').arrayBuffer()), input.source);
        ver.source = 'https://addons.mozilla.org/private-source/?signature=private';
      }
      return reply(ver);
    }
    if (path === 'addons/addon/101/eula_policy/' && method === 'PATCH') {
      if (hooks.policyFailure) return reply({ echo: input.secret }, 400);
      assert.deepEqual(JSON.parse(options.body), input.metadata.policy); return reply(input.metadata.policy);
    }
    throw new Error(`Unexpected fixture endpoint ${method} ${path}`);
  }
  const options = { fetch, sleep: async () => {}, writeReceipt: async receipt => receipts.push(structuredClone(receipt)), now: () => 1700000000123, maxPolls: 2 };
  return { input, calls, receipts, hooks, options, run: extra => submitFirefoxAmo({ ...input, ...extra }, options), get version() { return ver; }, get addon() { return addon; } };
}

test('AMO HS256 JWT uses issuer, unique nonce and a short UTC expiry with a valid signature', () => {
  const first = createAmoJwt('user:123:45', 'secret', { now: () => 1700000000123 }), second = createAmoJwt('user:123:45', 'secret', { now: () => 1700000000123 });
  const [header, body, signature] = first.split('.'), claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.equal(claims.iss, 'user:123:45'); assert.equal(claims.iat, 1700000000); assert.equal(claims.exp - claims.iat, 60);
  assert.notEqual(first, second); assert.equal(signature, createHmac('sha256', 'secret').update(`${header}.${body}`).digest('base64url'));
});

test('missing credentials and malformed metadata/archive stop before any request', async () => {
  const f = fixture();
  await assert.rejects(f.run({ secret: '' }), { code: 'AMO_CREDENTIALS_REQUIRED' });
  await assert.rejects(f.run({ metadata: { ...metadata, channel: 'unlisted' } }), { code: 'AMO_METADATA_INVALID' });
  await assert.rejects(f.run({ zip: strToU8('not a ZIP') }), { code: 'AMO_ARCHIVE_INVALID' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(runAmoCli(['--zip', 'x', '--source', 'y', '--metadata', 'z', '--receipt', 'r'], {}), { code: 'AMO_CREDENTIALS_REQUIRED' });
});

test('repository AMO metadata matches the exact supported envelope', async () => {
  const file = JSON.parse(await readFile(new URL('../../../docs/store/firefox-amo.json', import.meta.url), 'utf8'));
  const f = inputs(); assert.equal(inspectAmoInputs(f.zip, f.source, file).requestedVersion, '0.7.0');
});

test('first listed addon validates, separately PATCHes source and policy, and reports review as pending', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.result, 'submitted'); assert.equal(result.completed, true); assert.equal(result.fileStatus, 'unreviewed'); assert.equal(result.publication, 'not-confirmed');
  assert.deepEqual(result.validation, { processed: true, valid: true, errors: 0, warnings: 2 });
  assert.equal(result.sourceUploaded, true); assert.equal(result.policyUpdated, true);
  assert.equal(f.calls.filter(call => call.path === 'addons/addon/' && call.method === 'POST').length, 1);
  const sourceIndex = f.calls.findIndex(call => call.method === 'PATCH' && call.body instanceof FormData), policyIndex = f.calls.findIndex(call => call.path.endsWith('eula_policy/'));
  assert(sourceIndex > 0 && policyIndex > sourceIndex);
  const receipts = JSON.stringify(f.receipts); assert(!receipts.includes(f.input.secret)); assert(!receipts.includes('private-source')); assert(!receipts.includes('signature='));
  const tokens = f.calls.map(call => call.headers.Authorization); assert.equal(new Set(tokens).size, tokens.length);
});

test('production 32-hex and canonical UUID upload IDs both poll and submit unchanged', async () => {
  for (const value of [uploadId, '12345678-1234-4234-a234-123456789012']) {
    const f = fixture({ uploadUuid: value }), result = await f.run();
    assert.equal(result.completed, true); assert.equal(result.uploadUuid, value);
    assert(f.calls.some(call => call.path === `addons/upload/${value}/` && call.method === 'GET'));
  }
});

test('a retained production 32-hex upload is polled without another upload POST', async () => {
  const f = fixture(); f.hooks.invalidUpload = true;
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.receipt.uploadUuid, uploadId); assert.equal(error.receipt.versionId, null);
  f.hooks.invalidUpload = false;
  const before = f.calls.length, result = await f.run({ previousReceipt: error.receipt });
  assert.equal(result.completed, true);
  assert(!f.calls.slice(before).some(call => call.path === 'addons/upload/' && call.method === 'POST'));
});

test('invalid upload UUIDs expose only bounded known keys, type and length diagnostics', async () => {
  for (const value of ['-'.repeat(36), 'g'.repeat(32), '1234567-12345-4234-a234-123456789012', null, 42, ['not-a-uuid']]) {
    const f = fixture();
    f.hooks.onRequest = ({ path, options, reply }) => path === 'addons/upload/' && options.method === 'POST' ? reply({ uuid: value, channel: 'listed', processed: false, url: `https://private.example/?token=${f.input.secret}`, [f.input.secret]: f.input.secret }) : null;
    let error; try { await f.run(); } catch (failure) { error = failure; }
    assert.equal(error.code, 'AMO_UPLOAD_INVALID'); assert.equal(error.receipt.addonId, null); assert.equal(error.receipt.versionId, null);
    assert.deepEqual(error.receipt.diagnostics.uploadResponseShape, { keys: ['uuid', 'channel', 'processed', 'url'], unrecognizedKeyCount: 1, uuidType: typeof value, uuidLength: typeof value === 'string' || Array.isArray(value) ? value.length : null });
    const text = JSON.stringify(error.receipt); assert(!text.includes(f.input.secret)); assert(!text.includes('private.example')); assert(!text.includes('not-a-uuid'));
    assert(!f.calls.some(call => call.path === 'addons/addon/' && call.method === 'POST'));
  }
});

test('existing addon uses multipart upload/source/license then JSON complex version metadata', async () => {
  const f = fixture({ existing: true }), result = await f.run();
  assert.equal(result.completed, true);
  const create = f.calls.find(call => call.path === 'addons/addon/101/versions/' && call.method === 'POST');
  assert(create.body instanceof FormData); assert.equal(create.body.get('compatibility'), null);
  assert(f.calls.some(call => call.path.endsWith('/202/') && call.method === 'PATCH' && typeof call.body === 'string' && JSON.parse(call.body).release_notes));
  assert(!f.calls.some(call => call.path === 'addons/addon/' && call.method === 'POST'));
});

test('validation errors and timeout never create an addon or version; warnings alone allow submission', async () => {
  for (const [property, code] of [['invalidUpload', 'AMO_VALIDATION_FAILED'], ['neverProcessed', 'AMO_VALIDATION_TIMEOUT']]) {
    const f = fixture(); f.hooks[property] = true;
    await assert.rejects(f.run(), { code });
    assert(!f.calls.some(call => call.method === 'POST' && !call.path.includes('/upload/')));
    assert.equal(f.receipts.at(-1).completed, false);
  }
});

test('same version is queried and metadata completed without upload or duplicate version creation', async () => {
  const f = fixture({ existing: true, listedVersion: true }), result = await f.run();
  assert.equal(result.result, 'existing-version'); assert.equal(result.completed, true);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert(f.calls.some(call => call.path.endsWith('/versions/v0.7.0/')));
  assert.equal(f.calls.filter(call => call.body instanceof FormData).length, 0);
});

test('source failure retains addon/version IDs and a matching receipt resumes without recreating', async () => {
  const f = fixture(); f.hooks.sourceFailure = true;
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_503'); assert.equal(error.receipt.result, 'partial'); assert.equal(error.receipt.addonId, 101); assert.equal(error.receipt.versionId, 202);
  f.version.file.hash = 'sha256:signed-bytes-have-a-different-hash';
  f.hooks.sourceFailure = false;
  const before = f.calls.length, result = await f.run({ previousReceipt: error.receipt });
  assert.equal(result.completed, true); assert.equal(f.calls.slice(before).filter(call => call.method === 'POST').length, 0);
});

test('policy failure records partial progress and retries only that version without source reupload', async () => {
  const f = fixture(); f.hooks.policyFailure = true;
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_400'); assert.equal(error.receipt.sourceUploaded, true); assert.equal(error.receipt.policyUpdated, false); assert.equal(error.receipt.completed, false);
  f.hooks.policyFailure = false; f.version.file.hash = 'sha256:mozilla-signature-changed-the-archive';
  const before = f.calls.length; await f.run({ previousReceipt: error.receipt });
  assert(!f.calls.slice(before).some(call => call.method === 'POST' || call.body instanceof FormData));
});

test('a lost create response is reconciled by exact addon/version GET rather than another POST', async () => {
  const f = fixture(); f.hooks.lostCreate = true;
  const result = await f.run(); assert.equal(result.completed, true);
  assert.equal(f.calls.filter(call => call.path === 'addons/addon/' && call.method === 'POST').length, 1);
});

test('an unresolved mutation receipt blocks blind resubmission when exact version is still absent', async () => {
  const f = fixture(), previousReceipt = { format: 'covelet-amo-submission', ...inspectAmoInputs(f.input.zip, f.input.source, f.input.metadata), mutationUncertain: true };
  let error; try { await f.run({ previousReceipt }); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_SUBMISSION_UNKNOWN'); assert.equal(error.receipt.mutationUncertain, true);
  await assert.rejects(f.run({ previousReceipt: error.receipt }), { code: 'AMO_SUBMISSION_UNKNOWN' });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('unrelated same-version archive cannot receive source without a bound recovery receipt', async () => {
  const f = fixture({ existing: true, listedVersion: true }); f.version.source = null; f.version.file.hash = 'sha256:different';
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_EXISTING_VERSION_UNVERIFIED');
  await assert.rejects(f.run({ previousReceipt: error.receipt }), { code: 'AMO_EXISTING_VERSION_UNVERIFIED' });
  assert(!f.calls.some(call => call.method === 'POST' || call.method === 'PATCH'));
});

test('an existing source archive never bypasses candidate binding or changes listing metadata', async () => {
  const f = fixture({ existing: true, listedVersion: true }); f.version.file.hash = 'sha256:another-candidate';
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_EXISTING_VERSION_UNVERIFIED'); assert.equal(error.receipt.completed, false); assert.equal(error.receipt.archiveBound, false);
  await assert.rejects(f.run({ previousReceipt: error.receipt }), { code: 'AMO_EXISTING_VERSION_UNVERIFIED' });
  assert(!f.calls.some(call => call.method !== 'GET'));
});

test('lost POST reconciliation still refuses an unbound same-version result with existing source', async () => {
  const f = fixture(); f.hooks.lostCreate = true;
  f.hooks.onRequest = () => {
    if (f.version) { f.version.source = 'https://addons.mozilla.org/source/other-candidate.zip'; f.version.file.hash = 'sha256:other-candidate'; }
    return null;
  };
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_EXISTING_VERSION_UNVERIFIED'); assert.equal(error.receipt.completed, false);
  const creates = f.calls.filter(call => call.path === 'addons/addon/' && call.method === 'POST'); assert.equal(creates.length, 1);
  assert(!f.calls.some(call => call.method === 'PATCH'));
  const before = f.calls.length;
  await assert.rejects(f.run({ previousReceipt: error.receipt }), { code: 'AMO_EXISTING_VERSION_UNVERIFIED' });
  assert(!f.calls.slice(before).some(call => call.method !== 'GET'));
});

test('source recovery binding survives a transient lookup failure and repeated process restarts', async () => {
  const f = fixture(); f.hooks.sourceFailure = true;
  let first; try { await f.run(); } catch (value) { first = value.receipt; }
  assert.equal(first.archiveBound, true); f.version.file.hash = 'sha256:signed-archive';
  f.hooks.onRequest = ({ reply }) => reply({}, 503);
  let interrupted; try { await f.run({ previousReceipt: first }); } catch (value) { interrupted = value.receipt; }
  assert.equal(interrupted.archiveBound, true); assert.equal(interrupted.addonId, 101); assert.equal(interrupted.versionId, 202);
  f.hooks.onRequest = null; f.hooks.sourceFailure = false;
  const before = f.calls.length, result = await f.run({ previousReceipt: interrupted });
  assert.equal(result.completed, true); assert(!f.calls.slice(before).some(call => call.method === 'POST'));
});

test('authorization failure is not mistaken for a missing addon, and raw service errors never escape', async () => {
  const f = fixture(); f.hooks.onRequest = ({ reply }) => reply({ detail: `JWT ${f.input.secret} private-response` }, 403);
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_403'); assert.equal(f.calls.length, 1);
  assert(!`${error.message}${JSON.stringify(error.receipt)}`.includes(f.input.secret));
});

test('unrecognized status text and private response URLs are excluded from receipts', async () => {
  const f = fixture({ existing: true, listedVersion: true });
  f.addon.status = f.input.secret; f.version.file.status = f.input.secret;
  f.addon.url += '?private=secret'; f.version.edit_url = 'https://elsewhere.example/private';
  const result = await f.run();
  assert.equal(result.addonStatus, 'unknown'); assert.equal(result.fileStatus, 'unknown'); assert.equal(result.versionEditUrl, null);
  assert(!JSON.stringify(result).includes(f.input.secret)); assert(!result.addonUrl.includes('?'));
});

test('overlarge streamed JSON responses stop safely without creating a submission', async () => {
  const f = fixture(); f.hooks.onRequest = () => new Response(' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(f.run(), { code: 'AMO_RESPONSE_INVALID' }); assert.equal(f.calls.length, 1);
});

test('HTTP metadata diagnostics report only fixed known field names without response values', async () => {
  const f = fixture();
  f.hooks.onRequest = ({ reply }) => reply({ summary: [f.input.secret], version: { license: ['invalid license'], release_notes: { 'en-US': ['https://private.example/source'] }, [f.input.secret]: ['hidden'] },
    [f.input.secret]: ['hidden'], unknown_field: 'do not echo', detail: `JWT ${f.input.secret}` }, 400);
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_400'); assert.deepEqual(error.receipt.diagnostics, { fields: ['summary', 'version.license', 'version.release_notes'], messages: [] });
  assert(!JSON.stringify(error.receipt).includes(f.input.secret)); assert(!JSON.stringify(error.receipt).includes('private.example'));
});

test('validator diagnostics retain only bounded message IDs and allowed severity', async () => {
  const f = fixture();
  f.hooks.onRequest = ({ path, reply }) => path === `addons/upload/${uploadId}/` ? reply({ uuid: uploadId, channel: 'listed', version: versionString, processed: true, valid: false,
    validation: { errors: 1, warnings: 1, messages: [
      { message_id: 'MANIFEST_INVALID_DATA_COLLECTION', type: 'error', message: f.input.secret, file: 'private.js', context: 'secret context' },
      { message_id: ['compatibility', 'optional_data_type'], type: 'warning', description: 'https://private.example' },
      { message_id: f.input.secret, type: 'error' }, { message_id: 'https://private.example', type: 'error' },
      { message_id: 'script.js', type: 'error' }, { message_id: 'VALID_IDENTIFIER', type: 'unexpected' },
    ] } }) : null;
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_VALIDATION_FAILED'); assert.deepEqual(error.receipt.diagnostics, { fields: [], messages: [
    { message_id: 'MANIFEST_INVALID_DATA_COLLECTION', type: 'error' }, { message_id: ['compatibility', 'optional_data_type'], type: 'warning' },
  ] });
  const text = JSON.stringify(error.receipt); for (const forbidden of [f.input.secret, 'private.js', 'secret context', 'private.example', 'script.js']) assert(!text.includes(forbidden));
});

test('malformed error JSON does not hide HTTP failure and diagnostic output has a fixed item cap', async () => {
  const broken = fixture(); broken.hooks.onRequest = () => new Response('not JSON', { status: 400 });
  await assert.rejects(broken.run(), { code: 'AMO_HTTP_400' });
  const f = fixture(); f.hooks.onRequest = ({ reply }) => reply({ messages: Array.from({ length: 40 }, (_, index) => ({ message_id: `KNOWN_MESSAGE_${index}`, type: 'error', message: f.input.secret })) }, 422);
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.receipt.diagnostics.messages.length, 20); assert(!JSON.stringify(error.receipt).includes(f.input.secret));
});

test('GUID, upload channel/version and remote version identity mismatches stop submission', async () => {
  const f = fixture({ existing: true }); f.addon.guid = 'somebody-else@example.test';
  await assert.rejects(f.run(), { code: 'AMO_ADDON_MISMATCH' }); assert.equal(f.calls.length, 1);
  for (const field of ['channel', 'version']) {
    const f = fixture(); f.hooks.onRequest = ({ path, reply }) => path === `addons/upload/${uploadId}/` ? reply({ uuid: uploadId, processed: true, valid: true, channel: field === 'channel' ? 'unlisted' : 'listed', version: field === 'version' ? '0.6.0' : versionString, validation: { errors: 0, warnings: 0 } }) : null;
    await assert.rejects(f.run(), { code: 'AMO_UPLOAD_MISMATCH' });
    assert(!f.calls.some(call => call.path === 'addons/addon/' && call.method === 'POST'));
  }
});

test('receipt persistence must succeed before any remote request', async () => {
  const f = fixture(); await assert.rejects(submitFirefoxAmo(f.input, { ...f.options, writeReceipt: async () => { throw new Error(f.input.secret); } }), { code: 'AMO_RECEIPT_WRITE_FAILED' }); assert.equal(f.calls.length, 0);
});

function throttled(body, retryAfter) {
  const response = new Response(body, { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });
  response.body.getReader = () => assert.fail('429 response bodies must never be read');
  return response;
}
function fakeTime(f) {
  let instant = 1700000000000; const waits = [];
  f.options.now = () => instant;
  f.options.sleep = async ms => { waits.push(ms); instant += ms; };
  return { waits, now: () => instant };
}

test('GET 429 honors Retry-After seconds and HTTP dates with a fresh JWT per attempt', async () => {
  for (const header of ['2', new Date(1700000005000).toUTCString()]) {
    const f = fixture(), clock = fakeTime(f); let limited = false;
    f.hooks.onRequest = () => { if (!limited) { limited = true; return throttled(f.input.secret, header); } return null; };
    const result = await f.run();
    assert.equal(result.completed, true); assert.equal(clock.waits[0], header === '2' ? 2000 : 5000);
    assert.notEqual(f.calls[0].headers.Authorization, f.calls[1].headers.Authorization);
    assert.equal(f.calls[0].path, f.calls[1].path); assert.equal(result.rateLimit.retries, 1); assert.equal(result.rateLimit.retryAt, null);
    assert(!JSON.stringify(f.receipts).includes(f.input.secret));
  }
});

test('POST 429 reuses the same FormData and JSON payload, without duplicate accepted creation', async () => {
  const f = fixture(), clock = fakeTime(f); let uploads = 0, creates = 0;
  f.hooks.onRequest = ({ path, options }) => {
    if (options.method === 'POST' && path === 'addons/upload/' && uploads++ === 0) return throttled(f.input.secret, '2');
    if (options.method === 'POST' && path === 'addons/addon/' && creates++ < 2) return throttled(f.input.secret);
    return null;
  };
  const result = await f.run(); assert.equal(result.completed, true);
  const uploadCalls = f.calls.filter(call => call.method === 'POST' && call.path === 'addons/upload/');
  assert.equal(uploadCalls.length, 2); assert.equal(uploadCalls[0].body, uploadCalls[1].body);
  const createCalls = f.calls.filter(call => call.method === 'POST' && call.path === 'addons/addon/');
  assert.equal(createCalls.length, 3); assert(createCalls.every(call => call.body === createCalls[0].body));
  assert.equal(new Set([...uploadCalls, ...createCalls].map(call => call.headers.Authorization)).size, 5);
  // One normal validation poll plus exponential rate-limit backoff shared by all requests.
  assert.deepEqual(clock.waits, [2000, 15000, 30000, 60000]); assert.equal(result.rateLimit.retries, 3);
});

test('429 retry count is capped at four and preserves safe retryAt without reading bodies', async () => {
  const f = fixture(), clock = fakeTime(f); f.hooks.onRequest = () => throttled(f.input.secret);
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_429'); assert.equal(f.calls.length, 5);
  assert.deepEqual(clock.waits, [15000, 30000, 60000, 120000]);
  assert.deepEqual(error.receipt.rateLimit, { retries: 4, waitedMs: 225000, retryAt: clock.now() + 120000, exhausted: true });
  assert.equal(error.receipt.failedStage, 'preflight'); assert(!JSON.stringify(error.receipt).includes(f.input.secret));
});

test('Retry-After beyond ten minutes stops without sleeping or creating anything', async () => {
  const f = fixture(), clock = fakeTime(f); f.hooks.onRequest = () => throttled(f.input.secret, '601');
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_429'); assert.equal(f.calls.length, 1); assert.deepEqual(clock.waits, []);
  assert.equal(error.receipt.rateLimit.retryAt, clock.now() + 601000); assert.equal(error.receipt.rateLimit.exhausted, true);
});

test('rate-limit waiting budget is shared across different API endpoints', async () => {
  const f = fixture(), clock = fakeTime(f); let readLimited = false;
  f.options.rateLimitBudgetMs = 3000;
  f.hooks.onRequest = ({ path, options }) => {
    if (options.method === 'GET' && !readLimited) { readLimited = true; return throttled(f.input.secret, '2'); }
    if (path === 'addons/upload/' && options.method === 'POST') return throttled(f.input.secret, '2');
    return null;
  };
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_429'); assert.deepEqual(clock.waits, [2000]);
  assert.equal(error.receipt.rateLimit.waitedMs, 2000); assert.equal(error.receipt.rateLimit.exhausted, true);
});

test('retained upload UUID survives poll throttling and resumes without another upload POST', async () => {
  const f = fixture(), clock = fakeTime(f); let limited = false;
  const previousReceipt = { format: 'covelet-amo-submission', ...inspectAmoInputs(f.input.zip, f.input.source, f.input.metadata), uploadUuid: uploadId };
  f.hooks.onRequest = ({ path }) => { if (path === `addons/upload/${uploadId}/` && !limited) { limited = true; return throttled(f.input.secret, '3'); } return null; };
  const result = await f.run({ previousReceipt }); assert.equal(result.completed, true); assert.equal(result.uploadUuid, uploadId);
  assert.deepEqual(clock.waits, [3000]); assert(!f.calls.some(call => call.path === 'addons/upload/' && call.method === 'POST'));
});

test('a 429-rejected create POST is retryable from the same upload rather than an unknown mutation', async () => {
  const f = fixture(); fakeTime(f); f.options.maxRateLimitRetries = 0;
  f.hooks.onRequest = ({ path, options }) => path === 'addons/addon/' && options.method === 'POST' ? throttled(f.input.secret, '30') : null;
  let error; try { await f.run(); } catch (value) { error = value; }
  assert.equal(error.code, 'AMO_HTTP_429'); assert.equal(error.receipt.mutationUncertain, false); assert.equal(error.receipt.uploadUuid, uploadId);
  assert.equal(error.receipt.failedStage, 'creating-version');
  f.hooks.onRequest = null;
  const before = f.calls.length, result = await f.run({ previousReceipt: error.receipt });
  assert.equal(result.completed, true); assert(!f.calls.slice(before).some(call => call.path === 'addons/upload/' && call.method === 'POST'));
});

test('missing, malformed, zero or past Retry-After uses nonzero default backoff', async () => {
  for (const header of [undefined, 'not-a-date-or-number', '0', 'Wed, 01 Jan 2020 00:00:00 GMT']) {
    const f = fixture(), clock = fakeTime(f); let limited = false;
    f.hooks.onRequest = () => { if (!limited) { limited = true; return throttled(f.input.secret, header); } return null; };
    await f.run(); assert.equal(clock.waits[0], 15000);
  }
});

test('default validation polling waits fifteen seconds and stops after forty polls', async () => {
  const f = fixture(), clock = fakeTime(f); delete f.options.maxPolls; f.hooks.neverProcessed = true;
  await assert.rejects(f.run(), { code: 'AMO_VALIDATION_TIMEOUT' });
  assert.equal(clock.waits.length, 40); assert(clock.waits.every(value => value === 15000));
  assert.equal(f.calls.filter(call => call.path === `addons/upload/${uploadId}/`).length, 40);
});

test('failure CLI summary exposes safe stage/IDs/validation/rate-limit state without raw payloads', async () => {
  const f = fixture(); fakeTime(f); f.options.maxRateLimitRetries = 0;
  f.hooks.onRequest = ({ path }) => path === `addons/upload/${uploadId}/` ? throttled(f.input.secret, '30') : null;
  let error; try { await f.run(); } catch (value) { error = value; }
  error.receipt.raw = { body: f.input.secret, url: 'https://private.example' };
  const summary = amoFailureSummary(error);
  assert.equal(summary.code, 'AMO_HTTP_429'); assert.equal(summary.stage, 'failed'); assert.equal(summary.failedStage, 'validating');
  assert.equal(summary.uploadUuid, uploadId); assert.equal(summary.addonId, null); assert.equal(summary.versionId, null);
  assert.equal(summary.validation.processed, false); assert.equal(summary.rateLimit.exhausted, true);
  const text = JSON.stringify(summary); assert(!text.includes(f.input.secret)); assert(!text.includes('private.example')); assert(!text.includes('raw'));
});
