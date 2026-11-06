import { tr, getLocale } from "../i18n/index.js";
// This format contains ciphertext only. Credentials, targets and configuration
// never appear in an unencrypted envelope. Cryptographic primitives are the
// browser's audited Web Crypto implementations, not an extension-side cipher.
export const CLOUD_PLAINTEXT_LIMIT = 512 * 1024;
export const CLOUD_OBJECT_LIMIT = 768 * 1024;
const ITERATIONS = 210_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const aad = encoder.encode('covelet-cloud:v1');
const fail = (message, code = 'CLOUD_CRYPTO') => { throw Object.assign(new Error(message), { code }); };

export function validateCloudPassword(password) {
  if (typeof password !== 'string' || password.trim().length < 12 || encoder.encode(password).length > 1024) fail(tr("同步密码至少需要 12 个字符，且不能超过 1024 字节。"), 'CLOUD_PASSWORD');
  return password;
}

function encode64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

function decode64(text, min, max) {
  if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail(tr("云端加密文档格式无效。"));
  const binary = atob(text);
  if (binary.length < min || binary.length > max) fail(tr("云端加密文档大小无效。"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encode64(bytes) !== text) fail(tr("云端加密文档编码无效。"));
  return bytes;
}

async function derive(password, salt, crypto) {
  validateCloudPassword(password);
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptCloudPayload(bytes, password, { crypto = globalThis.crypto } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CLOUD_PLAINTEXT_LIMIT) fail(tr("同步文档超过加密大小限制。"), 'CLOUD_CAPACITY');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, crypto);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, bytes));
  const result = encoder.encode(JSON.stringify({ format: 'covelet-cloud', version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
    salt: encode64(salt), iv: encode64(iv), ciphertext: encode64(ciphertext) }));
  if (result.length > CLOUD_OBJECT_LIMIT) fail(tr("加密同步文档超过大小限制。"), 'CLOUD_CAPACITY');
  return result;
}

export async function decryptCloudPayload(bytes, password, { crypto = globalThis.crypto } = {}) {
  validateCloudPassword(password);
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CLOUD_OBJECT_LIMIT) fail(tr("云端同步对象过大或无效。"), 'CLOUD_CAPACITY');
  let envelope;
  try { envelope = JSON.parse(decoder.decode(bytes)); } catch { fail(tr("云端加密文档无法解析。")); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'ciphertext,format,iterations,iv,kdf,salt,version'
    || envelope.format !== 'covelet-cloud' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== ITERATIONS) fail(tr("不支持的云端加密格式。"));
  const salt = decode64(envelope.salt, 16, 16);
  const iv = decode64(envelope.iv, 12, 12);
  const ciphertext = decode64(envelope.ciphertext, 17, CLOUD_PLAINTEXT_LIMIT + 16);
  try {
    const key = await derive(password, salt, crypto);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext));
  } catch {
    fail(tr('无法解密云端数据。请确认使用了原来的同步密码。'), 'CLOUD_DECRYPT');
  }
}
