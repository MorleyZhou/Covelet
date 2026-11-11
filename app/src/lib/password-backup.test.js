import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { PASSWORD_BACKUP_LIMITS as limits, validateBackupPassword, isEncryptedBackup, encryptCompleteBackup, decryptCompleteBackup } from './password-backup.js';

const password = '  Password-备份-🔑  ', plain = new Blob(['{"portable":"完整备份"}'], { type: 'application/json' });
function independentFixture(body = Buffer.from('{"independent":true}'), secret = password) {
  const header = Buffer.alloc(48); header.write('CVLTBAK\0', 0, 'ascii'); header[8] = 1; header[9] = 1;
  header.writeUInt32BE(600000, 12); header.writeUInt32BE(body.length, 16);
  for (let index = 20; index < 48; index++) header[index] = index;
  const key = pbkdf2Sync(secret, header.subarray(20, 36), 600000, 32, 'sha256'), cipher = createCipheriv('aes-256-gcm', key, header.subarray(36, 48));
  cipher.setAAD(header); const output = Buffer.concat([header, cipher.update(body), cipher.final(), cipher.getAuthTag()]); key.fill(0);
  return new Blob([output]);
}
test('v1 wire format uses the fixed profile, random salt/IV, authenticated header and nonextractable 256-bit keys', async (t) => {
  const actual = crypto.subtle.deriveKey.bind(crypto.subtle), keys = [];
  t.mock.method(crypto.subtle, 'deriveKey', async (...args) => { const key = await actual(...args); keys.push({ key, args }); return key; });
  const first = await encryptCompleteBackup(plain, password), second = await encryptCompleteBackup(plain, password);
  const bytes = Buffer.from(await first.arrayBuffer()), other = Buffer.from(await second.arrayBuffer());
  assert.equal(first.size, plain.size + 64); assert.equal(bytes.subarray(0, 8).toString('ascii'), 'CVLTBAK\0');
  assert.deepEqual([...bytes.subarray(8, 12)], [1, 1, 0, 0]); assert.equal(bytes.readUInt32BE(12), 600000); assert.equal(bytes.readUInt32BE(16), plain.size);
  assert.notDeepEqual(bytes.subarray(20, 36), other.subarray(20, 36)); assert.notDeepEqual(bytes.subarray(36, 48), other.subarray(36, 48));
  assert(keys.every(({ key, args }) => !key.extractable && key.algorithm.name === 'AES-GCM' && key.algorithm.length === 256 && args[0].hash === 'SHA-256' && args[0].iterations === 600000));
  const key = pbkdf2Sync(password, bytes.subarray(20, 36), 600000, 32, 'sha256'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(36, 48));
  decipher.setAAD(bytes.subarray(0, 48)); decipher.setAuthTag(bytes.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(bytes.subarray(48, -16)), decipher.final()]).toString(), await plain.text()); key.fill(0);
  assert.equal(await (await decryptCompleteBackup(first, password)).text(), await plain.text());
});
test('independently generated PBKDF2/AES-GCM v1 files decrypt without any device key or stored credentials', async () => {
  assert.equal(await (await decryptCompleteBackup(independentFixture(), password)).text(), '{"independent":true}');
  assert.equal(await isEncryptedBackup(independentFixture()), true);
  for (const file of [new Blob(), new Blob(['CVLTBAK']), new Blob(['{"format":"covelet-complete-backup"}']), null]) assert.equal(await isEncryptedBackup(file), false);
});
test('password rules reject invalid Unicode without trimming or normalizing exact accepted input', async () => {
  for (const value of [null, '', '1234567', 'x'.repeat(257), 'password\0', 'password\ud800', '\udc00password']) assert.throws(() => validateBackupPassword(value), { code: 'INVALID_BACKUP_PASSWORD' });
  for (const value of [' '.repeat(8), 'x'.repeat(256), password, 'e\u0301-Password', 'é-Password']) assert.doesNotThrow(() => validateBackupPassword(value));
  await assert.rejects(decryptCompleteBackup(independentFixture(), password.trim()), { code: 'BACKUP_DECRYPT_FAILED' });
  await assert.rejects(decryptCompleteBackup(independentFixture(Buffer.from('x'), 'e\u0301-Password'), 'é-Password'), { code: 'BACKUP_DECRYPT_FAILED' });
});
test('wrong password and authenticated body, salt or IV tampering never return plaintext', async () => {
  const file = independentFixture(), bytes = new Uint8Array(await file.arrayBuffer());
  await assert.rejects(decryptCompleteBackup(file, 'wrong-password'), { code: 'BACKUP_DECRYPT_FAILED' });
  for (const index of [20, 36, 48, bytes.length - 1]) { const corrupted = bytes.slice(); corrupted[index] ^= 1; await assert.rejects(decryptCompleteBackup(new Blob([corrupted]), password), { code: 'BACKUP_DECRYPT_FAILED' }); }
});
test('invalid or oversized headers are rejected before KDF or body allocation, with exact total size enforced', async (t) => {
  const bytes = new Uint8Array(await independentFixture().arrayBuffer()); let kdf = 0, bodyReads = 0;
  t.mock.method(crypto.subtle, 'deriveKey', async () => { kdf++; throw Error('KDF must not run'); });
  const cases = [];
  for (const index of [0, 8, 9, 10, 11, 12, 15, 16, 19]) { const copy = bytes.slice(); copy[index] ^= 1; cases.push(new Blob([copy])); }
  const huge = bytes.slice(); new DataView(huge.buffer).setUint32(16, limits.plaintext + 1); cases.push(new Blob([huge]));
  cases.push(new Blob([bytes.subarray(0, -1)]), new Blob([bytes, Uint8Array.of(0)]), new Blob([bytes.subarray(0, 47)]));
  class Oversized extends Blob { get size() { return limits.plaintext + limits.overhead + 1; } arrayBuffer() { bodyReads++; throw Error('Body must not be read'); } }
  cases.push(new Oversized());
  for (const file of cases) await assert.rejects(decryptCompleteBackup(file, password), { code: 'INVALID_ENCRYPTED_BACKUP' });
  await assert.rejects(encryptCompleteBackup(new Oversized(), password), { code: 'INVALID_ENCRYPTED_BACKUP' });
  await assert.rejects(encryptCompleteBackup(new Blob(), password), { code: 'INVALID_ENCRYPTED_BACKUP' });
  assert.equal(kdf, 0); assert.equal(bodyReads, 0);
});
test('a pre-aborted operation and cancellation after an awaited plaintext read do not reach KDF', async (t) => {
  const controller = new AbortController(); controller.abort(); let reads = 0, kdf = 0;
  t.mock.method(crypto.subtle, 'deriveKey', async () => { kdf++; throw Error('KDF must not run'); });
  await assert.rejects(encryptCompleteBackup(plain, password, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(decryptCompleteBackup(independentFixture(), password, { signal: controller.signal }), { name: 'AbortError' });
  const late = new AbortController(); let bytes;
  class CancelOnRead extends Blob { async arrayBuffer() { reads++; bytes = new Uint8Array(await super.arrayBuffer()); late.abort(); return bytes.buffer; } }
  await assert.rejects(encryptCompleteBackup(new CancelOnRead(['private backup']), password, { signal: late.signal }), { name: 'AbortError' });
  assert.equal(reads, 1); assert.equal(kdf, 0); assert(bytes.every(byte => byte === 0));
});
test('late native KDF and encryption completions are discarded after cancellation', async (t) => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle), encrypt = crypto.subtle.encrypt.bind(crypto.subtle), kdfAbort = new AbortController(); let encryptions = 0;
  t.mock.method(crypto.subtle, 'deriveKey', async (...args) => { const key = await derive(...args); kdfAbort.abort(); return key; });
  t.mock.method(crypto.subtle, 'encrypt', async (...args) => { encryptions++; return encrypt(...args); });
  await assert.rejects(encryptCompleteBackup(plain, password, { signal: kdfAbort.signal }), { name: 'AbortError' }); assert.equal(encryptions, 0);
  t.mock.restoreAll();
  const encryptionAbort = new AbortController(); let result;
  t.mock.method(crypto.subtle, 'encrypt', async (...args) => { result = new Uint8Array(await encrypt(...args)); encryptionAbort.abort(); return result.buffer; });
  await assert.rejects(encryptCompleteBackup(plain, password, { signal: encryptionAbort.signal }), { name: 'AbortError' }); assert(result.every(byte => byte === 0));
});
test('cancelling a late successful decryption discards and clears its plaintext', async (t) => {
  const controller = new AbortController(), decrypt = crypto.subtle.decrypt.bind(crypto.subtle); let plain;
  t.mock.method(crypto.subtle, 'decrypt', async (...args) => { plain = new Uint8Array(await decrypt(...args)); controller.abort(); return plain.buffer; });
  await assert.rejects(decryptCompleteBackup(independentFixture(), password, { signal: controller.signal }), { name: 'AbortError' });
  assert(plain.every(byte => byte === 0));
});
