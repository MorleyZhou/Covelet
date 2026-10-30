import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivacyCredential, validatePrivacyCredential, verifyPrivacyPassword } from './privacy-lock.js';

const PASSWORD = 'synthetic-test-password';
test('privacy verifier is salted, bounded and excludes the original password', async () => {
  const first = await createPrivacyCredential(PASSWORD), second = await createPrivacyCredential(PASSWORD);
  assert.notEqual(first.salt, second.salt); assert.notEqual(first.verifier, second.verifier);
  assert.equal(JSON.stringify(first).includes(PASSWORD), false);
  assert.equal((await verifyPrivacyPassword(first, PASSWORD)).valid, true);
  for (const value of ['', '       ', 'short', 'a'.repeat(257)]) await assert.rejects(createPrivacyCredential(value), { code: 'PRIVACY_PASSWORD_LENGTH' });
  for (const value of [null, {}, { ...first, password: PASSWORD }, { ...first, salt: 'zz' }, { ...first, iterations: 1 }, { ...first, retryAt: -1 }]) {
    assert.throws(() => validatePrivacyCredential(value), { code: 'PRIVACY_CREDENTIAL' });
  }
});

test('failed attempts create a persisted retry delay and successful verification clears them', async () => {
  let credential = await createPrivacyCredential(PASSWORD);
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await verifyPrivacyPassword(credential, attempt === 0 ? undefined : 'wrong-password', { now: 1000 });
    assert.equal(result.valid, false); credential = result.credential;
  }
  assert.equal(credential.retryAt, 31_000);
  await assert.rejects(verifyPrivacyPassword(credential, PASSWORD, { now: 2000 }), { code: 'PRIVACY_RETRY' });
  const success = await verifyPrivacyPassword(credential, PASSWORD, { now: 31_000 });
  assert.equal(success.valid, true); assert.equal(success.credential.failedAttempts, 0); assert.equal(success.credential.retryAt, 0);
});
