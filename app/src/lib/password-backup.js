import { tr } from '../i18n/index.js';

// Profile 1 is immutable: changing its cost or algorithms requires a new
// profile. Untrusted headers never select arbitrary expensive KDF parameters.
export const PASSWORD_BACKUP_LIMITS = Object.freeze({ plaintext: 50 * 1024 * 1024, header: 48, tag: 16, overhead: 64, iterations: 600000 });
const MAGIC = Uint8Array.of(67, 86, 76, 84, 66, 65, 75, 0); // CVLTBAK\0
const fail = (message, code) => { throw Object.assign(Error(tr(message)), { code }); };
const invalid = () => fail('加密备份格式无效或超过 50 MiB。', 'INVALID_ENCRYPTED_BACKUP');
export function throwIfBackupCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Backup operation cancelled.', 'AbortError');
}
export function validateBackupPassword(password) {
  let valid = typeof password === 'string' && password.length >= 8 && password.length <= 256 && !password.includes('\0');
  if (valid) for (let index = 0; index < password.length; index++) {
    const value = password.charCodeAt(index);
    if (value >= 0xd800 && value <= 0xdbff) {
      const following = password.charCodeAt(++index);
      if (!(following >= 0xdc00 && following <= 0xdfff)) { valid = false; break; }
    } else if (value >= 0xdc00 && value <= 0xdfff) { valid = false; break; }
  }
  if (!valid) fail('密码须为 8–256 个字符，且不能包含无效字符。', 'INVALID_BACKUP_PASSWORD');
}
function cryptoAPI() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) fail('当前浏览器不支持备份加密。', 'BACKUP_CRYPTO_UNAVAILABLE');
  return globalThis.crypto;
}
const hasMagic = (bytes) => bytes.length >= MAGIC.length && MAGIC.every((byte, index) => bytes[index] === byte);
export async function isEncryptedBackup(file) {
  if (!(file instanceof Blob) || file.size < MAGIC.length) return false;
  return hasMagic(new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer()));
}
function checkedHeader(bytes, size) {
  if (bytes.length !== PASSWORD_BACKUP_LIMITS.header || !hasMagic(bytes)) invalid();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = data.getUint32(16);
  if (bytes[8] !== 1 || bytes[9] !== 1 || data.getUint16(10) !== 0 || data.getUint32(12) !== PASSWORD_BACKUP_LIMITS.iterations
    || length < 1 || length > PASSWORD_BACKUP_LIMITS.plaintext || size !== length + PASSWORD_BACKUP_LIMITS.overhead) invalid();
  return length;
}
async function deriveKey(passwordBytes, header, signal, operation) {
  const api = cryptoAPI(); let material;
  try {
    throwIfBackupCancelled(signal);
    material = await api.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    throwIfBackupCancelled(signal);
    const key = await api.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: PASSWORD_BACKUP_LIMITS.iterations, salt: header.subarray(20, 36) }, material, { name: 'AES-GCM', length: 256 }, false, [operation]);
    throwIfBackupCancelled(signal);
    return key;
  } finally { material = null; }
}
const parameters = (header) => ({ name: 'AES-GCM', iv: header.subarray(36, 48), additionalData: header, tagLength: 128 });

export async function encryptCompleteBackup(blob, password, { signal } = {}) {
  throwIfBackupCancelled(signal); validateBackupPassword(password);
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > PASSWORD_BACKUP_LIMITS.plaintext) invalid();
  const api = cryptoAPI(), header = new Uint8Array(PASSWORD_BACKUP_LIMITS.header), data = new DataView(header.buffer);
  header.set(MAGIC); header[8] = 1; header[9] = 1;
  data.setUint32(12, PASSWORD_BACKUP_LIMITS.iterations); data.setUint32(16, blob.size);
  api.getRandomValues(header.subarray(20, 36)); api.getRandomValues(header.subarray(36, 48));
  let plain, cipher, passwordBytes, key;
  try {
    passwordBytes = new TextEncoder().encode(password);
    throwIfBackupCancelled(signal); plain = new Uint8Array(await blob.arrayBuffer()); throwIfBackupCancelled(signal);
    if (plain.length !== blob.size) invalid();
    key = await deriveKey(passwordBytes, header, signal, 'encrypt'); throwIfBackupCancelled(signal);
    cipher = new Uint8Array(await api.subtle.encrypt(parameters(header), key, plain)); throwIfBackupCancelled(signal);
    return new Blob([header, cipher], { type: 'application/octet-stream' });
  } finally {
    // Best effort only: JavaScript strings, browser-internal copies and CryptoKey
    // handles cannot be guaranteed to be synchronously zeroized.
    plain?.fill(0); cipher?.fill(0); passwordBytes?.fill(0); key = null; password = '';
  }
}

export async function decryptCompleteBackup(file, password, { signal } = {}) {
  throwIfBackupCancelled(signal); validateBackupPassword(password);
  if (!(file instanceof Blob) || file.size < PASSWORD_BACKUP_LIMITS.overhead + 1 || file.size > PASSWORD_BACKUP_LIMITS.plaintext + PASSWORD_BACKUP_LIMITS.overhead) invalid();
  let header, cipher, plain, passwordBytes, key;
  try {
    throwIfBackupCancelled(signal); header = new Uint8Array(await file.slice(0, PASSWORD_BACKUP_LIMITS.header).arrayBuffer()); throwIfBackupCancelled(signal);
    const length = checkedHeader(header, file.size), api = cryptoAPI();
    // Only a structurally valid, bounded profile reaches KDF or body allocation.
    passwordBytes = new TextEncoder().encode(password);
    key = await deriveKey(passwordBytes, header, signal, 'decrypt'); throwIfBackupCancelled(signal);
    cipher = new Uint8Array(await file.slice(PASSWORD_BACKUP_LIMITS.header).arrayBuffer()); throwIfBackupCancelled(signal);
    if (cipher.length !== length + PASSWORD_BACKUP_LIMITS.tag) invalid();
    try { plain = new Uint8Array(await api.subtle.decrypt(parameters(header), key, cipher)); }
    catch { throwIfBackupCancelled(signal); fail('密码不正确，或加密备份已损坏。', 'BACKUP_DECRYPT_FAILED'); }
    throwIfBackupCancelled(signal);
    if (plain.length !== length) invalid();
    return new Blob([plain], { type: 'application/json' });
  } finally { header?.fill(0); cipher?.fill(0); plain?.fill(0); passwordBytes?.fill(0); key = null; password = ''; }
}
