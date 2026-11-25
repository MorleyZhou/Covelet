/** AMO v5: https://mozilla.github.io/addons-server/topics/api/{auth,addons}.html */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

const API = 'https://addons.mozilla.org/api/v5/';
const MAX_ARCHIVE = 200 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const id = value => Number.isSafeInteger(value) && value > 0;
// AMO FileUploadSerializer uses UUIDField(format='hex'), i.e. 32 hex digits.
// Also accept the canonical UUID spelling used by older clients/receipts.
const uuid = value => typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/iu.test(value);
const segment = value => encodeURIComponent(String(value));
const safeStatus = value => ['public', 'deleted', 'disabled', 'rejected', 'nominated', 'incomplete', 'unreviewed'].includes(value) ? value : 'unknown';
function publicUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'addons.mozilla.org' && !url.username && !url.password ? `${url.origin}${url.pathname}` : null; }
  catch { return null; }
}

export function createAmoJwt(issuer, secret, { now = Date.now, nonce = randomUUID } = {}) {
  if (typeof issuer !== 'string' || !issuer.trim() || typeof secret !== 'string' || !secret.trim()) fail('AMO_CREDENTIALS_REQUIRED');
  const iat = Math.floor(now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, jti: nonce(), iat, exp: iat + 60 })}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function checkFields(value, names) {
  if (!object(value) || Object.keys(value).some(key => !names.includes(key))) fail('AMO_METADATA_INVALID');
}
function translation(value, required = false) {
  if (!object(value) || !Object.keys(value).length || Object.entries(value).some(([locale, text]) => !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale) || typeof text !== 'string' || !text.trim() || text.length > 100000)) fail('AMO_METADATA_INVALID');
  if (required && !value['en-US']) fail('AMO_METADATA_INVALID');
}
export function inspectAmoInputs(zip, source, metadata) {
  if (!(zip instanceof Uint8Array) || !(source instanceof Uint8Array) || !zip.length || !source.length || zip.length > MAX_ARCHIVE || source.length > MAX_ARCHIVE) fail('AMO_ARCHIVE_INVALID');
  let manifest;
  try {
    const files = unzipSync(zip, { filter: entry => entry.name === 'manifest.json' && entry.originalSize <= MAX_JSON });
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['manifest.json']));
    // Validate the source container without inflating its contents.
    let sourceEntries = 0;
    unzipSync(source, { filter: () => { sourceEntries++; return false; } });
    if (!sourceEntries) fail('AMO_ARCHIVE_INVALID');
  } catch { fail('AMO_ARCHIVE_INVALID'); }
  const guid = manifest?.browser_specific_settings?.gecko?.id;
  if (typeof guid !== 'string' || !/^[A-Za-z0-9@{}._+-]{3,255}$/u.test(guid) || !/^\d+\.\d+\.\d+$/u.test(manifest.version || '')) fail('AMO_MANIFEST_INVALID');
  checkFields(metadata, ['addon', 'version', 'policy']);
  checkFields(metadata.addon, ['name', 'summary', 'categories', 'default_locale', 'description', 'homepage', 'support_email', 'support_url', 'developer_comments', 'requires_payment', 'slug', 'tags']);
  checkFields(metadata.version, ['license', 'compatibility', 'release_notes', 'approval_notes']);
  translation(metadata.addon.name, true); translation(metadata.addon.summary, true);
  for (const key of ['description', 'homepage', 'support_email', 'support_url', 'developer_comments']) if (metadata.addon[key] !== undefined) translation(metadata.addon[key]);
  if (typeof metadata.addon.default_locale !== 'string' || !metadata.addon.name[metadata.addon.default_locale] || !metadata.addon.summary[metadata.addon.default_locale]) fail('AMO_METADATA_INVALID');
  const categories = metadata.addon.categories;
  if (!object(categories) || Object.keys(categories).some(key => key !== 'firefox') || !Array.isArray(categories.firefox) || !categories.firefox.length || categories.firefox.some(value => typeof value !== 'string' || !/^[a-z-]+$/u.test(value))) fail('AMO_METADATA_INVALID');
  if (typeof metadata.version.license !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/u.test(metadata.version.license)) fail('AMO_METADATA_INVALID');
  if (metadata.version.compatibility !== undefined && (!Array.isArray(metadata.version.compatibility) || metadata.version.compatibility.length !== 1 || metadata.version.compatibility[0] !== 'firefox')) fail('AMO_METADATA_INVALID');
  if (metadata.version.release_notes !== undefined) translation(metadata.version.release_notes);
  if (metadata.version.approval_notes !== undefined && (typeof metadata.version.approval_notes !== 'string' || metadata.version.approval_notes.length > 100000)) fail('AMO_METADATA_INVALID');
  if (metadata.policy !== undefined) { checkFields(metadata.policy, ['privacy_policy']); translation(metadata.policy.privacy_policy); }
  return { guid, requestedVersion: manifest.version, zipSha256: hash(zip), sourceSha256: hash(source), metadataSha256: hash(JSON.stringify(metadata)) };
}

