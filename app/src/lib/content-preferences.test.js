import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { changePrivacyPassword, getPrivacyLockStatus, loadContentPreferences, replaceContentPreferences,
  saveContentSettings, setPresentationMode, validateContentPreferences } from './content-preferences.js';
import { CONTENT_LIBRARY_LIMITS, createContentTag, renameContentTag, deleteContentTag, saveContentMetadata,
  getContentMetadata, getContentTags, mergeContentPreferences, withNavigationPrivacy } from './content-preferences.js';
import { localData } from './local-data.js';

const KEY = 'covelet.content.preferences.v1', LOCK = 'covelet.privacy.lock.v1';
const PASSWORD = 'synthetic-test-password';
let records, rejectWrite, tail;
beforeEach((t) => {
  records = {}; rejectWrite = false; tail = Promise.resolve();
  t.mock.method(localData, 'get', async (requested) => {
    const keys = requested == null ? Object.keys(records) : Array.isArray(requested) ? requested : [requested];
    return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(records, key)).map((key) => [key, records[key]])));
  });
  t.mock.method(localData, 'set', async (patch) => {
    if (rejectWrite) throw Error('synthetic storage failure');
    Object.assign(records, structuredClone(patch));
  });
  t.mock.method(localData, 'remove', async (requested) => {
    if (rejectWrite) throw Error('synthetic storage failure');
    for (const key of Array.isArray(requested) ? requested : [requested]) delete records[key];
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request(_name, run) { const next = tail.then(run); tail = next.catch(() => {}); return next; },
  } } });
});

test('first activation requires password setup and all exits require authentication', async () => {
  assert.deepEqual(await getPrivacyLockStatus(), { configured: false });
  await assert.rejects(setPresentationMode(true), { code: 'PRIVACY_SETUP_REQUIRED' });
  assert.deepEqual(records, {});
  await assert.rejects(setPresentationMode(true, { setup: true, password: 'short' }), { code: 'PRIVACY_PASSWORD_LENGTH' });
  await saveContentSettings('site:private-a', { alias: 'private alias', private: true });
  await setPresentationMode(true, { setup: true, password: PASSWORD });
  for (const password of [undefined, '', 'wrong-password']) {
    await assert.rejects(setPresentationMode(false, { password }), { code: 'PRIVACY_PASSWORD' });
    assert.equal((await loadContentPreferences()).presentation, true);
  }
  await assert.rejects(saveContentSettings('site:private-a', { private: false }), { code: 'PRIVACY_LOCKED' });
  const before = await loadContentPreferences();
  await replaceContentPreferences({ ...before, presentation: false, privateKeys: [] }, { expectedRevision: before.revision });
  assert.equal(records[KEY].presentation, true);
  assert.deepEqual(records[KEY].privateKeys, ['site:private-a']);
  await setPresentationMode(false, { password: PASSWORD });
  assert.equal((await loadContentPreferences()).presentation, false);
  await setPresentationMode(true); assert.equal(records[KEY].presentation, true);
  assert.deepEqual(records[KEY].privateKeys, ['site:private-a']);
});

