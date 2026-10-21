import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptCloudPayload, decryptCloudPayload, validateCloudPassword, CLOUD_PLAINTEXT_LIMIT } from './cloud-crypto.js';

const encode = (value) => new TextEncoder().encode(value);
const password = 'a private test passphrase';

test('cloud envelopes use authenticated AES-256-GCM, independent salt/IV and no plaintext configuration', async () => {
  const plain = encode(JSON.stringify({ title: '私人的网站', token: 'not a real credential' }));
  const first = await encryptCloudPayload(plain, password);
  const second = await encryptCloudPayload(plain, password);
  assert.notDeepEqual(first, second, 'each new revision has a fresh salt and IV');
  assert.deepEqual(await decryptCloudPayload(first, password), plain);
  const envelope = JSON.parse(new TextDecoder().decode(first));
  assert.equal(envelope.iterations, 210000);
  assert.equal(envelope.kdf, 'PBKDF2-SHA256');
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'format', 'iterations', 'iv', 'kdf', 'salt', 'version']);
  assert.equal(new TextDecoder().decode(first).includes('私人的网站'), false);
  assert.equal(new TextDecoder().decode(first).includes('not a real credential'), false);
});

test('wrong passwords and authenticated-ciphertext tampering fail without returning partial plaintext', async () => {
  const encrypted = await encryptCloudPayload(encode('private configuration'), password);
  await assert.rejects(decryptCloudPayload(encrypted, 'another wrong passphrase'), { code: 'CLOUD_DECRYPT' });
  const envelope = JSON.parse(new TextDecoder().decode(encrypted));
  const data = Buffer.from(envelope.ciphertext, 'base64'); data[0] ^= 1;
  envelope.ciphertext = data.toString('base64');
  await assert.rejects(decryptCloudPayload(encode(JSON.stringify(envelope)), password), { code: 'CLOUD_DECRYPT' });
});

test('encrypted input validates fixed KDF cost, bounded encodings and strict schema before key derivation', async () => {
  const encrypted = await encryptCloudPayload(encode('configuration'), password);
  for (const patch of [{ iterations: 1 }, { version: 2 }, { iv: 'AAAA' }, { salt: '' }, { target: 'https://example.com' }, { ciphertext: '!!!!' }]) {
    const envelope = { ...JSON.parse(new TextDecoder().decode(encrypted)), ...patch };
    await assert.rejects(decryptCloudPayload(encode(JSON.stringify(envelope)), password), { code: 'CLOUD_CRYPTO' });
  }
  await assert.rejects(encryptCloudPayload(new Uint8Array(CLOUD_PLAINTEXT_LIMIT + 1), password), { code: 'CLOUD_CAPACITY' });
  for (const value of ['', 'short', ' '.repeat(20), null, '密'.repeat(400)]) assert.throws(() => validateCloudPassword(value), { code: 'CLOUD_PASSWORD' });
  assert.equal(validateCloudPassword('十二个字的安全口令只是一个测试用例'), '十二个字的安全口令只是一个测试用例');
});
