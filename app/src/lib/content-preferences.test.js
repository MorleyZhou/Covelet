import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { changePrivacyPassword, getPrivacyLockStatus, loadContentPreferences, replaceContentPreferences,
  saveContentSettings, setPresentationMode, validateContentPreferences } from './content-preferences.js';
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
