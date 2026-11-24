import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { prepareScheduledBackupKey, encryptScheduledBackup, decryptCompleteBackup, encryptCompleteBackup, PASSWORD_BACKUP_LIMITS } from './password-backup.js';

const password = 'Scheduled-备份-🔑', payload = new Blob(['{"portable":"完整内容","hidden":true}'], { type: 'application/json' });

test('scheduled files use the existing portable profile with retained salt, fresh IVs and an encryption-only native key', async (t) => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle), derivations = [];
  t.mock.method(crypto.subtle, 'deriveKey', async (...args) => { derivations.push(args); return derive(...args); });
  const material = await prepareScheduledBackupKey(password), cloned = structuredClone(material);
  assert.equal(material.key.type, 'secret'); assert.equal(material.key.extractable, false);
  assert.deepEqual(material.key.algorithm, { name: 'AES-GCM', length: 256 }); assert.deepEqual(material.key.usages, ['encrypt']);
  assert.equal(material.salt.length, 16); assert.ok(material.key instanceof CryptoKey);
  await assert.rejects(crypto.subtle.exportKey('raw', material.key));
  const first = await encryptScheduledBackup(payload, material), second = await encryptScheduledBackup(payload, cloned);
  assert.equal(derivations.length, 1, 'scheduled file writes never derive again or retain the raw password');
  assert.deepEqual(derivations[0][0].hash, 'SHA-256'); assert.equal(derivations[0][0].iterations, 600000);
  const a = Buffer.from(await first.arrayBuffer()), b = Buffer.from(await second.arrayBuffer());
  assert.equal(a.subarray(0, 8).toString('ascii'), 'CVLTBAK\0'); assert.deepEqual([...a.subarray(8, 12)], [1, 1, 0, 0]);
  assert.equal(a.readUInt32BE(12), 600000); assert.equal(a.readUInt32BE(16), payload.size);
  assert.deepEqual(a.subarray(20, 36), Buffer.from(material.salt)); assert.deepEqual(a.subarray(20, 36), b.subarray(20, 36));
  assert.notDeepEqual(a.subarray(36, 48), b.subarray(36, 48)); assert.notDeepEqual(a.subarray(48), b.subarray(48));
  assert.equal(first.size, payload.size + PASSWORD_BACKUP_LIMITS.overhead);
  for (const file of [first, second]) assert.equal(await (await decryptCompleteBackup(file, password)).text(), await payload.text());
  const independent = pbkdf2Sync(password, a.subarray(20, 36), 600000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', independent, a.subarray(36, 48));
  decipher.setAAD(a.subarray(0, 48)); decipher.setAuthTag(a.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(a.subarray(48, -16)), decipher.final()]).toString(), await payload.text()); independent.fill(0);
});

test('ordinary password backups still get independent random salts while each configured schedule derives its own key', async () => {
  const first = await prepareScheduledBackupKey(password), second = await prepareScheduledBackupKey(password);
  assert.notDeepEqual(first.salt, second.salt);
  const a = new Uint8Array(await (await encryptCompleteBackup(payload, password)).arrayBuffer());
  const b = new Uint8Array(await (await encryptCompleteBackup(payload, password)).arrayBuffer());
  assert.notDeepEqual(a.slice(20, 36), b.slice(20, 36));
  assert.notDeepEqual(first.salt, a.slice(20, 36));
});

test('retained key/salt validation rejects unsafe or foreign capabilities before reading plaintext', async () => {
  const prepared = await prepareScheduledBackupKey(password);
  const unsafe = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const decrypting = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const short = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt']);
  const foreign = await crypto.subtle.generateKey({ name: 'AES-CBC', length: 256 }, false, ['encrypt']);
  let reads = 0;
  class Probe extends Blob { async arrayBuffer() { reads++; return super.arrayBuffer(); } }
  for (const key of [null, {}, { type: 'secret', extractable: false, algorithm: { name: 'AES-GCM', length: 256 }, usages: ['encrypt'] }, unsafe, decrypting, short, foreign])
    await assert.rejects(encryptScheduledBackup(new Probe(['private']), { key, salt: prepared.salt }), { code: 'INVALID_SCHEDULED_BACKUP_KEY' });
  for (const salt of [null, [], new ArrayBuffer(16), new Uint8Array(15), new Uint8Array(17)])
    await assert.rejects(encryptScheduledBackup(new Probe(['private']), { key: prepared.key, salt }), { code: 'INVALID_SCHEDULED_BACKUP_KEY' });
  assert.equal(reads, 0);
});

test('scheduled encryption rejects size violations and discards cancelled reads and native encryptions', async (t) => {
  const material = await prepareScheduledBackupKey(password); let reads = 0;
  class Oversized extends Blob { get size() { return PASSWORD_BACKUP_LIMITS.plaintext + 1; } arrayBuffer() { reads++; throw Error('must not read'); } }
  await assert.rejects(encryptScheduledBackup(new Oversized(), material), { code: 'INVALID_ENCRYPTED_BACKUP' });
  await assert.rejects(encryptScheduledBackup(new Blob(), material), { code: 'INVALID_ENCRYPTED_BACKUP' });
  assert.equal(reads, 0);
  const before = new AbortController(); before.abort();
  await assert.rejects(prepareScheduledBackupKey(password, { signal: before.signal }), { name: 'AbortError' });
  await assert.rejects(encryptScheduledBackup(payload, material, { signal: before.signal }), { name: 'AbortError' });
  const reading = new AbortController(); let plain;
  class Cancelled extends Blob { async arrayBuffer() { plain = new Uint8Array(await super.arrayBuffer()); reading.abort(); return plain.buffer; } }
  await assert.rejects(encryptScheduledBackup(new Cancelled(['private']), material, { signal: reading.signal }), { name: 'AbortError' });
  assert.ok(plain.every((byte) => byte === 0));
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle), encrypting = new AbortController(); let cipher;
  t.mock.method(crypto.subtle, 'encrypt', async (...args) => { cipher = new Uint8Array(await encrypt(...args)); encrypting.abort(); return cipher.buffer; });
  await assert.rejects(encryptScheduledBackup(payload, material, { signal: encrypting.signal }), { name: 'AbortError' });
  assert.ok(cipher.every((byte) => byte === 0));
});

test('scheduled encryption snapshots its supplied salt and exact passwords remain required for restoration', async () => {
  const material = await prepareScheduledBackupKey(password), savedSalt = material.salt.slice();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  class Delayed extends Blob { async arrayBuffer() { await gate; return super.arrayBuffer(); } }
  const work = encryptScheduledBackup(new Delayed(['private']), material); material.salt.fill(0); release();
  const file = await work, bytes = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual(bytes.slice(20, 36), savedSalt);
  assert.equal(await (await decryptCompleteBackup(file, password)).text(), 'private');
  await assert.rejects(decryptCompleteBackup(file, 'wrong-password'), { code: 'BACKUP_DECRYPT_FAILED' });
});