test('concurrent first-time setup cannot overwrite another page’s password', async () => {
  const results = await Promise.allSettled([
    setPresentationMode(true, { setup: true, password: PASSWORD }),
    setPresentationMode(true, { setup: true, password: 'different-test-password' }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'PRIVACY_CONFIGURED');
  await assert.rejects(setPresentationMode(false, { password: 'different-test-password' }), { code: 'PRIVACY_PASSWORD' });
  await setPresentationMode(false, { password: PASSWORD });
  assert.equal(records[KEY].presentation, false);
});

test('storage failures, missing or malformed verifier keep the current hidden state', async () => {
  rejectWrite = true;
  await assert.rejects(setPresentationMode(true, { setup: true, password: PASSWORD }), /storage failure/);
  assert.deepEqual(records, {});
  rejectWrite = false; await setPresentationMode(true, { setup: true, password: PASSWORD });
  rejectWrite = true;
  await assert.rejects(setPresentationMode(false, { password: PASSWORD }), /storage failure/);
  assert.equal(records[KEY].presentation, true);
  rejectWrite = false; records[LOCK] = null;
  await assert.rejects(setPresentationMode(false, { password: PASSWORD }), { code: 'PRIVACY_CREDENTIAL' });
  assert.equal(records[KEY].presentation, true);
  delete records[LOCK];
  await assert.rejects(setPresentationMode(false), { code: 'PRIVACY_SETUP_REQUIRED' });
  // Upgrade an already-hidden installation without revealing its contents.
  await setPresentationMode(true, { setup: true, password: PASSWORD });
  assert.equal(records[KEY].presentation, true);
  await setPresentationMode(false, { password: PASSWORD });
  assert.equal(records[KEY].presentation, false);
});

test('changing a password requires the current one and backups cannot replace it', async () => {
  await setPresentationMode(true, { setup: true, password: PASSWORD });
  await assert.rejects(changePrivacyPassword('wrong-password', 'replacement-password'), { code: 'PRIVACY_PASSWORD' });
  await changePrivacyPassword(PASSWORD, 'replacement-password');
  assert.equal(records[KEY].presentation, true);
  await setPresentationMode(false, { password: 'replacement-password' });
  const before = await loadContentPreferences(), savedCredential = structuredClone(records[LOCK]);
  await replaceContentPreferences({ ...before, presentation: true, privateKeys: ['site:restored'] }, { expectedRevision: before.revision });
  assert.equal(records[KEY].presentation, false); assert.deepEqual(records[LOCK], savedCredential);
  assert.equal(JSON.stringify(await loadContentPreferences()).includes('verifier'), false);
  assert.throws(() => validateContentPreferences({ ...before, verifier: records[LOCK].verifier }));
  await changePrivacyPassword('replacement-password', 'final-password');
  await setPresentationMode(true);
  await assert.rejects(setPresentationMode(false, { password: 'replacement-password' }), { code: 'PRIVACY_PASSWORD' });
  await setPresentationMode(false, { password: 'final-password' });
  assert.equal(records[KEY].presentation, false);
});

test('hiding permits public preference edits and restores without removing protected markings', async () => {
  await saveContentSettings('site:private-a', { private: true });
  await setPresentationMode(true, { setup: true, password: PASSWORD });
  await saveContentSettings('site:public-a', { alias: 'public alias' });
  assert.equal(records[KEY].aliases['site:public-a'], 'public alias');
  await saveContentSettings('note:another-private', { private: true });
  await assert.rejects(saveContentSettings('site:private-a', { alias: 'changed private alias' }), { code: 'PRIVACY_LOCKED' });
  const before = await loadContentPreferences(), credential = structuredClone(records[LOCK]);
  await replaceContentPreferences({ ...before, presentation: false, aliases: { 'site:public-a': 'restored alias' }, privateKeys: ['reading:restored-private'] }, { expectedRevision: before.revision });
  assert.equal(records[KEY].presentation, true);
  assert.equal(records[KEY].aliases['site:public-a'], 'restored alias');
  assert.deepEqual(records[KEY].privateKeys, ['site:private-a', 'note:another-private', 'reading:restored-private']);
  assert.deepEqual(records[LOCK], credential);
});

test('retry state survives reopening controls and coordinates across calls', async () => {
  await setPresentationMode(true, { setup: true, password: PASSWORD });
  for (let attempt = 0; attempt < 5; attempt++) {
    await getPrivacyLockStatus();
    await assert.rejects(setPresentationMode(false, { password: 'wrong-password' }), { code: 'PRIVACY_PASSWORD' });
  }
  assert.equal(records[KEY].presentation, true); assert(records[LOCK].retryAt > Date.now());
  await assert.rejects(setPresentationMode(false, { password: PASSWORD }), { code: 'PRIVACY_RETRY' });
  assert.equal(records[KEY].presentation, true);
});

test('legacy preferences stay unchanged and metadata validation rejects malformed or unbounded libraries', () => {
  const legacy = validateContentPreferences(null);
  assert.equal(Object.hasOwn(legacy, 'library'), false);
  assert.deepEqual(getContentMetadata(legacy, 'site:a'), { description: '', tagIds: [] });
  const library = { version: 1, tags: [{ id: 'tag-a', name: 'Work' }], items: { 'site:a': { description: 'why saved', tagIds: ['tag-a'] } } };
  assert.deepEqual(validateContentPreferences({ ...legacy, library }).library, library);
  for (const invalid of [
    { ...library, version: 2 }, { ...library, secret: 'unexpected' }, { ...library, items: [] },
    { ...library, tags: [...library.tags, { id: 'tag-b', name: ' work ' }] },
    { ...library, items: { 'folder:a': { description: '', tagIds: [] } } },
    { ...library, items: { 'site:a': { description: '', tagIds: ['tag-missing'] } } },
    { ...library, items: { 'site:a': { description: '', tagIds: ['tag-a', 'tag-a'] } } },
    { ...library, items: { 'site:a': { description: 'a'.repeat(CONTENT_LIBRARY_LIMITS.description + 1), tagIds: [] } } },
  ]) assert.throws(() => validateContentPreferences({ ...legacy, library: invalid }));
});

test('tag CRUD preserves stable references and atomic settings edits keep aliases, privacy and metadata together', async () => {
  const tag = await createContentTag(' Work ');
  const initial = await loadContentPreferences();
  const saved = await saveContentSettings('site:a', { alias: 'shortcut', private: true, description: 'Saved for deployment', tagIds: [tag.id] }, { expectedRevision: initial.revision });
  assert.equal(saved.aliases['site:a'], 'shortcut'); assert.deepEqual(saved.privateKeys, ['site:a']);
  assert.deepEqual(getContentMetadata(saved, 'site:a'), { description: 'Saved for deployment', tagIds: [tag.id] });
  await assert.rejects(createContentTag('work'), /同名/);
  await renameContentTag(tag.id, 'Project');
  assert.deepEqual(getContentTags(await loadContentPreferences()), [{ id: tag.id, name: 'Project' }]);
  assert.deepEqual(getContentMetadata(await loadContentPreferences(), 'site:a').tagIds, [tag.id]);
  await deleteContentTag(tag.id);
  assert.deepEqual(getContentMetadata(await loadContentPreferences(), 'site:a'), { description: 'Saved for deployment', tagIds: [] });
});

test('metadata CAS and item baselines survive unrelated tag creation and storage failures', async () => {
  await saveContentMetadata('reading:a', { description: 'original', tagIds: [] });
  const observed = await loadContentPreferences(), baseline = getContentMetadata(observed, 'reading:a');
  const results = await Promise.allSettled([
    saveContentMetadata('reading:a', { description: 'first' }, { expectedRevision: observed.revision }),
    saveContentMetadata('reading:a', { description: 'second' }, { expectedRevision: observed.revision }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  await createContentTag('new tag');
  const latest = await loadContentPreferences();
  await assert.rejects(saveContentMetadata('reading:a', { description: 'stale' }, { expectedRevision: latest.revision, expectedMetadata: baseline }), { code: 'REVISION_CONFLICT' });
  const before = structuredClone(records); rejectWrite = true;
  await assert.rejects(saveContentMetadata('reading:a', { description: 'failed' }), /storage failure/);
  assert.deepEqual(records, before);
});

test('hidden metadata and hidden-only tags stay unavailable and hidden folder children cannot be edited', async () => {
  const publicTag = await createContentTag('public tag'), privateTag = await createContentTag('private tag');
  await saveContentMetadata('site:public', { description: 'public', tagIds: [publicTag.id] });
  await saveContentMetadata('site:private', { description: 'secret', tagIds: [privateTag.id] });
  await saveContentSettings('folder:private-folder', { private: true });
  records['owntab.local.v1'] = { state: { entries: [{ id: 'private', parentId: 'private-folder' }] } };
  await setPresentationMode(true, { setup: true, password: PASSWORD });
  const hiddenKeys = new Set(['site:private']), preferences = await loadContentPreferences();
  assert.deepEqual(getContentMetadata(preferences, 'site:private', { hiddenKeys }), { description: '', tagIds: [] });
  assert.deepEqual(getContentTags(preferences, { hiddenKeys }), [publicTag]);
  await assert.rejects(saveContentMetadata('site:private', { description: 'changed' }), { code: 'PRIVACY_LOCKED' });
  await assert.rejects(renameContentTag(privateTag.id, 'renamed'), { code: 'PRIVACY_LOCKED' });
  await saveContentMetadata('site:public', { description: 'changed public' });
  assert.equal(getContentMetadata(await loadContentPreferences(), 'site:public').description, 'changed public');
});

test('getters apply direct hidden markings by default and an inherited set only while locked', () => {
  const preferences = validateContentPreferences({ version: 1, revision: 1, aliases: {}, privateKeys: ['note:private'], presentation: true,
    library: { version: 1, tags: [{ id: 'tag-private', name: 'Private' }, { id: 'tag-folder', name: 'Folder private' }], items: {
      'note:private': { description: 'secret note', tagIds: ['tag-private'] }, 'site:child': { description: 'secret child', tagIds: ['tag-folder'] },
    } } });
  assert.deepEqual(getContentMetadata(preferences, 'note:private'), { description: '', tagIds: [] });
  assert.deepEqual(getContentTags(preferences), [{ id: 'tag-folder', name: 'Folder private' }]);
  assert.deepEqual(getContentTags(preferences, { hiddenKeys: new Set(['site:child']) }), []);
  assert.deepEqual(getContentTags({ ...preferences, presentation: false }, { hiddenKeys: new Set(['site:child']) }), preferences.library.tags);
  assert.equal(getContentMetadata({ ...preferences, presentation: false }, 'note:private').description, 'secret note');
});

test('navigation metadata copies and privacy markings are prepared as one write without changing the source', async () => {
  const tag = await createContentTag('source tag');
  await saveContentMetadata('reading:source', { description: 'why saved', tagIds: [tag.id] });
  await saveContentSettings('reading:source', { private: true });
  const before = await loadContentPreferences();
  await withNavigationPrivacy(async (_current, prepare) => {
    const patch = prepare(['site:copy'], { copies: [{ from: 'reading:source', to: 'site:copy' }], expectedRevision: before.revision });
    assert.equal(Object.keys(patch).length, 1); assert.deepEqual(records[KEY], before);
    await localData.set(patch);
  });
  const after = await loadContentPreferences();
  assert.deepEqual(getContentMetadata(after, 'site:copy'), getContentMetadata(before, 'reading:source'));
  assert.deepEqual(after.privateKeys, ['reading:source', 'site:copy']);
});

test('appending preferences remaps same-name tag identities and retains existing record metadata', () => {
  const empty = validateContentPreferences(null);
  const current = { ...empty, library: { version: 1, tags: [{ id: 'tag-current', name: 'Work' }], items: { 'site:shared': { description: 'keep', tagIds: ['tag-current'] } } } };
  const incoming = { ...empty, library: { version: 1, tags: [{ id: 'tag-incoming', name: 'work' }], items: {
    'site:shared': { description: 'old', tagIds: ['tag-incoming'] }, 'note:fresh': { description: '', tagIds: ['tag-incoming'] },
  } } };
  const merged = mergeContentPreferences(current, incoming);
  assert.deepEqual(merged.library.tags, current.library.tags);
  assert.deepEqual(getContentMetadata(merged, 'site:shared'), getContentMetadata(current, 'site:shared'));
  assert.deepEqual(getContentMetadata(merged, 'note:fresh').tagIds, ['tag-current']);
});
