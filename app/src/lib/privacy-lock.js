import { tr } from '../i18n/index.js';

const ITERATIONS = 210_000;
const encoder = new TextEncoder();
const fail = (message, code) => { throw Object.assign(Error(tr(message)), { code }); };
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export function validateNewPrivacyPassword(password) {
  if (typeof password !== 'string' || password.trim().length < 8 || password.length > 256) {
    fail('隐藏密码需要 8–256 个字符。', 'PRIVACY_PASSWORD_LENGTH');
  }
  return password;
}

export function validatePrivacyCredential(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'failedAttempts,iterations,kdf,retryAt,salt,verifier,version'
    || value.version !== 1 || value.kdf !== 'PBKDF2-SHA256' || value.iterations !== ITERATIONS
    || typeof value.salt !== 'string' || !/^[a-f0-9]{32}$/.test(value.salt)
    || typeof value.verifier !== 'string' || !/^[a-f0-9]{64}$/.test(value.verifier)
    || !Number.isSafeInteger(value.failedAttempts) || value.failedAttempts < 0 || value.failedAttempts > 4
    || !Number.isSafeInteger(value.retryAt) || value.retryAt < 0) {
    fail('隐藏密码记录无效，内容将保持隐藏。', 'PRIVACY_CREDENTIAL');
  }
  return { ...value };
}

async function derive(password, salt, crypto) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = Uint8Array.from(salt.match(/../g), (pair) => parseInt(pair, 16));
  const domain = encoder.encode('covelet-privacy-lock:v1:');
  const separatedSalt = new Uint8Array(domain.length + bytes.length);
  separatedSalt.set(domain); separatedSalt.set(bytes, domain.length);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: separatedSalt, iterations: ITERATIONS, hash: 'SHA-256' }, material, 256)));
}

export async function createPrivacyCredential(password, { crypto = globalThis.crypto } = {}) {
  validateNewPrivacyPassword(password);
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt,
    verifier: await derive(password, salt, crypto), failedAttempts: 0, retryAt: 0 };
}

// Attempts are persisted by the caller under the same lock as the visibility
// switch, so another tab or popup cannot reset the delay by reopening its UI.
export async function verifyPrivacyPassword(value, password, { crypto = globalThis.crypto, now = Date.now() } = {}) {
  if (value == null) fail('请先设置隐藏密码。', 'PRIVACY_SETUP_REQUIRED');
  const credential = validatePrivacyCredential(value);
  if (credential.retryAt > now) fail('尝试次数过多，请在 30 秒后重试。', 'PRIVACY_RETRY');
  let difference = 1;
  if (typeof password === 'string' && password.length > 0 && password.length <= 256) {
    const actual = await derive(password, credential.salt, crypto);
    difference = 0;
    for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ credential.verifier.charCodeAt(index);
  }
  const valid = difference === 0;
  const attempts = credential.failedAttempts + 1;
  return { valid, credential: { ...credential, failedAttempts: valid || attempts >= 5 ? 0 : attempts,
    retryAt: !valid && attempts >= 5 ? now + 30_000 : 0 } };
}