function multipart(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Uint8Array) form.append(key, new Blob([value], { type: 'application/zip' }), key === 'source' ? 'covelet-source.zip' : 'covelet-firefox.zip');
    else form.append(key, value);
  }
  return form;
}
function validation(value) {
  const details = value?.validation;
  const count = (key, type) => Number.isSafeInteger(details?.[key]) && details[key] >= 0 ? details[key] : Array.isArray(details?.messages) ? details.messages.filter(message => message?.type === type).length : 0;
  return { processed: value?.processed === true, valid: value?.valid === true, errors: count('errors', 'error'), warnings: count('warnings', 'warning') };
}
const diagnosticFields = new Set([
  'upload', 'channel', 'source', 'name', 'summary', 'categories', 'default_locale', 'description', 'homepage',
  'support_email', 'support_url', 'developer_comments', 'requires_payment', 'slug', 'tags',
  'license', 'compatibility', 'release_notes', 'approval_notes', 'privacy_policy', 'non_field_errors',
  ...['upload', 'source', 'license', 'compatibility', 'release_notes', 'approval_notes', 'non_field_errors'].map(key => `version.${key}`),
]);
function safeDiagnostics(value, secrets) {
  const fields = new Set(), messages = [], seen = new Set();
  const walk = (node, path = '', depth = 0) => {
    if (!object(node) || depth > 3) return;
    for (const key of Object.keys(node)) {
      const field = path ? `${path}.${key}` : key;
      if (diagnosticFields.has(field) && fields.size < 20) fields.add(field);
      if (field === 'version') walk(node[key], field, depth + 1);
    }
  };
  walk(value);
  const identifier = part => typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u.test(part) && !secrets.some(secret => part.includes(secret));
  for (const entry of [...(Array.isArray(value?.validation?.messages) ? value.validation.messages : []), ...(Array.isArray(value?.messages) ? value.messages : [])]) {
    if (messages.length >= 20) break;
    const type = entry?.type, code = entry?.message_id;
    if (!['error', 'warning', 'notice'].includes(type) || !(identifier(code) || Array.isArray(code) && code.length > 0 && code.length <= 6 && code.every(identifier))) continue;
    const item = { message_id: code, type }, identity = JSON.stringify(item);
    if (!seen.has(identity)) { seen.add(identity); messages.push(item); }
  }
  return { fields: [...fields], messages };
}
function uploadResponseShape(value) {
  const knownKeys = ['uuid', 'channel', 'manifest_data', 'processed', 'submitted', 'url', 'valid', 'validation', 'version'];
  const keys = object(value) ? Object.keys(value) : [];
  return { keys: keys.filter(key => knownKeys.includes(key)), unrecognizedKeyCount: keys.filter(key => !knownKeys.includes(key)).length,
    uuidType: typeof value?.uuid, uuidLength: typeof value?.uuid === 'string' || Array.isArray(value?.uuid) ? value.uuid.length : null };
}
async function responseJson(response) {
  if (Number(response.headers?.get('content-length')) > MAX_JSON) fail('AMO_RESPONSE_INVALID');
  let bodyText;
  try {
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_JSON) { await reader.cancel(); fail('AMO_RESPONSE_INVALID'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    bodyText = Buffer.concat(chunks).toString('utf8');
  } catch { fail('AMO_RESPONSE_INVALID'); }
  try { const result = JSON.parse(bodyText); if (!object(result)) fail('AMO_RESPONSE_INVALID'); return result; }
  catch { fail('AMO_RESPONSE_INVALID'); }
}

/** All network and receipt boundaries are injectable; importing this file never submits. */
export async function submitFirefoxAmo({ zip, source, metadata, issuer, secret, addonId, previousReceipt = null }, {
  fetch: fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)),
  writeReceipt = async () => {}, pollInterval = 3000, maxPolls = 100,
} = {}) {
  createAmoJwt(issuer, secret, { now }); // Fail before reading or calling any remote endpoint.
  const identity = inspectAmoInputs(zip, source, metadata);
  if (addonId !== undefined && (typeof addonId !== 'string' || !/^[A-Za-z0-9@{}._+-]{1,255}$/u.test(addonId))) fail('AMO_ADDON_ID_INVALID');
  const priorMatches = object(previousReceipt) && previousReceipt.format === 'covelet-amo-submission' && Object.entries(identity).every(([key, value]) => previousReceipt[key] === value);
  const receipt = { format: 'covelet-amo-submission', version: 1, channel: 'listed', ...identity,
    startedAt: priorMatches && Number.isFinite(previousReceipt.startedAt) ? previousReceipt.startedAt : now(), updatedAt: now(),
    stage: 'preflight', result: 'pending', completed: false, publication: 'not-confirmed',
    addonId: priorMatches && id(previousReceipt.addonId) ? previousReceipt.addonId : null,
    versionId: priorMatches && id(previousReceipt.versionId) ? previousReceipt.versionId : null,
    uploadUuid: priorMatches && uuid(previousReceipt.uploadUuid) ? previousReceipt.uploadUuid : null,
    mutationUncertain: priorMatches && previousReceipt.mutationUncertain === true,
    archiveBound: priorMatches && previousReceipt.archiveBound === true,
    sourceUploaded: false, addonMetadataUpdated: false, versionMetadataUpdated: false, policyUpdated: metadata.policy === undefined,
  };
  let mutationUncertain = priorMatches && previousReceipt.mutationUncertain === true;
  let knownCreated = false;
  function diagnose(value) {
    const next = safeDiagnostics(value, [issuer, secret]);
    if (!next.fields.length && !next.messages.length) return;
    const before = receipt.diagnostics || { fields: [], messages: [] };
    receipt.diagnostics = { fields: [...new Set([...before.fields, ...next.fields])].slice(0, 20),
      messages: [...new Map([...before.messages, ...next.messages].map(item => [JSON.stringify(item), item])).values()].slice(0, 20) };
  }
  async function save(stage) {
    receipt.stage = stage; receipt.updatedAt = now();
    try { await writeReceipt(structuredClone(receipt)); } catch { fail('AMO_RECEIPT_WRITE_FAILED'); }
  }
  async function request(path, { method = 'GET', body, missing = false } = {}) {
    const headers = { Authorization: `JWT ${createAmoJwt(issuer, secret, { now })}`, Accept: 'application/json' };
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    let response;
    try { response = await fetchImpl(`${API}${path}`, { method, headers, body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120000) }); }
    catch { fail('AMO_NETWORK_ERROR'); }
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      if ([400, 409, 422].includes(response.status)) {
        try { diagnose(await responseJson(response)); } catch { /* Diagnostics never replace the HTTP failure. */ }
      }
      fail(`AMO_HTTP_${Number.isInteger(response.status) ? response.status : 'ERROR'}`);
    }
    if (response.status === 204) return null;
    return responseJson(response);
  }
  function acceptAddon(value) {
    if (!id(value?.id) || value.guid !== identity.guid) fail('AMO_ADDON_MISMATCH');
    receipt.addonId = value.id;
    receipt.addonUrl = publicUrl(value.url);
    receipt.addonStatus = safeStatus(value.status);
    return value;
  }
  function acceptVersion(value) {
    if (!id(value?.id) || value.version !== identity.requestedVersion || value.channel !== 'listed') fail('AMO_VERSION_MISMATCH');
    receipt.versionId = value.id; receipt.versionEditUrl = publicUrl(value.edit_url);
    receipt.fileStatus = safeStatus(value.file?.status);
    receipt.sourceUploaded = typeof value.source === 'string' && value.source.length > 0;
    return value;
  }
  const addonPath = () => `addons/addon/${segment(receipt.addonId || addonId || identity.guid)}/`;
  const versionPath = () => `${addonPath()}versions/${receipt.versionId || segment(`v${identity.requestedVersion}`)}/`;
  async function findExisting() {
    const addon = await request(addonPath(), { missing: true });
    if (!addon) return { addon: null, version: null };
    acceptAddon(addon);
    const version = await request(versionPath(), { missing: true });
    return { addon, version: version ? acceptVersion(version) : null };
  }
  try {
    await save('preflight');
    let { addon, version } = await findExisting();
    const existed = !!version;
    if (!version && mutationUncertain) fail('AMO_SUBMISSION_UNKNOWN');
    if (!version) {
      let upload;
      if (priorMatches && uuid(previousReceipt.uploadUuid)) upload = await request(`addons/upload/${segment(previousReceipt.uploadUuid)}/`);
      else upload = await request('addons/upload/', { method: 'POST', body: multipart({ upload: zip, channel: 'listed' }) });
      if (!uuid(upload?.uuid)) {
        receipt.diagnostics = { ...(receipt.diagnostics || { fields: [], messages: [] }), uploadResponseShape: uploadResponseShape(upload) };
        fail('AMO_UPLOAD_INVALID');
      }
      receipt.uploadUuid = upload.uuid;
      await save('validating');
      for (let attempt = 0; ; attempt++) {
        receipt.validation = validation(upload);
        if (receipt.validation.processed) break;
        if (attempt >= maxPolls) fail('AMO_VALIDATION_TIMEOUT');
        await sleep(pollInterval);
        upload = await request(`addons/upload/${segment(receipt.uploadUuid)}/`);
      }
      diagnose({ validation: upload.validation });
      if (upload.channel !== 'listed' || upload.version !== identity.requestedVersion) fail('AMO_UPLOAD_MISMATCH');
      if (!receipt.validation.valid || receipt.validation.errors) fail('AMO_VALIDATION_FAILED');
      if (upload.submitted === true) fail('AMO_SUBMISSION_UNKNOWN');
      await save('validated');
      if (addon) {
        await request(addonPath(), { method: 'PATCH', body: metadata.addon });
        receipt.addonMetadataUpdated = true;
      }
      receipt.mutationUncertain = true;
      mutationUncertain = true;
      await save('creating-version'); // Durable before a possibly ambiguous POST.
      try {
        if (!addon) {
          addon = acceptAddon(await request('addons/addon/', { method: 'POST', body: { ...metadata.addon, version: { upload: receipt.uploadUuid, ...metadata.version } } }));
          receipt.addonMetadataUpdated = true;
          version = acceptVersion(addon.version);
        } else {
          version = acceptVersion(await request(`${addonPath()}versions/`, { method: 'POST', body: multipart({ upload: receipt.uploadUuid, source, license: metadata.version.license }) }));
        }
        knownCreated = true;
      } catch (error) {
        // A lost response can mean the POST committed. Query instead of repeating it.
        let found;
        try { found = await findExisting(); } catch { throw error; }
        if (!found.version) throw error;
        addon = found.addon; version = found.version;
      }
      receipt.archiveBound = knownCreated || version.file?.hash === `sha256:${identity.zipSha256}`;
      receipt.mutationUncertain = false;
      await save('version-created');
    } else {
      receipt.uploadUuid = priorMatches && uuid(previousReceipt.uploadUuid) ? previousReceipt.uploadUuid : null;
    }
    // Existing signed files may have different hashes. Only attach missing source to
    // a known creation, matching local receipt, or identical unsigned archive.
    const boundReceipt = priorMatches && previousReceipt.archiveBound === true && previousReceipt.addonId === receipt.addonId && previousReceipt.versionId === receipt.versionId;
    const matchingArchive = version.file?.hash === `sha256:${identity.zipSha256}`;
    // A same-version lookup is not proof that this candidate was submitted.
    // Require the binding even when AMO already has a source archive, before
    // changing any listing/version/policy metadata or reporting completion.
    if (!knownCreated && !boundReceipt && !matchingArchive) fail('AMO_EXISTING_VERSION_UNVERIFIED');
    receipt.archiveBound = true;
    if (!receipt.sourceUploaded) {
      if (version.is_source_editable === false) fail('AMO_SOURCE_NOT_EDITABLE');
      await save('uploading-source');
      version = acceptVersion(await request(versionPath(), { method: 'PATCH', body: multipart({ source }) }));
      if (!receipt.sourceUploaded) fail('AMO_SOURCE_NOT_CONFIRMED');
    }
    if (!receipt.addonMetadataUpdated) { await request(addonPath(), { method: 'PATCH', body: metadata.addon }); receipt.addonMetadataUpdated = true; }
    await save('updating-version-metadata');
    await request(versionPath(), { method: 'PATCH', body: metadata.version }); receipt.versionMetadataUpdated = true;
    if (metadata.policy !== undefined) {
      await save('updating-policy');
      await request(`${addonPath()}eula_policy/`, { method: 'PATCH', body: metadata.policy }); receipt.policyUpdated = true;
    }
    version = acceptVersion(await request(versionPath()));
    addon = acceptAddon(await request(addonPath()));
    if (!receipt.sourceUploaded) fail('AMO_SOURCE_NOT_CONFIRMED');
    receipt.result = existed ? 'existing-version' : 'submitted'; receipt.completed = true;
    // Even an approved file does not prove the public listing/version is live.
    receipt.publication = 'not-confirmed'; delete receipt.mutationUncertain;
    await save('complete');
    return structuredClone(receipt);
  } catch (error) {
    const code = /^AMO_[A-Z0-9_]+$/u.test(error?.code || '') ? error.code : 'AMO_UNEXPECTED_ERROR';
    receipt.result = receipt.versionId || receipt.mutationUncertain ? 'partial' : 'failed'; receipt.completed = false; receipt.error = { code };
    try { await save('failed'); } catch { receipt.error = { code: 'AMO_RECEIPT_WRITE_FAILED' }; }
    const safe = new Error(receipt.error.code); safe.code = receipt.error.code; safe.receipt = structuredClone(receipt); throw safe;
  }
}

