import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { createAmoJwt, inspectAmoInputs, submitFirefoxAmo, runAmoCli } from '../../scripts/submit-firefox-amo.mjs';

const guid = 'covelet@morleyzhou.github.io', versionString = '0.7.0', uploadId = '12345678-1234-1234-1234-123456789012';
const metadata = { addon: { name: { 'en-US': 'Covelet' }, summary: { 'en-US': 'Private new tab' }, default_locale: 'en-US', categories: { firefox: ['tabs', 'bookmarks'] }, support_url: { 'en-US': 'https://github.com/MorleyZhou/Covelet/issues' } },
  version: { license: 'MIT', compatibility: ['firefox'], release_notes: { 'en-US': 'Record merge and Firefox.' }, approval_notes: 'Build instructions in source.' }, policy: { privacy_policy: { 'en-US': 'Local data. No account, telemetry, ads or server.' } } };
function inputs() {
  return { zip: zipSync({ 'manifest.json': strToU8(JSON.stringify({ version: versionString, browser_specific_settings: { gecko: { id: guid } } })) }),
    source: zipSync({ 'app/package.json': strToU8('{"version":"0.7.0"}'), 'README.md': strToU8('Reproducible source') }), metadata: structuredClone(metadata), issuer: 'user:123:45', secret: 'fixture-secret-never-print' };
}
function fixture({ existing = false, listedVersion = false } = {}) {
  const input = inputs(), calls = [], receipts = [];
  let addon = existing ? addonValue() : null, ver = listedVersion ? versionValue(true) : null;
  const hooks = { onRequest: null, lostCreate: false, sourceFailure: false, policyFailure: false, invalidUpload: false, neverProcessed: false };
  function addonValue() { return { id: 101, guid, status: 'nominated', url: 'https://addons.mozilla.org/en-US/firefox/addon/covelet/' }; }
  function versionValue(hasSource) { return { id: 202, version: versionString, channel: 'listed', source: hasSource ? 'https://addons.mozilla.org/private-source/?private=not-for-receipts' : null,
    is_source_editable: true, edit_url: 'https://addons.mozilla.org/en-US/developers/addon/covelet/versions/202', file: { status: 'unreviewed', hash: `sha256:${inspectAmoInputs(input.zip, input.source, input.metadata).zipSha256}` } }; }
  function upload(processed = true) { return { uuid: uploadId, processed, valid: !hooks.invalidUpload, submitted: false, version: versionString, channel: 'listed', validation: { errors: hooks.invalidUpload ? 1 : 0, warnings: 2, messages: [{ type: 'warning', message: input.secret }] } }; }
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  async function fetch(url, options) {
    const path = new URL(url).pathname.replace('/api/v5/', ''), method = options.method;
    calls.push({ path, ...options });
    assert.equal(new URL(url).origin, 'https://addons.mozilla.org'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.match(options.headers.Authorization, /^JWT [A-Za-z0-9_.-]+$/u);
    if (hooks.onRequest) { const intercepted = await hooks.onRequest({ path, options, reply }); if (intercepted) return intercepted; }
    if (path === 'addons/upload/' && method === 'POST') return reply(upload(false), 201);
    if (path === `addons/upload/${uploadId}/`) return reply(upload(!hooks.neverProcessed));
    if (path === 'addons/addon/' && method === 'POST') {
      const body = JSON.parse(options.body); assert.equal(body.version.upload, uploadId); assert.equal(body.version.source, undefined);
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
      assert(options.body instanceof FormData); assert.equal(options.body.get('upload'), uploadId); assert.equal(options.body.get('license'), 'MIT');
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