async function readBounded(file, maximum) {
  const details = await stat(file);
  if (!details.isFile() || details.size < 1 || details.size > maximum) fail('AMO_INPUT_FILE_INVALID');
  return new Uint8Array(await readFile(file));
}
export async function runAmoCli(args = process.argv.slice(2), env = process.env) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--zip', '--source', '--metadata', '--receipt', '--addon-id'].includes(key) || !args[index + 1] || flags[key]) fail('AMO_ARGUMENTS_INVALID');
    flags[key] = args[index + 1];
  }
  if (['--zip', '--source', '--metadata', '--receipt'].some(key => !flags[key])) fail('AMO_ARGUMENTS_REQUIRED');
  createAmoJwt(env.AMO_JWT_ISSUER, env.AMO_JWT_SECRET);
  const receiptFile = resolve(flags['--receipt']);
  if (['--zip', '--source', '--metadata'].some(key => resolve(flags[key]) === receiptFile)) fail('AMO_RECEIPT_PATH_INVALID');
  const [zip, source, metadataBytes] = await Promise.all([readBounded(flags['--zip'], MAX_ARCHIVE), readBounded(flags['--source'], MAX_ARCHIVE), readBounded(flags['--metadata'], MAX_JSON)]);
  let metadata, previousReceipt = null;
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)); } catch { fail('AMO_METADATA_INVALID'); }
  try { previousReceipt = JSON.parse(await readFile(receiptFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') fail('AMO_RECEIPT_INVALID'); }
  return submitFirefoxAmo({ zip, source, metadata, issuer: env.AMO_JWT_ISSUER, secret: env.AMO_JWT_SECRET, addonId: flags['--addon-id'], previousReceipt }, {
    writeReceipt: async value => {
      await mkdir(dirname(receiptFile), { recursive: true });
      const temporary = `${receiptFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, receiptFile);
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAmoCli().then(receipt => console.log(JSON.stringify({ result: receipt.result, addonId: receipt.addonId, versionId: receipt.versionId, fileStatus: receipt.fileStatus, completed: receipt.completed, publication: receipt.publication })))
    .catch(error => {
      const code = /^AMO_[A-Z0-9_]+$/u.test(error?.code || '') ? error.code : 'AMO_SUBMISSION_FAILED';
      console.error(JSON.stringify({ code, ...(error.receipt?.diagnostics && { diagnostics: error.receipt.diagnostics }) })); process.exitCode = 1;
    });
}
